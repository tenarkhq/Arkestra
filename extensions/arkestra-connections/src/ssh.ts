/*---------------------------------------------------------------------------------------------
 *  Arkestra. Running agent CLIs on another machine over the system OpenSSH client.
 *
 *  The remote side gets one `sh -lc` script: it reads a first stdin line with the
 *  environment to set or unset (base64, so keys never appear in a process list),
 *  changes to the project folder and execs the CLI. Everything after that first line
 *  on stdin, and all of stdout/stderr, belongs to the CLI, so stdio protocols such
 *  as `codex app-server` work unchanged.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface Machine {
	/** Stable id: letters, digits, hyphens. `local` is the machine Arkestra runs on. */
	readonly id: string;
	readonly name: string;
	/** An OpenSSH destination: a ~/.ssh/config alias or user@host. */
	readonly host: string;
	readonly port?: number;
	/** Project folder on the machine; `~/…` is the remote home. Empty: the remote home. */
	readonly folder?: string;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Environment variables an agent may set or clear; anything else stays the remote's own. */
export const FORWARDED_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME'] as const;

/** Agent CLIs the probe looks for. */
export const KNOWN_CLIS = ['claude', 'codex', 'gemini', '2ark'] as const;

/** POSIX single-quote quoting. */
export function shQuote(value: string): string {
	return /^[A-Za-z0-9_\-.,/:=@%+]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A path for the remote shell: `~` and `~/…` expand to $HOME, the rest is quoted. */
export function remotePath(value: string): string {
	if (value === '~') {
		return '"$HOME"';
	}
	return value.startsWith('~/') ? `"$HOME"/${shQuote(value.slice(2))}` : shQuote(value);
}

/** The first stdin line: shell lines that set or unset the forwarded variables, base64. */
export function envLine(env: NodeJS.ProcessEnv | undefined): string {
	const lines = FORWARDED_ENV.map(name => {
		const value = env?.[name];
		if (value === undefined) {
			return `unset ${name}`;
		}
		if (name === 'CODEX_HOME') {
			// A separate Codex home for API-key mode lives on the remote machine.
			return `export CODEX_HOME=${remotePath(value)}; mkdir -p "$CODEX_HOME"`;
		}
		return `export ${name}=${shQuote(value)}`;
	});
	return Buffer.from(lines.join('\n'), 'utf8').toString('base64') + '\n';
}

/**
 * The remote script around one CLI invocation. Without a TTY the remote process would
 * outlive a dropped connection, so a CLI that does not read stdin runs in the background
 * while the script reads stdin: EOF (the connection closed, a turn was cancelled) stops it.
 * A CLI that reads stdin itself sees that EOF directly.
 */
export function remoteScript(command: string, args: readonly string[], folder: string | undefined, stopOnHangup = false): string {
	const cli = [command, ...args].map(shQuote).join(' ');
	return [
		'IFS= read -r ARKESTRA_ENV || exit 97',
		'eval "$(printf %s "$ARKESTRA_ENV" | base64 -d)" || exit 97',
		`cd ${folder ? remotePath(folder) : '"$HOME"'} || exit 98`,
		...(stopOnHangup ? [
			// sh gives background jobs /dev/null as stdin, so the watcher reads a saved copy.
			'exec 3<&0',
			`${cli} </dev/null 3<&- &`,
			'pid=$!',
			'{ cat <&3 >/dev/null 2>&1; kill -TERM "$pid" 2>/dev/null; } &',
			'watch=$!',
			'wait "$pid"; code=$?',
			'kill "$watch" 2>/dev/null',
			'exit "$code"',
		] : [`exec ${cli}`]),
	].join('\n');
}

/** The ssh arguments for one remote script. */
export function sshArgs(machine: Machine, script: string): string[] {
	return [
		'-T',
		'-o', 'BatchMode=yes',
		'-o', 'ConnectTimeout=10',
		'-o', 'ServerAliveInterval=30',
		...(machine.port ? ['-p', String(machine.port)] : []),
		machine.host,
		// The remote login shell may be anything; the script itself is POSIX sh.
		`sh -lc ${shQuote(script)}`,
	];
}

/** ssh arguments for an interactive terminal that runs one command in the machine's folder. */
export function sshTerminalArgs(machine: Machine, command: string, args: readonly string[]): string[] {
	const script = `cd ${machine.folder ? remotePath(machine.folder) : '"$HOME"'} || exit 98\nexec ${[command, ...args].map(shQuote).join(' ')}`;
	return ['-t', ...(machine.port ? ['-p', String(machine.port)] : []), machine.host, `sh -lc ${shQuote(script)}`];
}

export interface SshOptions {
	/** The ssh client, `ssh` unless configured. */
	readonly ssh: string;
	readonly spawn?: SpawnFn;
}

/**
 * A spawn function that runs the command on the machine instead. The adapters use it
 * in place of child_process.spawn; options.cwd is ignored (the machine folder counts).
 */
export function remoteSpawn(machine: Machine, options: SshOptions): SpawnFn {
	return (command, args, spawnOptions) => {
		const stdio = Array.isArray(spawnOptions.stdio) ? spawnOptions.stdio : [];
		const ownsStdin = stdio[0] !== 'ignore' && stdio[0] !== undefined;
		const script = remoteScript(command, args, machine.folder, !ownsStdin);
		const child = (options.spawn ?? nodeSpawn)(options.ssh, sshArgs(machine, script), {
			env: process.env,
			stdio: ['pipe', stdio[1] ?? 'pipe', stdio[2] ?? 'pipe'],
		});
		child.stdin?.on('error', () => { /* the remote side closed; 'close' reports it */ });
		// For a CLI without stdin, stdin stays open: closing it is the stop signal.
		child.stdin?.write(envLine(spawnOptions.env));
		return child;
	};
}

export interface ProbeResult {
	readonly reachable: boolean;
	readonly clis: string[];
	readonly error?: string;
}

const PROBE_SCRIPT = [
	'IFS= read -r ARKESTRA_ENV || exit 97',
	`for c in ${KNOWN_CLIS.join(' ')}; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done`,
	'echo ARKESTRA_PROBE_OK',
].join('\n');

/** Connects once and lists which known agent CLIs the machine has on its PATH. */
export function probe(machine: Machine, options: SshOptions, timeoutMs = 20_000): Promise<ProbeResult> {
	return runProbe(options.ssh, sshArgs(machine, PROBE_SCRIPT), options.spawn, timeoutMs);
}

/** The same check on this machine (POSIX shells only). */
export function probeLocal(spawn?: SpawnFn, timeoutMs = 10_000): Promise<ProbeResult> {
	return runProbe('sh', ['-lc', PROBE_SCRIPT], spawn, timeoutMs);
}

function runProbe(command: string, args: string[], spawn: SpawnFn | undefined, timeoutMs: number): Promise<ProbeResult> {
	return new Promise(resolve => {
		const child = (spawn ?? nodeSpawn)(command, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => { out += c; });
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (c: string) => { err = (err + c).slice(-2000); });
		child.stdin?.on('error', () => { });
		child.stdin?.end(envLine({}));
		const finish = (result: ProbeResult) => { clearTimeout(timer); resolve(result); };
		child.on('error', e => finish({ reachable: false, clis: [], error: e.message }));
		child.on('close', (code, signal) => {
			const lines = out.split('\n').map(l => l.trim());
			if (lines.includes('ARKESTRA_PROBE_OK')) {
				finish({ reachable: true, clis: KNOWN_CLIS.filter(c => lines.includes(c)) });
			} else {
				const last = err.trim().split('\n').at(-1);
				finish({ reachable: false, clis: [], error: signal === 'SIGKILL' ? 'Connection timed out' : last || `${command} exited with ${code}` });
			}
		});
	});
}

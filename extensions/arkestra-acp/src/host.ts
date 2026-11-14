/*---------------------------------------------------------------------------------------------
 *  Arkestra. What an ACP agent may ask of the client: read and write text files and run
 *  commands in terminals, on the machine the agent runs on (this one, or an SSH machine).
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { RESOURCE_NOT_FOUND, RpcError } from './jsonrpc';

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface FileAccess {
	read(file: string): Promise<string>;
	write(file: string, content: string): Promise<void>;
}

/** Files of this machine. */
export const localFiles: FileAccess = {
	read: async file => {
		try {
			return await readFile(file, 'utf8');
		} catch (e: any) {
			throw e?.code === 'ENOENT' ? new RpcError(RESOURCE_NOT_FOUND, `File not found: ${file}`) : e;
		}
	},
	write: async (file, content) => {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, content, 'utf8');
	},
};

/** Files of a remote machine, through commands run there (`cat`, `mkdir -p`). */
export function remoteFiles(spawn: SpawnFn): FileAccess {
	const run = (args: string[], input?: string) => new Promise<string>((resolve, reject) => {
		const child = spawn('sh', ['-c', args[0], 'sh', ...args.slice(1)], { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => { out += c; });
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (c: string) => { err += c; });
		child.on('error', reject);
		child.on('close', code => code === 0 ? resolve(out)
			: code === 3 ? reject(new RpcError(RESOURCE_NOT_FOUND, `File not found: ${args[1]}`))
				: reject(new Error(err.trim() || `exit ${code}`)));
		if (input !== undefined) {
			child.stdin?.end(input);
		}
	});
	return {
		read: file => run(['[ -f "$1" ] || exit 3; cat -- "$1"', file]),
		write: async (file, content) => { await run(['mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', file], content); },
	};
}

/** The lines a `fs/read_text_file` asks for: `line` is 1-based, `limit` a line count. */
export function sliceLines(text: string, line?: number | null, limit?: number | null): string {
	if (!line && !limit) {
		return text;
	}
	const lines = text.split('\n');
	const start = Math.max(0, (line ?? 1) - 1);
	return lines.slice(start, limit ? start + limit : undefined).join('\n');
}

interface Terminal {
	readonly child: ChildProcess;
	output: string;
	truncated: boolean;
	readonly limit: number | undefined;
	exit?: { exitCode: number | null; signal: string | null };
	readonly exited: Promise<{ exitCode: number | null; signal: string | null }>;
}

/** Keeps the end of the output within `limit` bytes, cut at a character boundary. */
export function keepTail(text: string, limit: number | undefined): { text: string; truncated: boolean } {
	if (limit === undefined || Buffer.byteLength(text, 'utf8') <= limit) {
		return { text, truncated: false };
	}
	const bytes = Buffer.from(text, 'utf8');
	let start = bytes.length - limit;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
		start++; // never start inside a multi-byte character
	}
	return { text: bytes.subarray(start).toString('utf8'), truncated: true };
}

/** Terminals an agent opened: commands with their output, exit status, kill and release. */
export class Terminals {
	private readonly terminals = new Map<string, Terminal>();
	private counter = 0;

	/**
	 * @param remote the spawn runs on an SSH machine, which takes neither cwd nor env from the
	 * spawn options; the command is then wrapped in `sh` that changes folder and sets them.
	 */
	constructor(private readonly spawn: SpawnFn = nodeSpawn, private readonly remote = false) { }

	create(params: { command: string; args?: string[]; env?: { name: string; value: string }[]; cwd?: string | null; outputByteLimit?: number | null }): { terminalId: string } {
		const vars = (params.env ?? []).filter(v => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name));
		const child = this.remote
			? this.spawn('sh', ['-c', 'cd -- "$1" || exit 126; shift; exec env "$@"', 'sh', params.cwd || '.', ...vars.map(v => `${v.name}=${v.value}`), params.command, ...(params.args ?? [])], { stdio: ['ignore', 'pipe', 'pipe'] })
			: this.spawn(params.command, params.args ?? [], { cwd: params.cwd ?? undefined, env: { ...process.env, ...Object.fromEntries(vars.map(v => [v.name, v.value])) }, stdio: ['ignore', 'pipe', 'pipe'] });
		const id = `term-${++this.counter}`;
		const terminal: Terminal = {
			child,
			output: '',
			truncated: false,
			limit: params.outputByteLimit ?? undefined,
			exited: new Promise(resolve => {
				child.on('error', e => {
					terminal.output += `${e.message}\n`;
					terminal.exit = { exitCode: 127, signal: null };
					resolve(terminal.exit);
				});
				child.on('close', (code, signal) => {
					terminal.exit ??= { exitCode: code, signal: signal ?? null };
					resolve(terminal.exit);
				});
			}),
		};
		const append = (chunk: Buffer | string) => {
			const kept = keepTail(terminal.output + chunk.toString(), terminal.limit);
			terminal.output = kept.text;
			terminal.truncated ||= kept.truncated;
		};
		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		this.terminals.set(id, terminal);
		return { terminalId: id };
	}

	output(terminalId: string): { output: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null } {
		const t = this.get(terminalId);
		return { output: t.output, truncated: t.truncated, exitStatus: t.exit ?? null };
	}

	async waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
		return this.get(terminalId).exited;
	}

	kill(terminalId: string): void {
		const t = this.get(terminalId);
		if (!t.exit) {
			t.child.kill('SIGTERM');
		}
	}

	release(terminalId: string): void {
		const t = this.terminals.get(terminalId);
		if (t && !t.exit) {
			t.child.kill('SIGTERM');
		}
		this.terminals.delete(terminalId);
	}

	dispose(): void {
		for (const id of [...this.terminals.keys()]) {
			this.release(id);
		}
	}

	private get(terminalId: string): Terminal {
		const t = this.terminals.get(terminalId);
		if (!t) {
			throw new RpcError(RESOURCE_NOT_FOUND, `No terminal ${terminalId}`);
		}
		return t;
	}
}

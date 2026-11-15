/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude in a room through the user's own Claude Code CLI: subscription
 *  login or API key. One CLI session per room; each turn sends only what is new.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import type { Agent, AgentChoices, AgentEvent, ExistingSession, Usage, Message, Readiness, SessionEntry, SessionHistory, SessionMeta, TurnInput, WorkUpdate } from './rooms';
import { ClaudeHistory, LIST_SCRIPT, claudeMeta, claudePiece, claudeToolLine, localHistory, localListing, localSessionPath, locateScript, parseListing, readScript } from './sessions';
import { followLocal, followRemote } from './follow';
import { CloudClient, CREDENTIALS_SCRIPT } from './cloud';
import { watchLocal, watchRemote, type LiveState } from './liveStates';
import { readFile as readFileAsync } from 'node:fs/promises';
import * as nodePath from 'node:path';

export type AuthMode = 'subscription' | 'apiKey';

export interface ClaudeCodeOptions {
	/** CLI command, `claude` unless configured. */
	readonly command: string;
	readonly model?: string;
	/** Claude Code permission mode for headless turns. */
	readonly permissionMode: string;
	/** The machine's and project's permission lists (AR22), passed as Claude Code's own allow and deny flags. */
	readonly permissionRules?: () => { readonly allow: readonly string[]; readonly deny: readonly string[] };
	readonly cwd: () => string | undefined;
	/** The stored API key, or undefined to use the CLI's own login. */
	readonly apiKey: () => Promise<string | undefined>;
	readonly spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** Who this instance is: the local Claude, or Claude on an SSH machine. */
	readonly identity?: AgentIdentity;
}

export interface AgentIdentity {
	readonly id: string;
	readonly name: string;
	/** Where the CLI runs, shown in the agent's detail line. */
	readonly where: string;
}

interface RoomSession {
	sessionId?: string;
	/**
	 * Ids of the transcript messages this CLI session has already seen. By id, not by count:
	 * in a template room other agents write while this one works.
	 */
	seen: Set<string>;
	/** The shared rules' version this session was given. */
	sharedVersion?: string;
	/** An adopted session's folder (AR39): Claude Code finds a session only from its own folder. */
	cwd?: string;
}

/** Turns transcript messages into the text Claude reads, author by author. */
export function formatMessages(messages: readonly Message[], selfId: string, includeOwn = false): string {
	return messages
		.filter(m => !m.to || m.to.includes(selfId))
		.filter(m => includeOwn || !(m.author.kind === 'agent' && m.author.id === selfId))
		.map(m => m.author.kind === 'user' ? `[${m.author.name}]\n${m.text}`
			: m.author.kind === 'system' ? `[room] ${m.text}`
				: m.author.id === selfId ? `[you, earlier]\n${m.text}`
					: `[${m.author.name} (agent)]\n${m.text}`)
		.join('\n\n');
}

export const ROOM_PREAMBLE = 'You are Claude in an Arkestra room: a thread shared by the user and other AI agents. '
	+ 'Messages are labelled by author. Answer the latest user request, take the other agents\' messages into account, '
	+ 'and do not repeat what they already did.';

/** Parses one stream-json line of `claude -p --output-format stream-json`. */
export function parseLine(line: string): { events: AgentEvent[]; sessionId?: string; result?: { isError: boolean; text?: string }; contextUsed?: number; usage?: Usage } {
	let data: any;
	try {
		data = JSON.parse(line);
	} catch {
		return { events: [] };
	}
	const events: AgentEvent[] = [];
	const sessionId: string | undefined = typeof data.session_id === 'string' ? data.session_id : undefined;
	if (data.type === 'rate_limit_event' && data.rate_limit_info) {
		const limit = rateLimit(data.rate_limit_info);
		if (limit) {
			events.push({ kind: 'usage', usage: { limits: [limit] } });
		}
	}
	// The latest model call's input is how full the context is.
	const u = data.type === 'assistant' ? data.message?.usage : undefined;
	const contextUsed = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) : undefined;
	// A sub-agent's own messages carry its Task call's id: its task list and tools are not the agent's.
	const top = !data.parent_tool_use_id;
	if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
		for (const block of data.message.content) {
			if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
				events.push({ kind: 'text', text: block.text });
			} else if (block?.type === 'tool_use' && typeof block.name === 'string') {
				events.push({ kind: 'tool', text: describeTool(block.name, block.input) });
				const work = top ? workOf(block) : undefined;
				if (work) {
					events.push({ kind: 'work', work });
				}
			}
		}
	}
	if (top && data.type === 'user' && Array.isArray(data.message?.content)) {
		for (const block of data.message.content) {
			if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
				events.push({ kind: 'work', work: { type: 'finished', id: block.tool_use_id, ok: !block.is_error, ...(resultText(block.content) ? { text: resultText(block.content) } : {}) } });
			}
		}
	}
	if (data.type === 'result') {
		const total = data.usage ?? {};
		const models = data.modelUsage && typeof data.modelUsage === 'object' ? Object.values(data.modelUsage) as { contextWindow?: number }[] : [];
		const window = models.map(m => m?.contextWindow).find((w): w is number => typeof w === 'number' && w > 0);
		const usage: Usage = {
			input: (total.input_tokens ?? 0) + (total.cache_creation_input_tokens ?? 0),
			output: total.output_tokens ?? 0,
			cached: total.cache_read_input_tokens ?? 0,
			...(typeof data.total_cost_usd === 'number' ? { costUsd: data.total_cost_usd } : {}),
			...(window ? { context: { used: 0, window } } : {}),
		};
		const reported = data.usage !== undefined || typeof data.total_cost_usd === 'number';
		return { events, sessionId, ...(reported ? { usage } : {}), result: { isError: !!data.is_error, text: typeof data.result === 'string' ? data.result : undefined } };
	}
	return { events, sessionId, ...(contextUsed !== undefined ? { contextUsed } : {}) };
}

/** Claude Code's rate limit report as a quota window, when it says how much is used. */
export function rateLimit(info: any): { label: string; usedPercent: number; resetsAt?: string } | undefined {
	const used = typeof info?.utilization === 'number' ? info.utilization : undefined;
	if (used === undefined) {
		return undefined;
	}
	const labels: Record<string, string> = { five_hour: '5h', seven_day: 'week', seven_day_opus: 'week · Opus', seven_day_sonnet: 'week · Sonnet' };
	const resets = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : undefined;
	return { label: labels[info.rateLimitType] ?? String(info.rateLimitType ?? 'limit'), usedPercent: Math.round(used <= 1 ? used * 100 : used), ...(resets ? { resetsAt: resets } : {}) };
}

/** What a tool call means for the Activity view: the task list, a sub-agent, a background command, a chapter. */
export function workOf(block: { id?: string; name: string; input?: any }): WorkUpdate | undefined {
	const input = block.input ?? {};
	const id = typeof block.id === 'string' ? block.id : '';
	if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
		const status = (s: unknown) => s === 'completed' || s === 'in_progress' ? s : 'pending';
		return { type: 'todos', items: input.todos.filter((t: any) => typeof t?.content === 'string').map((t: any) => ({ text: t.status === 'in_progress' && typeof t.activeForm === 'string' ? t.activeForm : t.content, status: status(t.status) })) };
	}
	if ((block.name === 'Task' || block.name === 'Agent') && id) {
		return { type: 'subagent', id, name: typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'sub-agent', ...(typeof input.description === 'string' ? { task: input.description } : {}), status: 'running' };
	}
	if (block.name === 'Bash' && input.run_in_background && id && typeof input.command === 'string') {
		return { type: 'background', id, command: input.command, status: 'running' };
	}
	if ((block.name === 'BashOutput' || block.name === 'TaskOutput') && id) {
		const target = input.bash_id ?? input.shell_id ?? input.task_id;
		return typeof target === 'string' ? { type: 'poll', id, target } : undefined;
	}
	if ((block.name === 'KillShell' || block.name === 'KillBash' || block.name === 'TaskStop') && id) {
		const target = input.shell_id ?? input.bash_id ?? input.task_id;
		return typeof target === 'string' ? { type: 'poll', id, target, kill: true } : undefined;
	}
	if (/mark_chapter$/.test(block.name) && typeof input.title === 'string') {
		return { type: 'chapter', title: input.title, ...(typeof input.summary === 'string' ? { summary: input.summary } : {}) };
	}
	return undefined;
}

function resultText(content: unknown): string | undefined {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const text = content.map((c: any) => typeof c?.text === 'string' ? c.text : '').join('\n').trim();
		return text || undefined;
	}
	return undefined;
}

function describeTool(name: string, input: any): string {
	const target = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url;
	return typeof target === 'string' ? `${name} ${target.length > 80 ? target.slice(0, 77) + '…' : target}` : name;
}

/**
 * A CLI that could not be started, in plain words: not installed (ENOENT; on an SSH machine the
 * shell's 127), or not allowed to run (EACCES; 126). `where`: the SSH machine's name, none for
 * this computer. Undefined: some other failure, shown as it is.
 */
export function startProblem(product: string, error: { code?: unknown; exitCode?: unknown } | undefined, where?: string): Error | undefined {
	// On an SSH machine a local spawn error is ssh's own, not the CLI's: only the remote shell's codes count.
	const code = where ? error?.exitCode : error?.code;
	if (code === 'ENOENT' || code === 127) {
		return new Error(where ? `${product} is not installed on ${where}. Install it there or choose another machine.` : `${product} is not installed on this computer. Install it or connect a machine that has it.`);
	}
	if (code === 'EACCES' || code === 126) {
		return new Error(where ? `${product} could not be started on ${where}: it is not allowed to run. Reinstall it there or choose another machine.` : `${product} could not be started on this computer: it is not allowed to run. Reinstall it or connect a machine that has it.`);
	}
	return undefined;
}

/**
 * The script that prints the processes running a session (the id is checked before it gets
 * here): Claude Code started with `--resume <id>`, `--resume=<id>`, `-r <id>` or `--session-id <id>`.
 * A follow (`tail -F` of the session file) names the file, not the flag, so it never counts.
 */
export function runningScript(id: string): string {
	if (!/^[0-9a-f-]{36}$/i.test(id)) {
		throw new Error(`not a Claude session id: ${id}`);
	}
	return `ps -eo pid=,args= 2>/dev/null | grep -E -- '(--resume[= ]|--session-id[= ]|-r )${id}' | grep -v -F 'grep' | head -n 3 || true`;
}

/** Who else runs a session, from `runningScript`'s output: the Claude desktop app or another Claude Code; none: undefined. */
export function runningElsewhere(out: string, id: string): string | undefined {
	// Only `ps` lines (a pid, then the command) that name the session count.
	const lines = out.split('\n').map(l => l.trim()).filter(l => /^\d+\s/.test(l) && l.includes(id));
	if (!lines.length) {
		return undefined;
	}
	return lines.some(l => /ccd-cli|Claude\.app|claude-code-vm|[\\/]Claude[\\/]claude-code[\\/]/.test(l)) ? 'the Claude desktop app' : 'another Claude Code';
}

/** The refusal when the session already runs in another app: a second Claude on it would write it apart. */
export function openElsewhere(app: string, where?: string): Error {
	return new Error(`This session is open in ${app}${where ? ` on ${where}` : ''}. Arkestra did not start a second Claude on it: the two would write the same session apart. Continue it there, or close it there first and send again.`);
}

/**
 * Claude Code's models (aliases for the latest of each) and its efforts, as `claude --help` lists them,
 * plus `ultracode` (`--effort ultracode`: a workflow on every task), which help does not list; not on Haiku.
 */
export const CLAUDE_CHOICES: AgentChoices = {
	models: [
		{ id: 'opus', label: 'Opus', detail: 'the latest Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
		{ id: 'sonnet', label: 'Sonnet', detail: 'the latest Sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
		{ id: 'fable', label: 'Fable', detail: 'the latest Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
		{ id: 'haiku', label: 'Haiku', detail: 'the latest Haiku', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
	],
};

export class ClaudeCodeAgent implements Agent {
	readonly id: string;
	readonly name: string;
	private readonly where: string;
	private readonly sessions = new Map<string, RoomSession>();
	/**
	 * 2: messages sent while Claude worked, compactions as one line, the model and context fill.
	 * 3: the tool lines too, for what Claude produced (AR26): threads read before get their artifacts.
	 */
	readonly historyVersion = 5;

	/** The claude.ai account's sessions, with the sign-in Claude Code keeps on this agent's machine. */
	readonly cloud: CloudClient;

	constructor(private readonly options: ClaudeCodeOptions) {
		({ id: this.id, name: this.name, where: this.where } = options.identity ?? { id: 'claude', name: 'Claude', where: 'local' });
		this.cloud = new CloudClient(() => this.credentials(), this.options.spawn ? this.where : 'this computer');
	}

	get detail(): string {
		return `Claude Code${this.options.model ? ' · ' + this.options.model : ''} · ${this.where}`;
	}

	async choices(): Promise<AgentChoices> {
		const own = this.options.model;
		return own && !CLAUDE_CHOICES.models.some(m => m.id === own) ? { models: [{ id: own, label: own, detail: 'from the settings', efforts: CLAUDE_CHOICES.models[0].efforts }, ...CLAUDE_CHOICES.models] } : CLAUDE_CHOICES;
	}

	async readiness(): Promise<Readiness> {
		const version = await this.run(['--version'], 20_000).catch(() => undefined);
		if (version?.code === 255 && version.err) {
			// ssh itself failed: unreachable machine, rejected key.
			return { ready: false, reason: version.err, fix: 'retry' };
		}
		if (version === undefined || version.code !== 0) {
			return { ready: false, reason: 'Claude Code CLI not found', fix: 'install' };
		}
		if (!await this.options.apiKey()) {
			// Subscription: the CLI has to be signed in. A CLI without `auth status` is taken as ready.
			const status = await this.run(['auth', 'status'], 20_000).catch(() => undefined);
			let loggedIn: unknown = true;
			try {
				loggedIn = JSON.parse(status?.out ?? '').loggedIn;
			} catch { /* older CLI or no JSON */ }
			if (loggedIn === false) {
				return { ready: false, reason: 'Claude Code is not signed in', fix: 'signIn' };
			}
		}
		return { ready: true };
	}

	/** The sessions Claude Code has on this agent's machine (AR39). */
	/** Each session on this agent's machine as it starts and ends a turn, live. */
	watchStates(onState: (s: LiveState) => void): { dispose(): void } {
		return this.options.spawn ? watchRemote(this.options.spawn, onState) : watchLocal(homedir(), onState);
	}

	/** The claude.ai account's quota windows now, the ones the Claude app shows. */
	quota(): Promise<readonly { readonly label: string; readonly usedPercent: number; readonly resetsAt?: string }[]> {
		return this.cloud.usage();
	}

	async existingSessions(): Promise<readonly ExistingSession[]> {
		return parseListing(this.options.spawn ? await this.shell(LIST_SCRIPT) : await localListing(homedir()));
	}

	/** A session's latest messages, its model and context fill, and where the live follow goes on. */
	async sessionHistory(sessionId: string): Promise<SessionHistory> {
		return this.options.spawn ? this.remoteHistory(sessionId) : localHistory(homedir(), sessionId);
	}

	/** The end of a session file on the SSH machine, read as bytes (the follow's cursor is a byte offset). */
	private remoteHistory(sessionId: string, timeoutMs = 180_000): Promise<SessionHistory> {
		const script = readScript(sessionId);
		return new Promise((resolve, reject) => {
			const child = this.options.spawn!('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
			const history = new ClaudeHistory(0, true);
			let err = '';
			const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
			child.stdout?.on('data', (chunk: Buffer) => history.push(chunk));
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (c: string) => { err = (err + c).slice(-2000); });
			child.on('error', e => { clearTimeout(timer); reject(e); });
			child.on('close', code => {
				clearTimeout(timer);
				if (code === 0) {
					resolve(history.result());
				} else {
					reject(new Error(code === 3 ? 'the session file is gone' : err.trim().split('\n').at(-1) || `exited with ${code}`));
				}
			});
		});
	}

	adoptSession(roomId: string, session: { readonly id: string; readonly cwd?: string }, seen: readonly string[]): void {
		const known = this.sessions.get(roomId);
		if (!known) {
			this.sessions.set(roomId, { sessionId: session.id, seen: new Set(seen), ...(session.cwd ? { cwd: session.cwd } : {}) });
		} else if (known.sessionId === session.id) {
			seen.forEach(id => known.seen.add(id)); // what came in live from the session is in it already
		}
	}

	/** Follows a session file live (AR39): here through the file system, on an SSH machine through `tail -F`. */
	watchSession(sessionId: string, onEntries: (entries: readonly SessionEntry[], cursor: string, meta?: SessionMeta, lines?: readonly string[]) => void, cursor?: string): { dispose(): void } {
		const options = { classify: claudePiece, meta: claudeMeta, keep: claudeToolLine, onEntries, ...(cursor !== undefined ? { cursor } : {}) };
		return this.options.spawn
			? followRemote(this.options.spawn, locateScript(sessionId), options)
			: followLocal(() => localSessionPath(homedir(), sessionId), options);
	}

	/** Claude Code's credentials on the agent's machine: its file, else (macOS) its keychain item. */
	private async credentials(): Promise<string> {
		if (this.options.spawn) {
			return this.shell(CREDENTIALS_SCRIPT, 15_000);
		}
		const file = await readFileAsync(nodePath.join(homedir(), '.claude', '.credentials.json'), 'utf8').catch(() => undefined);
		if (file !== undefined || process.platform !== 'darwin') {
			return file ?? '';
		}
		return new Promise<string>(resolve => {
			const child = nodeSpawn('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
			let text = '';
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (c: string) => { text += c; });
			child.on('error', () => resolve(''));
			child.on('close', () => resolve(text));
		});
	}

	/** A POSIX script on the agent's machine (an SSH machine); resolves to its output. */
	private shell(script: string, timeoutMs = 60_000): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = this.options.spawn!('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
			const out: string[] = [];
			let err = '';
			const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (c: string) => { out.push(c); });
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (c: string) => { err = (err + c).slice(-2000); });
			child.on('error', e => { clearTimeout(timer); reject(e); });
			child.on('close', code => {
				clearTimeout(timer);
				if (code === 0) {
					resolve(out.join(''));
				} else {
					reject(new Error(err.trim().split('\n').at(-1) || `exited with ${code}`));
				}
			});
		});
	}

	/** The session's id in the claude.ai account (`cse_…`), from its file's end; none: the Claude app does not have it. */
	private async bridgeOf(sessionId: string): Promise<string | undefined> {
		const pick = (text: string) => [...text.matchAll(/"bridgeSessionId":"(cse_[A-Za-z0-9]+)"/g)].at(-1)?.[1];
		try {
			if (this.options.spawn) {
				return pick(await this.shell(`${locateScript(sessionId)}\n[ -n "$f" ] && tail -c 131072 "$f" | grep -o -E '"bridgeSessionId":"cse_[A-Za-z0-9]+"' | tail -n 1; exit 0`, 15_000));
			}
			const file = await localSessionPath(homedir(), sessionId);
			if (!file) {
				return undefined;
			}
			const handle = await import('node:fs/promises').then(fs => fs.open(file, 'r'));
			try {
				const size = (await handle.stat()).size;
				const from = Math.max(0, size - 131_072);
				const buf = Buffer.alloc(size - from);
				const { bytesRead } = await handle.read(buf, 0, buf.length, from);
				return pick(buf.subarray(0, bytesRead).toString('utf8'));
			} finally {
				await handle.close();
			}
		} catch {
			return undefined;
		}
	}

	/** Which other app runs this session on the agent's machine now, if any (a failed check says none). */
	private async runningApp(sessionId: string): Promise<string | undefined> {
		if (process.platform === 'win32' && !this.options.spawn) {
			return undefined;
		}
		try {
			const script = runningScript(sessionId);
			const out = this.options.spawn ? await this.shell(script, 15_000) : await new Promise<string>(resolve => {
				const child = nodeSpawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
				let text = '';
				child.stdout?.setEncoding('utf8');
				child.stdout?.on('data', (c: string) => { text += c; });
				child.on('error', () => resolve(''));
				child.on('close', () => resolve(text));
			});
			return runningElsewhere(out, sessionId);
		} catch {
			return undefined;
		}
	}

	async turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
		const session = this.sessions.get(input.roomId) ?? { seen: new Set<string>() };
		const fresh = input.transcript.filter(m => !session.seen.has(m.id));
		// A new CLI session (first turn, or after a restart) also gets Claude's own earlier answers.
		const body = formatMessages(fresh, this.id, !session.sessionId);
		const shared = input.shared && session.sharedVersion !== input.shared.version ? `${input.shared.text}\n\n` : '';
		const prompt = session.sessionId ? `${shared}${body}` : `${ROOM_PREAMBLE}\n\n${shared}${body}`;

		// Plan mode is Claude Code's own: it reads and plans, nothing is changed.
		const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', input.mode === 'plan' ? 'plan' : this.options.permissionMode];
		if (session.sessionId) {
			args.push('--resume', session.sessionId);
		}
		args.push(...permissionArgs(this.options.permissionRules?.()));
		// The thread's choice (AR38) wins over the setting; the effort goes only when one was chosen.
		if (input.effort) {
			args.push('--effort', input.effort);
		}
		if (input.model || this.options.model) {
			args.push('--model', input.model || this.options.model!);
		}

		// A session another app runs now (the desktop app, a terminal): a second process would fork it.
		// One the Claude app has (its claude.ai id) gets the message through the account, as the phone
		// sends it; the app's Claude answers, and the answer comes back through the session file.
		if (session.sessionId) {
			const app = await this.runningApp(session.sessionId);
			if (app) {
				const bridge = await this.bridgeOf(session.sessionId);
				if (!bridge) {
					throw openElsewhere(app, this.options.spawn ? this.where : undefined);
				}
				for (const m of fresh.filter(m => m.author.kind === 'user' && m.text.trim())) {
					await this.cloud.send(bridge, m.text.trim());
				}
				input.transcript.forEach(m => session.seen.add(m.id));
				this.sessions.set(input.roomId, session);
				return;
			}
		}

		const env = { ...process.env };
		const key = await this.options.apiKey();
		if (key) {
			env.ANTHROPIC_API_KEY = key;
		} else {
			delete env.ANTHROPIC_API_KEY; // subscription: the CLI's own login
		}

		// An adopted session runs in its own folder; on an SSH machine through `cd` (the machine folder is the default there).
		const remoteCwd = !input.cwd && session.cwd && this.options.spawn ? session.cwd : undefined;
		const [command, commandArgs] = remoteCwd ? ['sh', ['-c', 'cd "$1" || exit 98; shift; exec "$@"', 'sh', remoteCwd, this.options.command, ...args]] : [this.options.command, args];
		const child = (this.options.spawn ?? nodeSpawn)(command, commandArgs, { cwd: input.cwd ?? (this.options.spawn ? undefined : session.cwd) ?? this.options.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
		const kill = () => child.kill('SIGTERM');
		signal.addEventListener('abort', kill);

		let buffer = '';
		let stderr = '';
		let result: { isError: boolean; text?: string } | undefined;
		let sawText = false;
		let contextUsed: number | undefined;
		const handle = (line: string) => {
			if (claudeToolLine(line)) {
				onEvent({ kind: 'line', line }); // what Claude produced with its tools (AR26)
			}
			const parsed = parseLine(line);
			if (parsed.sessionId) {
				session.sessionId = parsed.sessionId;
			}
			contextUsed = parsed.contextUsed ?? contextUsed;
			if (parsed.usage) {
				// The result knows the window; the last model call knows the fill.
				const { context, ...totals } = parsed.usage;
				const window = context?.window;
				onEvent({ kind: 'usage', usage: { ...totals, ...(contextUsed !== undefined ? { context: { used: contextUsed, ...(window ? { window } : {}) } } : {}) } });
			}
			for (const event of parsed.events) {
				sawText ||= event.kind === 'text';
				onEvent(event);
			}
			result = parsed.result ?? result;
		};
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				handle(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
			}
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });

		const where = this.options.spawn ? this.where : undefined;
		const code = await new Promise<number | null>((resolve, reject) => {
			// `spawn claude ENOENT`: no Claude Code here; said in plain words (the SSH machine's own shell says 127).
			child.on('error', error => reject(startProblem('Claude Code', error as { code?: unknown }, where) ?? error));
			child.on('close', resolve);
		}).finally(() => signal.removeEventListener('abort', kill));
		if (buffer.trim()) {
			handle(buffer);
		}
		if (signal.aborted) {
			return;
		}
		if (!result && where && (code === 127 || code === 126)) {
			throw startProblem('Claude Code', { exitCode: code }, where)!;
		}
		if (result?.isError || (code !== 0 && !result)) {
			throw new Error(result?.text || stderr.trim().split('\n').at(-1) || `claude exited with ${code}`);
		}
		if (!sawText && result?.text) {
			onEvent({ kind: 'text', text: result.text });
		}
		// The CLI session now holds the transcript it was given; its own answer is never sent back.
		input.transcript.forEach(m => session.seen.add(m.id));
		session.sharedVersion = input.shared?.version ?? session.sharedVersion;
		this.sessions.set(input.roomId, session);
	}

	private run(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err?: string }> {
		return new Promise((resolve, reject) => {
			const child = (this.options.spawn ?? nodeSpawn)(this.options.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
			let out = '';
			let err = '';
			const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (c: string) => { out += c; });
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (c: string) => { err = (err + c).slice(-2000); });
			child.on('error', e => { clearTimeout(timer); reject(e); });
			child.on('close', code => { clearTimeout(timer); resolve({ code, out, err: err.trim().split('\n').at(-1) || undefined }); });
		});
	}
}

/** Claude Code's flags for the permission lists; the rule syntax is its own. `*` alone means every tool. */
export function permissionArgs(rules?: { readonly allow: readonly string[]; readonly deny: readonly string[] }): string[] {
	if (!rules) {
		return [];
	}
	const every = ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
	const fix = (list: readonly string[]) => [...new Set(list.map(r => r.trim()).filter(Boolean).flatMap(r => (r === '*' ? every : [r])))];
	const allow = fix(rules.allow);
	const deny = fix(rules.deny);
	// One argument per rule: a rule may hold commas and spaces (`Bash(git log --format=%h,%s)`).
	return [...(allow.length ? ['--allowedTools', ...allow] : []), ...(deny.length ? ['--disallowedTools', ...deny] : [])];
}

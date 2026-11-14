/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude in a room through the user's own Claude Code CLI: subscription
 *  login or API key. One CLI session per room; each turn sends only what is new.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import type { Agent, AgentChoices, AgentEvent, ExistingSession, Usage, Message, Readiness, SessionEntry, TurnInput, WorkUpdate } from './rooms';
import { LIST_SCRIPT, localListing, localSessionFile, parseHistory, parseListing, readScript } from './sessions';

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

/** Claude Code's models (aliases for the latest of each) and its efforts, as `claude --help` lists them. */
export const CLAUDE_CHOICES: AgentChoices = {
	models: [
		{ id: 'opus', label: 'Opus', detail: 'the latest Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
		{ id: 'sonnet', label: 'Sonnet', detail: 'the latest Sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
		{ id: 'fable', label: 'Fable', detail: 'the latest Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
		{ id: 'haiku', label: 'Haiku', detail: 'the latest Haiku', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
	],
};

export class ClaudeCodeAgent implements Agent {
	readonly id: string;
	readonly name: string;
	private readonly where: string;
	private readonly sessions = new Map<string, RoomSession>();

	constructor(private readonly options: ClaudeCodeOptions) {
		({ id: this.id, name: this.name, where: this.where } = options.identity ?? { id: 'claude', name: 'Claude', where: 'local' });
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
	async existingSessions(): Promise<readonly ExistingSession[]> {
		return parseListing(this.options.spawn ? await this.shell(LIST_SCRIPT) : await localListing(homedir()));
	}

	async sessionHistory(sessionId: string): Promise<readonly SessionEntry[]> {
		return parseHistory(this.options.spawn ? await this.shell(readScript(sessionId)) : await localSessionFile(homedir(), sessionId));
	}

	adoptSession(roomId: string, session: { readonly id: string; readonly cwd?: string }, seen: readonly string[]): void {
		if (!this.sessions.has(roomId)) {
			this.sessions.set(roomId, { sessionId: session.id, seen: new Set(seen), ...(session.cwd ? { cwd: session.cwd } : {}) });
		}
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

		const code = await new Promise<number | null>((resolve, reject) => {
			child.on('error', reject);
			child.on('close', resolve);
		}).finally(() => signal.removeEventListener('abort', kill));
		if (buffer.trim()) {
			handle(buffer);
		}
		if (signal.aborted) {
			return;
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

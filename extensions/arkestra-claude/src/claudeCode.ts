/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude in a room through the user's own Claude Code CLI: subscription
 *  login or API key. One CLI session per room; each turn sends only what is new.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Agent, AgentEvent, Message, Readiness, TurnInput } from './rooms';

export type AuthMode = 'subscription' | 'apiKey';

export interface ClaudeCodeOptions {
	/** CLI command, `claude` unless configured. */
	readonly command: string;
	readonly model?: string;
	/** Claude Code permission mode for headless turns; allow lists come later. */
	readonly permissionMode: string;
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
export function parseLine(line: string): { events: AgentEvent[]; sessionId?: string; result?: { isError: boolean; text?: string } } {
	let data: any;
	try {
		data = JSON.parse(line);
	} catch {
		return { events: [] };
	}
	const events: AgentEvent[] = [];
	const sessionId: string | undefined = typeof data.session_id === 'string' ? data.session_id : undefined;
	if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
		for (const block of data.message.content) {
			if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
				events.push({ kind: 'text', text: block.text });
			} else if (block?.type === 'tool_use' && typeof block.name === 'string') {
				events.push({ kind: 'tool', text: describeTool(block.name, block.input) });
			}
		}
	}
	if (data.type === 'result') {
		return { events, sessionId, result: { isError: !!data.is_error, text: typeof data.result === 'string' ? data.result : undefined } };
	}
	return { events, sessionId };
}

function describeTool(name: string, input: any): string {
	const target = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url;
	return typeof target === 'string' ? `${name} ${target.length > 80 ? target.slice(0, 77) + '…' : target}` : name;
}

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

	async turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
		const session = this.sessions.get(input.roomId) ?? { seen: new Set<string>() };
		const fresh = input.transcript.filter(m => !session.seen.has(m.id));
		// A new CLI session (first turn, or after a restart) also gets Claude's own earlier answers.
		const body = formatMessages(fresh, this.id, !session.sessionId);
		const prompt = session.sessionId ? body : `${ROOM_PREAMBLE}\n\n${body}`;

		const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', this.options.permissionMode];
		if (session.sessionId) {
			args.push('--resume', session.sessionId);
		}
		if (this.options.model) {
			args.push('--model', this.options.model);
		}

		const env = { ...process.env };
		const key = await this.options.apiKey();
		if (key) {
			env.ANTHROPIC_API_KEY = key;
		} else {
			delete env.ANTHROPIC_API_KEY; // subscription: the CLI's own login
		}

		const child = (this.options.spawn ?? nodeSpawn)(this.options.command, args, { cwd: this.options.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
		const kill = () => child.kill('SIGTERM');
		signal.addEventListener('abort', kill);

		let buffer = '';
		let stderr = '';
		let result: { isError: boolean; text?: string } | undefined;
		let sawText = false;
		const handle = (line: string) => {
			const parsed = parseLine(line);
			if (parsed.sessionId) {
				session.sessionId = parsed.sessionId;
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

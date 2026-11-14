/*---------------------------------------------------------------------------------------------
 *  Arkestra. Codex in a room through the user's own Codex CLI (`codex app-server`, the
 *  protocol the Codex IDE extension uses): ChatGPT login or API key. One Codex thread per
 *  room; each turn sends only what is new.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { Agent, AgentEvent, Message, Readiness, TurnInput } from './rooms';
import { RpcClient, type Notification } from './rpc';

export type CodexAuth = { readonly mode: 'subscription' } | { readonly mode: 'apiKey'; readonly key: string | undefined };

export interface CodexOptions {
	/** CLI command, `codex` unless configured. */
	readonly command: string;
	readonly model?: string;
	readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
	readonly cwd: () => string | undefined;
	readonly auth: () => Promise<CodexAuth>;
	/**
	 * CODEX_HOME for API-key mode. Kept apart from the user's own ~/.codex so signing in
	 * with a key never replaces their ChatGPT login.
	 */
	readonly apiKeyHome: string;
	readonly spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** Who this instance is: the local Codex, or Codex on an SSH machine. */
	readonly identity?: AgentIdentity;
}

export interface AgentIdentity {
	readonly id: string;
	readonly name: string;
	/** Where the CLI runs, shown in the agent's detail line. */
	readonly where: string;
}

interface RoomThread {
	threadId?: string;
	/** The server that holds this thread loaded; another one has to resume it first. */
	server?: RpcClient;
	/**
	 * Ids of the transcript messages this thread has already seen. By id, not by count: in a
	 * template room other agents write while this one works.
	 */
	seen: Set<string>;
}

/** Turns transcript messages into the text Codex reads, author by author. */
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

export const ROOM_PREAMBLE = 'You are Codex in an Arkestra room: a thread shared by the user and other AI agents. '
	+ 'Messages are labelled by author. Answer the latest user request, take the other agents\' messages into account, '
	+ 'and do not repeat what they already did.';

/** What a started thread item shows in the room, if anything. */
export function describeItem(item: any): string | undefined {
	const short = (s: string) => s.length > 80 ? s.slice(0, 77) + '…' : s;
	switch (item?.type) {
		case 'commandExecution':
			// Codex wraps commands in `/bin/bash -lc '…'`; the room shows the command itself.
			return typeof item.command === 'string' ? `Run ${short(item.command.replace(/^\S*\/?(?:ba|z)?sh -lc (['"]?)([\s\S]*)\1$/, '$2'))}` : 'Run';
		case 'fileChange': {
			const paths: string[] = Array.isArray(item.changes) ? item.changes.map((c: any) => c?.path).filter((p: unknown) => typeof p === 'string') : [];
			return paths.length ? `Edit ${short(paths.join(', '))}` : 'Edit';
		}
		case 'mcpToolCall':
			return `${item.server}.${item.tool}`;
		case 'webSearch':
			return typeof item.query === 'string' && item.query ? `Search ${short(item.query)}` : 'Search';
		default:
			return undefined;
	}
}

export class CodexAgent implements Agent {
	readonly id: string;
	readonly name: string;
	private readonly where: string;
	private readonly threads = new Map<string, RoomThread>();
	private server: { client: RpcClient; authKey: string; ready: Promise<void> } | undefined;

	constructor(private readonly options: CodexOptions) {
		({ id: this.id, name: this.name, where: this.where } = options.identity ?? { id: 'codex', name: 'Codex', where: 'local' });
	}

	get detail(): string {
		return `Codex${this.options.model ? ' · ' + this.options.model : ''} · ${this.where}`;
	}

	async readiness(): Promise<Readiness> {
		const version = await this.run(['--version'], 20_000).catch(() => undefined);
		if (version?.code === 255 && version.err) {
			// ssh itself failed: unreachable machine, rejected key.
			return { ready: false, reason: version.err, fix: 'retry' };
		}
		if (version === undefined || version.code !== 0) {
			return { ready: false, reason: 'Codex CLI not found', fix: 'install' };
		}
		const auth = await this.options.auth();
		if (auth.mode === 'apiKey' && !auth.key) {
			return { ready: false, reason: 'No Codex API key stored', fix: 'signIn' };
		}
		try {
			const client = await this.ensureServer(auth);
			const account = await client.request<{ account: unknown | null; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false });
			if (!account.account && account.requiresOpenaiAuth) {
				return { ready: false, reason: 'Codex is not signed in', fix: 'signIn' };
			}
			return { ready: true };
		} catch (e) {
			return { ready: false, reason: e instanceof Error ? e.message : String(e), fix: 'retry' };
		}
	}

	async turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
		const client = await this.ensureServer(await this.options.auth());
		const room = this.threads.get(input.roomId) ?? { seen: new Set<string>() };
		const threadParams = { cwd: this.options.cwd() ?? null, sandbox: this.options.sandbox, approvalPolicy: 'never', model: this.options.model ?? null };

		if (room.threadId && room.server !== client) {
			// The app-server restarted (crash, auth change): load the room's thread again.
			await client.request('thread/resume', { threadId: room.threadId, ...threadParams, excludeTurns: true })
				.then(() => { room.server = client; })
				.catch(() => { room.threadId = undefined; room.seen = new Set(); });
		}
		const freshThread = !room.threadId;
		if (freshThread) {
			const started = await client.request<{ thread: { id: string } }>('thread/start', { ...threadParams, developerInstructions: ROOM_PREAMBLE });
			room.threadId = started.thread.id;
			room.server = client;
			room.seen = new Set();
		}
		const threadId = room.threadId!;
		// A new thread also gets Codex's own earlier answers.
		const text = formatMessages(input.transcript.filter(m => !room.seen.has(m.id)), this.id, freshThread);

		let turnId: string | undefined;
		let lastError: string | undefined;
		let interruptSent = false;
		const interrupt = () => {
			if (turnId && !interruptSent) {
				interruptSent = true;
				client.request('turn/interrupt', { threadId, turnId }).catch(() => { });
			}
		};
		const subscriptions: { dispose(): void }[] = [];
		const completed = new Promise<any>((resolve, reject) => {
			subscriptions.push(client.onNotification((n: Notification) => {
				if (n.params?.threadId !== threadId) {
					return;
				}
				if (n.method === 'item/started') {
					const tool = describeItem(n.params.item);
					if (tool) {
						onEvent({ kind: 'tool', text: tool });
					}
				} else if (n.method === 'item/completed' && n.params.item?.type === 'agentMessage' && n.params.item.text) {
					onEvent({ kind: 'text', text: n.params.item.text });
				} else if (n.method === 'error' && !n.params.willRetry) {
					lastError = n.params.error?.message;
				} else if (n.method === 'turn/completed') {
					resolve(n.params.turn);
				}
			}));
			// The server dying mid-turn ends the turn with its last words.
			subscriptions.push(client.onClose(reject));
		});
		completed.catch(() => { }); // rejections are read below; never unhandled
		signal.addEventListener('abort', interrupt);
		try {
			// The sandbox is set on every turn: a Plan mode turn is read-only, and the override
			// would otherwise carry over to the next turns.
			const started = await client.request<{ turn: { id: string } }>('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], sandboxPolicy: sandboxPolicy(input.mode === 'plan' ? 'read-only' : this.options.sandbox) });
			turnId = started.turn.id;
			if (signal.aborted) {
				interrupt();
			}
			const turn = await completed;
			if (signal.aborted || turn.status === 'interrupted') {
				input.transcript.forEach(m => room.seen.add(m.id));
				this.threads.set(input.roomId, room);
				return;
			}
			if (turn.status === 'failed') {
				throw new Error(turn.error?.message || lastError || 'Codex turn failed');
			}
			// The thread now holds the transcript it was given; its own answer is never sent back.
			input.transcript.forEach(m => room.seen.add(m.id));
			this.threads.set(input.roomId, room);
		} finally {
			signal.removeEventListener('abort', interrupt);
			subscriptions.forEach(d => d.dispose());
		}
	}

	dispose(): void {
		this.server?.client.dispose();
		this.server = undefined;
	}

	private async ensureServer(auth: CodexAuth): Promise<RpcClient> {
		const authKey = auth.mode === 'apiKey' ? `key:${auth.key}` : 'subscription';
		if (this.server && !this.server.client.closed && this.server.authKey === authKey) {
			await this.server.ready;
			return this.server.client;
		}
		this.server?.client.dispose();

		const env = { ...process.env };
		delete env.OPENAI_API_KEY;
		delete env.CODEX_API_KEY;
		if (auth.mode === 'apiKey') {
			if (!this.options.apiKeyHome.startsWith('~')) {
				await mkdir(this.options.apiKeyHome, { recursive: true }); // a remote `~/…` home is made over SSH
			}
			env.CODEX_HOME = this.options.apiKeyHome;
		}
		const child = (this.options.spawn ?? nodeSpawn)(this.options.command, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
		const client = new RpcClient(child);
		const ready = (async () => {
			await client.request('initialize', { clientInfo: { name: 'arkestra', title: 'Arkestra', version: '0.1.0' }, capabilities: null });
			client.notify('initialized');
			if (auth.mode === 'apiKey' && auth.key) {
				const account = await client.request<{ account: { type: string } | null }>('account/read', { refreshToken: false });
				if (account.account?.type !== 'apiKey') {
					await client.request('account/login/start', { type: 'apiKey', apiKey: auth.key });
				}
			}
		})();
		this.server = { client, authKey, ready };
		try {
			await ready;
		} catch (e) {
			client.dispose();
			this.server = undefined;
			throw e;
		}
		return client;
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

/** The app-server's per-turn sandbox policy for a sandbox setting. */
export function sandboxPolicy(sandbox: CodexOptions['sandbox']): { type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' } {
	return { type: sandbox === 'read-only' ? 'readOnly' : sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' };
}

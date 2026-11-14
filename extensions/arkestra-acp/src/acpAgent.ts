/*---------------------------------------------------------------------------------------------
 *  Arkestra. Any agent that speaks the Agent Client Protocol (ACP) in a room: Gemini CLI,
 *  goose, the Claude Code and Codex ACP adapters, and others. One ACP session per room; each
 *  turn sends only what is new. The agent may read and write files, run commands in
 *  terminals and ask for permission, on the machine it runs on.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn } from 'node:child_process';
import type { Agent, AgentEvent, Message, Readiness, TurnInput } from './rooms';
import { AUTH_REQUIRED, JsonRpcPeer, RpcError, type Notification } from './jsonrpc';
import { Terminals, localFiles, sliceLines, type FileAccess, type SpawnFn } from './host';

export const PROTOCOL_VERSION = 1;

export interface AuthMethod {
	readonly id: string;
	readonly name: string;
	readonly description?: string | null;
}

export interface PermissionOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpOptions {
	/** Registry id, for example `gemini` or `gemini@dev-szerver`. */
	readonly id: string;
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Extra environment for a local agent. */
	readonly env?: Readonly<Record<string, string>>;
	/** Where it runs, for the detail line: `helyi`, `dev-szerver`. */
	readonly where: string;
	/** The absolute folder sessions work in. */
	readonly cwd: () => Promise<string>;
	readonly spawn?: SpawnFn;
	/** True when `spawn` runs on an SSH machine. */
	readonly remote?: boolean;
	readonly files?: FileAccess;
	/** Asks the user; resolves to the chosen option id, or undefined when dismissed. */
	readonly askPermission: (agentName: string, title: string, options: readonly PermissionOption[], signal: AbortSignal) => Promise<string | undefined>;
}

interface RoomSession {
	sessionId?: string;
	/** The process that holds this session; another one has to load it first. */
	peer?: JsonRpcPeer;
	/** How many transcript messages the session has already seen. */
	seen: number;
}

interface Connection {
	readonly peer: JsonRpcPeer;
	readonly ready: Promise<{ authMethods: AuthMethod[]; loadSession: boolean; agentName?: string }>;
}

/** Turns transcript messages into the text the agent reads, author by author. */
export function formatMessages(messages: readonly Message[], selfId: string, includeOwn = false): string {
	return messages
		.filter(m => includeOwn || !(m.author.kind === 'agent' && m.author.id === selfId))
		.map(m => m.author.kind === 'user' ? `[${m.author.name}]\n${m.text}`
			: m.author.kind === 'system' ? `[room] ${m.text}`
				: m.author.id === selfId ? `[you, earlier]\n${m.text}`
					: `[${m.author.name} (agent)]\n${m.text}`)
		.join('\n\n');
}

export const roomPreamble = (name: string) => `You are ${name} in an Arkestra room: a thread shared by the user and other AI agents. `
	+ 'Messages are labelled by author. Answer the latest user request, take the other agents\' messages into account, '
	+ 'and do not repeat what they already did.';

/** The line a tool call shows in the room. */
export function describeToolCall(call: { title?: string | null; kind?: string | null }): string {
	const title = (call.title ?? '').trim() || (call.kind ?? 'tool');
	return title.length > 80 ? `${title.slice(0, 77)}…` : title;
}

export class AcpAgent implements Agent {
	private connection: Connection | undefined;
	private readonly sessions = new Map<string, RoomSession>();
	/** Set when the agent refused a session for want of sign-in; readiness then says so. */
	private needsSignIn = false;
	private authMethods: AuthMethod[] = [];
	private readonly files: FileAccess;
	private readonly terminals: Terminals;
	/** Abort signals of the running turns per session, for permission prompts. */
	private readonly running = new Map<string, AbortSignal>();

	constructor(private readonly options: AcpOptions) {
		this.files = options.files ?? localFiles;
		this.terminals = new Terminals(options.spawn ?? nodeSpawn, !!options.remote);
	}

	get id(): string { return this.options.id; }
	get name(): string { return this.options.name; }
	get detail(): string { return `ACP · ${this.options.where}`; }

	/** Sign-in methods the agent offered, when it asked for sign-in. */
	get signInMethods(): readonly AuthMethod[] { return this.authMethods; }

	async readiness(): Promise<Readiness> {
		try {
			await this.connect();
		} catch (e: any) {
			if (e?.code === 'ENOENT' || /not found|No such file/i.test(e?.message ?? '')) {
				return { ready: false, reason: `${this.options.command} not found`, fix: 'install' };
			}
			return { ready: false, reason: e instanceof Error ? e.message : String(e), fix: 'retry' };
		}
		if (this.needsSignIn) {
			return { ready: false, reason: `${this.name} is not signed in`, fix: 'signIn' };
		}
		return { ready: true };
	}

	/** Signs in with one of the agent's own methods (ACP `authenticate`). */
	async authenticate(methodId: string): Promise<void> {
		const { peer } = await this.connect();
		await peer.request('authenticate', { methodId });
		this.needsSignIn = false;
	}

	async turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
		const { peer, info } = await this.connect();
		const room = this.sessions.get(input.roomId) ?? { seen: 0 };
		const cwd = await this.options.cwd();

		if (room.sessionId && room.peer !== peer) {
			// The agent restarted: load the room's session if it can, otherwise start over.
			if (info.loadSession) {
				// The history it replays is already in the room; no turn listens to it.
				await peer.request('session/load', { sessionId: room.sessionId, cwd, mcpServers: [] })
					.then(() => { room.peer = peer; })
					.catch(() => { room.sessionId = undefined; room.seen = 0; });
			} else {
				room.sessionId = undefined;
				room.seen = 0;
			}
		}
		const fresh = !room.sessionId;
		if (fresh) {
			try {
				const created = await peer.request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] });
				room.sessionId = created.sessionId;
				room.peer = peer;
				room.seen = 0;
			} catch (e) {
				if (e instanceof RpcError && e.code === AUTH_REQUIRED) {
					this.needsSignIn = true;
					this.authMethods = info.authMethods;
					throw new Error(`${this.name} is not signed in`);
				}
				throw e;
			}
		}
		const sessionId = room.sessionId!;
		const transcript = formatMessages(input.transcript.slice(room.seen), this.id, fresh);
		const text = fresh ? `${roomPreamble(this.name)}\n\n${transcript}` : transcript;

		// Message chunks are collected and handed to the room as whole messages: when a tool
		// call starts, when the message id changes, and at the end of the turn.
		let message = '';
		let messageId: string | undefined;
		let sawText = false;
		const flush = () => {
			if (message.trim()) {
				onEvent({ kind: 'text', text: message.trim() });
				sawText = true;
			}
			message = '';
		};
		const subscription = peer.onNotification((n: Notification) => {
			if (n.method !== 'session/update' || n.params?.sessionId !== sessionId) {
				return;
			}
			const update = n.params.update ?? {};
			switch (update.sessionUpdate) {
				case 'agent_message_chunk':
					if (update.messageId && messageId && update.messageId !== messageId) {
						flush();
					}
					messageId = update.messageId ?? messageId;
					if (update.content?.type === 'text' && typeof update.content.text === 'string') {
						message += update.content.text;
					}
					break;
				case 'tool_call':
					flush();
					onEvent({ kind: 'tool', text: describeToolCall(update) });
					break;
				case 'tool_call_update':
					if (update.status === 'failed') {
						onEvent({ kind: 'tool', text: `${describeToolCall(update)} · failed` });
					}
					break;
			}
		});
		const cancel = () => peer.notify('session/cancel', { sessionId });
		signal.addEventListener('abort', cancel);
		this.running.set(sessionId, signal);
		try {
			const result = await peer.request<{ stopReason: string }>('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
			flush();
			if (result.stopReason === 'refusal') {
				onEvent({ kind: 'error', text: `${this.name} refused this request` });
			} else if (result.stopReason === 'max_tokens' || result.stopReason === 'max_turn_requests') {
				onEvent({ kind: 'error', text: `${this.name} stopped: ${result.stopReason.replace(/_/g, ' ')}` });
			}
			// The session now holds the whole transcript, and the agent's answer if the room records one.
			room.seen = input.transcript.length + (sawText && !signal.aborted ? 1 : 0);
			this.sessions.set(input.roomId, room);
		} catch (e) {
			flush();
			if (signal.aborted) {
				room.seen = input.transcript.length;
				this.sessions.set(input.roomId, room);
				return;
			}
			throw e;
		} finally {
			signal.removeEventListener('abort', cancel);
			this.running.delete(sessionId);
			subscription.dispose();
		}
	}

	dispose(): void {
		this.terminals.dispose();
		this.connection?.peer.dispose();
		this.connection = undefined;
	}

	private async connect(): Promise<{ peer: JsonRpcPeer; info: Awaited<Connection['ready']> }> {
		if (this.connection && !this.connection.peer.closed) {
			return { peer: this.connection.peer, info: await this.connection.ready };
		}
		const spawn = this.options.spawn ?? nodeSpawn;
		const child = spawn(this.options.command, [...this.options.args], {
			env: { ...process.env, ...this.options.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const peer = new JsonRpcPeer(child, this.options.command);
		this.serveClient(peer);
		const spawnError = new Promise<never>((_, reject) => child.once('error', reject));
		spawnError.catch(() => { });
		const ready = Promise.race([spawnError, (async () => {
			const result = await peer.request<any>('initialize', {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
				clientInfo: { name: 'arkestra', title: 'Arkestra', version: '0.1.0' },
			});
			if (typeof result?.protocolVersion === 'number' && result.protocolVersion > PROTOCOL_VERSION) {
				throw new Error(`${this.options.command} speaks ACP version ${result.protocolVersion}; Arkestra speaks ${PROTOCOL_VERSION}`);
			}
			const authMethods: AuthMethod[] = (Array.isArray(result?.authMethods) ? result.authMethods : [])
				.filter((m: any) => m && typeof m.id === 'string' && (m.type === undefined || m.type === 'agent'))
				.map((m: any) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, description: m.description }));
			return { authMethods, loadSession: !!result?.agentCapabilities?.loadSession, agentName: result?.agentInfo?.title ?? result?.agentInfo?.name };
		})()]);
		const connection: Connection = { peer, ready };
		this.connection = connection;
		try {
			return { peer, info: await ready };
		} catch (e) {
			peer.dispose();
			if (this.connection === connection) {
				this.connection = undefined;
			}
			throw e;
		}
	}

	/** The client side of ACP: files, terminals and permission. */
	private serveClient(peer: JsonRpcPeer): void {
		peer.serve('fs/read_text_file', async p => ({ content: sliceLines(await this.files.read(p.path), p.line, p.limit) }));
		peer.serve('fs/write_text_file', async p => { await this.files.write(p.path, p.content); return null; });
		peer.serve('terminal/create', p => this.terminals.create(p));
		peer.serve('terminal/output', p => this.terminals.output(p.terminalId));
		peer.serve('terminal/wait_for_exit', p => this.terminals.waitForExit(p.terminalId));
		peer.serve('terminal/kill', p => { this.terminals.kill(p.terminalId); return null; });
		peer.serve('terminal/release', p => { this.terminals.release(p.terminalId); return null; });
		peer.serve('session/request_permission', async p => {
			const signal = this.running.get(p.sessionId) ?? new AbortController().signal;
			if (signal.aborted) {
				return { outcome: { outcome: 'cancelled' } };
			}
			const options: PermissionOption[] = Array.isArray(p.options) ? p.options : [];
			const chosen = await this.options.askPermission(this.name, describeToolCall(p.toolCall ?? {}), options, signal);
			return chosen && !signal.aborted ? { outcome: { outcome: 'selected', optionId: chosen } } : { outcome: { outcome: 'cancelled' } };
		});
	}
}

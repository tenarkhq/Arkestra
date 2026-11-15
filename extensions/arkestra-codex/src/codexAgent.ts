/*---------------------------------------------------------------------------------------------
 *  Arkestra. Codex in a room through the user's own Codex CLI (`codex app-server`, the
 *  protocol the Codex IDE extension uses): ChatGPT login or API key. One Codex thread per
 *  room; each turn sends only what is new.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { Agent, AgentChoices, AgentEvent, ExistingSession, Message, PermissionRequest, Readiness, SessionEntry, SessionHistory, SessionMeta, TurnInput, Usage, WorkUpdate } from './rooms';
import { RpcClient, type Notification } from './rpc';
import { watchLocal as watchLocalStates, watchRemote as watchRemoteStates, type LiveState } from './liveStates';
import { LineSplitter, followLocal, followRemote } from './follow';
import { RolloutHistory, checkThreadId, codexImages, codexMeta, codexPiece, codexToolLine, codexUserText, latestTokenCountScript, localRollout, locateRolloutScript, readLocalRollout, readRolloutScript, rolloutLimits, type RolloutRead } from './codexFollow';

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
	/**
	 * The permission lists (AR22). While the machine or project has rules, Codex asks before
	 * commands it does not trust ("untrusted") and the lists answer, else the user; without
	 * rules it never asks and the sandbox alone limits it.
	 */
	readonly permissions?: {
		active(): boolean;
		ask(request: PermissionRequest, signal: AbortSignal): Promise<'allow' | 'deny' | undefined>;
	};
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
	/** The shared rules' version this session was given. */
	sharedVersion?: string;
	/** The thread's token totals at the last report, so a report adds only what is new. */
	tokens?: TokenBreakdown;
	/** The model and effort this thread was last told to use (Codex keeps an override for later turns). */
	override?: { model?: string; effort?: string };
	/** An adopted thread's folder (AR39): it goes on where it worked. */
	cwd?: string;
	/** An adopted thread (AR39): it is never swapped for a new one, the room shows that session. */
	adopted?: boolean;
}

/** A first message Arkestra wrote (`[Author]` and the text): that thread is already a room. */
const ARKESTRA_FIRST = /^\[[^\]\n]{1,60}\]\n/;

const isoTime = (t: unknown): string | undefined => typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t).toISOString()
	: typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined;

/** Codex's thread list (thread/list) as existing sessions, newest first; the rooms' own threads left out. */
export function codexSessions(data: unknown): ExistingSession[] {
	const list = Array.isArray((data as any)?.data) ? (data as any).data : [];
	return list.filter((t: any) => typeof t?.id === 'string' && !(typeof t.preview === 'string' && ARKESTRA_FIRST.test(t.preview))).map((t: any) => {
		const first = typeof t.preview === 'string' ? t.preview.trim().split('\n')[0].trim() : '';
		const title = first ? (first.length > 80 ? first.slice(0, 79).trimEnd() + '…' : first) : t.id.slice(0, 8);
		return { id: t.id, title, ...(typeof t.cwd === 'string' && t.cwd ? { cwd: t.cwd } : {}), updatedAt: isoTime(t.updatedAt) ?? isoTime(t.createdAt) ?? new Date(0).toISOString() };
	}).sort((a: ExistingSession, b: ExistingSession) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A Codex thread's turns as thread messages: what the user wrote and Codex's answers. */
export function codexHistory(thread: unknown, limit = 300): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const turn of Array.isArray((thread as any)?.turns) ? (thread as any).turns : []) {
		for (const item of Array.isArray(turn?.items) ? turn.items : []) {
			// The item ids are the rollout's own: the live follow (AR39) knows the same entries by them.
			const id = typeof item?.id === 'string' ? { id: item.id } : {};
			if (item?.type === 'userMessage') {
				const words = (Array.isArray(item.content) ? item.content : []).filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n').trim();
				const text = codexUserText(words, codexImages(item.content));
				if (text) {
					entries.push({ role: 'user', text, ...id });
				}
			} else if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
				const last = entries.at(-1);
				if (last?.role === 'agent') {
					entries[entries.length - 1] = { ...last, text: `${last.text}\n\n${item.text.trim()}` };
				} else {
					entries.push({ role: 'agent', text: item.text.trim(), ...id });
				}
			}
		}
	}
	return entries.slice(-limit);
}

type CodexModel = AgentChoices['models'][number] & { readonly isDefault?: boolean };

/** Codex's model list (model/list) as choices: visible models with their reasoning efforts. */
export function codexModels(data: unknown): CodexModel[] {
	const list = Array.isArray((data as any)?.data) ? (data as any).data : [];
	return list.filter((m: any) => !m?.hidden && (typeof m?.model === 'string' || typeof m?.id === 'string')).map((m: any) => ({
		id: m.model ?? m.id,
		label: m.displayName || m.model || m.id,
		...(m.description ? { detail: m.description } : {}),
		...(Array.isArray(m.supportedReasoningEfforts) && m.supportedReasoningEfforts.length ? { efforts: m.supportedReasoningEfforts.map((e: any) => e?.reasoningEffort ?? e).filter((e: unknown) => typeof e === 'string') } : {}),
		...(typeof m.defaultReasoningEffort === 'string' ? { defaultEffort: m.defaultReasoningEffort } : {}),
		...(m.isDefault ? { isDefault: true } : {}),
	}));
}

/**
 * What turn/start gets for the thread's choice. A choice taken back has to be undone by
 * sending the defaults, since Codex keeps an override for the following turns.
 */
export function modelOverride(want: { model?: string; effort?: string }, last: RoomThread['override'], models: readonly CodexModel[]): { model?: string; effort?: string } {
	const fallback = models.find(m => m.isDefault);
	const model = want.model ?? (last?.model ? fallback?.id : undefined);
	const of = models.find(m => m.id === (want.model ?? fallback?.id));
	const effort = want.effort ?? (last?.effort ? of?.defaultEffort : undefined);
	return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

interface TokenBreakdown {
	inputTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
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

/** Codex's plan (turn/plan/updated) as the agent's task list. */
export function codexPlan(plan: unknown): WorkUpdate {
	const status = (s: unknown) => s === 'completed' ? 'completed' : s === 'inProgress' ? 'in_progress' : 'pending';
	return { type: 'todos', items: (Array.isArray(plan) ? plan : []).filter((p: any) => typeof p?.step === 'string').map((p: any) => ({ text: p.step, status: status(p.status) })) };
}

/** Codex's sub-agents: spawned through collab tool calls, or reported as sub-agent activity. */
export function codexWork(item: any, completed: boolean): WorkUpdate[] {
	const out: WorkUpdate[] = [];
	const final = (s: unknown) => s === 'completed' || s === 'shutdown' ? true : s === 'errored' || s === 'interrupted' || s === 'notFound' ? false : undefined;
	if (item?.type === 'collabAgentToolCall') {
		const states: Record<string, { status?: string; message?: string | null }> = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
		if (item.tool === 'spawnAgent' && !completed) {
			for (const id of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
				out.push({ type: 'subagent', id: String(id), name: typeof item.model === 'string' && item.model ? item.model : 'sub-agent', ...(typeof item.prompt === 'string' ? { task: item.prompt.split('\n')[0] } : {}), status: 'running' });
			}
		}
		for (const [id, state] of Object.entries(states)) {
			const ok = final(state?.status);
			if (ok !== undefined) {
				out.push({ type: 'finished', id, ok, ...(state?.message ? { text: String(state.message) } : {}) });
			}
		}
	} else if (item?.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
		if (item.kind === 'started') {
			out.push({ type: 'subagent', id: item.agentThreadId, name: typeof item.agentPath === 'string' && item.agentPath ? item.agentPath : typeof item.model === 'string' ? item.model : 'sub-agent', status: 'running' });
		} else if (item.kind === 'completed' || item.kind === 'interrupted') {
			out.push({ type: 'finished', id: item.agentThreadId, ok: item.kind === 'completed' });
		}
	}
	return out;
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

/** The most of a turn's rollout lines read back for what Codex produced (AR26). */
const TURN_READ_MAX = 50_000_000;

export class CodexAgent implements Agent {
	readonly id: string;
	readonly name: string;
	private readonly where: string;
	private readonly threads = new Map<string, RoomThread>();
	private server: { client: RpcClient; authKey: string; ready: Promise<void> } | undefined;
	private models: { list: CodexModel[]; at: number } | undefined;
	/** The running turns' approval answers per thread (server requests carry the thread id). */
	private readonly approvals = new Map<string, (method: string, params: any) => Promise<unknown> | undefined>();
	/**
	 * 2: the rollout's model and context fill, and its patch lines for what Codex produced (AR26):
	 * threads read before read their rollout once more.
	 */
	readonly historyVersion = 3;

	constructor(private readonly options: CodexOptions) {
		({ id: this.id, name: this.name, where: this.where } = options.identity ?? { id: 'codex', name: 'Codex', where: 'local' });
	}

	get detail(): string {
		return `Codex${this.options.model ? ' · ' + this.options.model : ''} · ${this.where}`;
	}

	async choices(): Promise<AgentChoices> {
		return { models: await this.modelList() };
	}

	private async modelList(): Promise<CodexModel[]> {
		if (this.models && Date.now() - this.models.at < 10 * 60_000) {
			return this.models.list;
		}
		try {
			const client = await this.ensureServer(await this.options.auth());
			const list = codexModels(await client.request('model/list', {}));
			this.models = { list, at: Date.now() };
			return list;
		} catch {
			return this.models?.list ?? [];
		}
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

	/** The account's quota windows, from the newest rollout on the machine (Codex writes them with every token report). */
	async quota(): Promise<readonly { readonly label: string; readonly usedPercent: number; readonly resetsAt?: string }[]> {
		const script = latestTokenCountScript(['~/.codex', this.options.apiKeyHome]);
		const out = this.options.spawn ? await this.shell(script, 20_000) : await localShell(script, 20_000);
		return rolloutLimits(out.trim(), windowLabel);
	}

	/** Each thread's turn on this agent's machine, live, from its rollout file (the left bar's dots). */
	watchStates(onState: (s: LiveState) => void): { dispose(): void } {
		return this.options.spawn ? watchRemoteStates(this.options.spawn, ['~/.codex', this.options.apiKeyHome], onState) : watchLocalStates(this.localHomes(), onState);
	}

	/** The threads Codex has on this agent's machine (AR39). */
	async existingSessions(): Promise<readonly ExistingSession[]> {
		const client = await this.ensureServer(await this.options.auth());
		return codexSessions(await client.request('thread/list', { limit: 60 }));
	}

	/**
	 * A thread's messages from its rollout file, read as the live follow reads it (same ids, the
	 * room's own turns left out), with the cursor the follow goes on from. The server's own
	 * thread/read only when there is no file to read: Codex 0.163 gives no turns there.
	 */
	async sessionHistory(sessionId: string): Promise<SessionHistory> {
		checkThreadId(sessionId);
		const fromFile = await this.readRollout(sessionId, await this.rolloutPath(sessionId)).catch(() => undefined);
		if (fromFile?.entries.length) {
			return fromFile;
		}
		try {
			const client = await this.ensureServer(await this.options.auth());
			const read = await client.request<{ thread: unknown }>('thread/read', { threadId: sessionId, includeTurns: true })
				.catch(() => client.request<{ thread: unknown }>('thread/resume', { threadId: sessionId })); // an older Codex
			const entries = codexHistory(read?.thread);
			if (entries.length || !fromFile) {
				return { entries };
			}
		} catch (error) {
			if (!fromFile) {
				throw error;
			}
		}
		return fromFile; // a thread with nothing said yet: the follow starts after what is there
	}

	/** The Codex homes on this machine: the user's own, and the API-key one. */
	private localHomes(): string[] {
		return [process.env.CODEX_HOME || path.join(homedir(), '.codex'), this.options.apiKeyHome];
	}

	/** The thread's rollout file read whole, here or on the SSH machine; undefined: no such file. */
	private async readRollout(threadId: string, known: string | undefined): Promise<RolloutRead | undefined> {
		if (!this.options.spawn) {
			const file = known ?? await localRollout(this.localHomes(), threadId);
			return file ? readLocalRollout(file) : undefined;
		}
		const spawn = this.options.spawn;
		return new Promise((resolve, reject) => {
			const child = spawn('sh', ['-c', readRolloutScript(locateRolloutScript(threadId, known, ['~/.codex', this.options.apiKeyHome]))], { stdio: ['ignore', 'pipe', 'pipe'] });
			const history = new RolloutHistory();
			let err = '';
			const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 180_000);
			child.stdout?.on('data', (chunk: Buffer) => history.push(chunk));
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (c: string) => { err = (err + c).slice(-2000); });
			child.on('error', e => { clearTimeout(timer); reject(e); });
			child.on('close', code => {
				clearTimeout(timer);
				if (code === 0) {
					resolve(history.result());
				} else if (code === 3) {
					resolve(undefined);
				} else {
					reject(new Error(err.trim().split('\n').at(-1) || `could not read the rollout file (exit ${code})`));
				}
			});
		});
	}

	adoptSession(roomId: string, session: { readonly id: string; readonly cwd?: string }, seen: readonly string[]): void {
		const known = this.threads.get(roomId);
		if (!known) {
			// No server yet: the next turn resumes the thread first.
			this.threads.set(roomId, { threadId: session.id, seen: new Set(seen), adopted: true, ...(session.cwd ? { cwd: session.cwd } : {}) });
		} else if (known.threadId === session.id) {
			seen.forEach(id => known.seen.add(id)); // what came in live from the thread is in it already
		}
	}

	/** Follows a thread's rollout file live (AR39): here through the file system, on an SSH machine through `tail -F`. */
	watchSession(sessionId: string, onEntries: (entries: readonly SessionEntry[], cursor: string, meta?: SessionMeta, lines?: readonly string[]) => void, cursor?: string): { dispose(): void } {
		checkThreadId(sessionId);
		const options = { classify: codexPiece, meta: codexMeta, keep: codexToolLine, onEntries, ...(cursor !== undefined ? { cursor } : {}) };
		let known: Promise<string | undefined> | undefined;
		if (!this.options.spawn) {
			return followLocal(async () => await (known ??= this.rolloutPath(sessionId)) ?? localRollout(this.localHomes(), sessionId), options);
		}
		const spawn = this.options.spawn;
		let inner: { dispose(): void } | undefined;
		let disposed = false;
		void this.rolloutPath(sessionId).then(file => {
			if (!disposed) {
				inner = followRemote(spawn, locateRolloutScript(sessionId, file, ['~/.codex', this.options.apiKeyHome]), options);
			}
		});
		return { dispose: () => { disposed = true; inner?.dispose(); } };
	}

	/** Where Codex keeps the thread, as its server says (the path is on the agent's machine). */
	private async rolloutPath(threadId: string): Promise<string | undefined> {
		try {
			const client = await this.ensureServer(await this.options.auth());
			const read = await client.request<{ thread?: { path?: unknown } }>('thread/read', { threadId, includeTurns: false });
			return typeof read?.thread?.path === 'string' && read.thread.path ? read.thread.path : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Where the thread's rollout file ends now (a turn's own lines start there): its path and size;
	 * size 0 while there is none. A thread just started has no file yet: nothing is searched for.
	 */
	private async rolloutEnd(threadId: string, fresh: boolean): Promise<{ file?: string; size: number }> {
		if (fresh) {
			return { size: 0 };
		}
		const known = await this.rolloutPath(threadId);
		if (!this.options.spawn) {
			const file = known ?? await localRollout(this.localHomes(), threadId);
			const stat = file ? await fs.stat(file).catch(() => undefined) : undefined;
			return { ...(file ? { file } : {}), size: stat?.size ?? 0 };
		}
		const out = await this.shell([locateRolloutScript(threadId, known, ['~/.codex', this.options.apiKeyHome]), '[ -n "$f" ] && [ -f "$f" ] || exit 0', `printf '%s\\n%s' "$(wc -c < "$f" | tr -d ' ')" "$f"`].join('\n'), 60_000).catch(() => '');
		const [size, file] = out.split('\n');
		return { ...(file ? { file } : {}), size: Number(size) || 0 };
	}

	/** The patch lines (`codexToolLine`) the rollout file got after `from`: what a turn produced (AR26). */
	private async rolloutLinesFrom(threadId: string, known: string | undefined, from: number): Promise<string[]> {
		const splitter = new LineSplitter(from);
		const lines: string[] = [];
		const take = (chunk: Buffer) => { for (const l of splitter.push(chunk)) { if (codexToolLine(l.text)) { lines.push(l.text); } } };
		if (!this.options.spawn) {
			const file = known ?? await localRollout(this.localHomes(), threadId);
			const handle = file ? await fs.open(file, 'r').catch(() => undefined) : undefined;
			if (!handle) {
				return lines;
			}
			try {
				const { size } = await handle.stat();
				const end = Math.min(size, from + TURN_READ_MAX);
				for (let pos = from; pos < end;) {
					const buf = Buffer.alloc(Math.min(1 << 20, end - pos));
					const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
					if (!bytesRead) {
						break;
					}
					take(buf.subarray(0, bytesRead));
					pos += bytesRead;
				}
			} finally {
				await handle.close();
			}
			return lines;
		}
		const script = [locateRolloutScript(threadId, known, ['~/.codex', this.options.apiKeyHome]), '[ -n "$f" ] && [ -f "$f" ] || exit 0', `tail -c +${Math.floor(from) + 1} "$f" | head -c ${TURN_READ_MAX}`].join('\n');
		const spawn = this.options.spawn;
		await new Promise<void>(resolve => {
			const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
			const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
			child.stdout?.on('data', (chunk: Buffer) => take(chunk));
			child.on('error', () => { clearTimeout(timer); resolve(); });
			child.on('close', () => { clearTimeout(timer); resolve(); });
		});
		return lines;
	}

	/** A POSIX script on the SSH machine; resolves to its output. */
	private shell(script: string, timeoutMs: number): Promise<string> {
		const spawn = this.options.spawn!;
		return new Promise((resolve, reject) => {
			const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
			let out = '';
			const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (c: string) => { out += c; });
			child.on('error', e => { clearTimeout(timer); reject(e); });
			child.on('close', code => { clearTimeout(timer); if (code === 0) { resolve(out); } else { reject(new Error(`exited with ${code}`)); } });
		});
	}

	async turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
		const client = await this.ensureServer(await this.options.auth());
		const room = this.threads.get(input.roomId) ?? { seen: new Set<string>() };
		const threadParams = { cwd: input.cwd ?? room.cwd ?? this.options.cwd() ?? null, sandbox: this.options.sandbox, approvalPolicy: 'never', model: this.options.model ?? null };

		if (room.threadId && room.server !== client) {
			// The app-server restarted (crash, auth change): load the room's thread again.
			await client.request('thread/resume', { threadId: room.threadId, ...threadParams, excludeTurns: true })
				.then(() => { room.server = client; })
				.catch(error => {
					if (room.adopted) {
						// A thread continued from the machine goes on as that thread or not at all (AR39).
						throw new Error(`Could not resume the Codex session ${room.threadId}: ${error instanceof Error ? error.message : String(error)}`);
					}
					room.threadId = undefined; room.seen = new Set(); room.sharedVersion = undefined;
				});
		}
		const freshThread = !room.threadId;
		if (freshThread) {
			const started = await client.request<{ thread: { id: string } }>('thread/start', { ...threadParams, developerInstructions: ROOM_PREAMBLE });
			room.threadId = started.thread.id;
			room.server = client;
			room.seen = new Set(); room.sharedVersion = undefined;
		}
		const threadId = room.threadId!;
		// Where this turn's rollout lines will start: read back after it for what Codex produced (AR26).
		const rollout = await this.rolloutEnd(threadId, freshThread).catch(() => undefined);
		// A new thread also gets Codex's own earlier answers.
		const body = formatMessages(input.transcript.filter(m => !room.seen.has(m.id)), this.id, freshThread);
		const text = input.shared && room.sharedVersion !== input.shared.version ? `${input.shared.text}\n\n${body}` : body;

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
				if (n.method === 'account/rateLimits/updated') {
					const limits = codexLimits(n.params?.rateLimits);
					if (limits.length) {
						onEvent({ kind: 'usage', usage: { limits } });
					}
					return;
				}
				if (n.params?.threadId !== threadId) {
					return;
				}
				if (n.method === 'thread/tokenUsage/updated') {
					const usage = codexUsage(n.params.tokenUsage, room.tokens);
					room.tokens = n.params.tokenUsage?.total ?? room.tokens;
					if (usage) {
						onEvent({ kind: 'usage', usage });
					}
					return;
				}
				if (n.method === 'turn/plan/updated') {
					onEvent({ kind: 'work', work: codexPlan(n.params.plan) });
					return;
				}
				if (n.method === 'item/started' || n.method === 'item/completed') {
					for (const work of codexWork(n.params.item, n.method === 'item/completed')) {
						onEvent({ kind: 'work', work });
					}
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
			const ruled = !!this.options.permissions?.active();
			this.approvals.set(threadId, (method, params) => {
				const asked = this.approve(method, params, signal);
				if (asked) {
					// The Activity view shows that the agent waits for the user's answer.
					onEvent({ kind: 'work', work: { type: 'waiting', reason: method.includes('fileChange') ? 'asks to change files' : 'asks to run a command' } });
					void asked.finally(() => onEvent({ kind: 'work', work: { type: 'waiting' } })).catch(() => { });
				}
				return asked;
			});
			// The thread's model and effort (AR38); a choice taken back sends the defaults once.
			const override = input.model || input.effort || room.override?.model || room.override?.effort
				? modelOverride({ ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) }, room.override, await this.modelList())
				: {};
			const started = await client.request<{ turn: { id: string } }>('turn/start', {
				threadId, input: [{ type: 'text', text, text_elements: [] }],
				sandboxPolicy: sandboxPolicy(input.mode === 'plan' ? 'read-only' : this.options.sandbox),
				approvalPolicy: ruled ? 'untrusted' : 'never',
				...override,
			});
			room.override = { ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) };
			turnId = started.turn.id;
			if (signal.aborted) {
				interrupt();
			}
			const turn = await completed;
			if (signal.aborted || turn.status === 'interrupted') {
				input.transcript.forEach(m => room.seen.add(m.id));
				room.sharedVersion = input.shared?.version ?? room.sharedVersion;
				this.threads.set(input.roomId, room);
				return;
			}
			if (turn.status === 'failed') {
				throw new Error(turn.error?.message || lastError || 'Codex turn failed');
			}
			// The thread now holds the transcript it was given; its own answer is never sent back.
			input.transcript.forEach(m => room.seen.add(m.id));
			room.sharedVersion = input.shared?.version ?? room.sharedVersion;
			this.threads.set(input.roomId, room);
		} finally {
			this.approvals.delete(threadId);
			signal.removeEventListener('abort', interrupt);
			subscriptions.forEach(d => d.dispose());
			if (rollout) {
				// The rollout lines this turn wrote that add files (the turn's stream has no raw lines of its own).
				const lines = await this.rolloutLinesFrom(threadId, rollout.file ?? await this.rolloutPath(threadId), rollout.size).catch(() => [] as string[]);
				lines.forEach(line => onEvent({ kind: 'line', line }));
			}
		}
	}

	dispose(): void {
		this.server?.client.dispose();
		this.server = undefined;
	}

	/** A command or file change Codex asks about: the permission lists answer, else the user. */
	private approve(method: string, params: any, signal: AbortSignal): Promise<unknown> | undefined {
		const permissions = this.options.permissions;
		let request: PermissionRequest;
		if (method === 'item/commandExecution/requestApproval') {
			const command = typeof params?.command === 'string' ? params.command : '';
			request = { tool: 'Bash', command, title: command ? `Run: ${command}` : (params?.reason ?? 'Run a command') };
		} else if (method === 'item/fileChange/requestApproval') {
			request = { tool: 'Edit', ...(params?.grantRoot ? { path: params.grantRoot } : {}), title: params?.reason ?? 'Change files' };
		} else {
			return undefined;
		}
		if (!permissions) {
			return Promise.resolve({ decision: 'decline' });
		}
		return permissions.ask(request, signal).then(d => ({ decision: d === 'allow' ? 'accept' : 'decline' }));
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
		client.onRequest((method, params) => this.approvals.get(params?.threadId)?.(method, params));
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
			// `spawn codex ENOENT`: no Codex here; said in plain words (the SSH machine's own shell says 127).
			throw startProblem('Codex', e as { code?: unknown; exitCode?: unknown }, this.options.spawn ? this.where : undefined) ?? e;
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

/** A thread token report: what is new since the last one, and how full the context is. */
export function codexUsage(report: { total?: TokenBreakdown; last?: TokenBreakdown; modelContextWindow?: number | null } | undefined, before: TokenBreakdown | undefined): Usage | undefined {
	if (!report?.total) {
		return undefined;
	}
	const d = (k: keyof TokenBreakdown) => Math.max(0, (report.total![k] ?? 0) - (before?.[k] ?? 0));
	const used = report.last?.totalTokens;
	return {
		input: d('inputTokens') - d('cachedInputTokens'),
		cached: d('cachedInputTokens'),
		output: d('outputTokens'),
		...(used !== undefined ? { context: { used, ...(report.modelContextWindow ? { window: report.modelContextWindow } : {}) } } : {}),
	};
}

/** The account's quota windows from a rate limit snapshot. */
export function codexLimits(snapshot: any): { label: string; usedPercent: number; resetsAt?: string }[] {
	const out: { label: string; usedPercent: number; resetsAt?: string }[] = [];
	for (const w of [snapshot?.primary, snapshot?.secondary]) {
		if (w && typeof w.usedPercent === 'number') {
			out.push({ label: windowLabel(w.windowDurationMins), usedPercent: w.usedPercent, ...(typeof w.resetsAt === 'number' ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}) });
		}
	}
	return out;
}

/** A POSIX script on this machine; resolves to its output. */
function localShell(script: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = nodeSpawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
		let out = '';
		const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => { out += c; });
		child.on('error', e => { clearTimeout(timer); reject(e); });
		child.on('close', code => { clearTimeout(timer); if (code === 0) { resolve(out); } else { reject(new Error(`exited with ${code}`)); } });
	});
}

function windowLabel(minutes: number | null | undefined): string {
	if (!minutes) {
		return 'limit';
	}
	if (minutes % 10080 === 0) {
		return minutes === 10080 ? 'week' : `${minutes / 10080} weeks`;
	}
	if (minutes % 1440 === 0) {
		return `${minutes / 1440}d`;
	}
	return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

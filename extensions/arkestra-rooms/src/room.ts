/*---------------------------------------------------------------------------------------------
 *  Arkestra. A room: one thread that any number of agents share, joinable mid-run.
 *--------------------------------------------------------------------------------------------*/

import type { TemplateState } from './templates/types';
import type { BestRun } from './best';
import type { Agent, AgentEvent, AgentRegistry, ExistingSession, Readiness, SessionEntry, SessionHistory } from './agent';
import { artifactsFromSessionLines, mergeProduced, type ProducedArtifact } from './produced';

export type AuthorKind = 'user' | 'agent' | 'system';

export interface Author {
	readonly kind: AuthorKind;
	readonly id: string;
	readonly name: string;
}

export interface Message {
	readonly id: string;
	readonly at: string;
	readonly author: Author;
	readonly text: string;
	/** Agent ids this message is for (a template's instruction); absent: everyone. */
	readonly to?: readonly string[];
	/** The entry of an adopted session it came from (AR39): that agent's session holds it already. */
	readonly source?: { readonly agent: string; readonly entry: string };
}

export interface RoomState {
	readonly id: string;
	title: string;
	/** Project folder or repository the room belongs to, if any. */
	project?: string;
	/** Agent ids in the order they answer. */
	roster: string[];
	messages: Message[];
	/** Category the user filed the thread under, if any (left column). */
	category?: string;
	/** Pinned threads come first in their project. */
	pinned?: boolean;
	/** Archived threads leave the lists; the Archived group keeps them until restored or deleted. */
	archived?: boolean;
	/** A 2ARK template room's state (review, coding, audit), when the room runs one. */
	template?: TemplateState;
	/** Plan mode: the agents read and plan, nothing is changed until the user executes the plan. */
	mode?: 'plan';
	/** Best-of-N runs of this room (AR24). */
	best?: BestRun[];
	/** The model and effort chosen per agent in this thread (AR38). */
	choices?: Record<string, { model?: string; effort?: string }>;
	/**
	 * Existing CLI sessions this thread continues (AR39), per agent: the session, its folder, the
	 * last message imported from it (everything up to there the session already holds), and
	 * where the live follow goes on (the agent's own cursor).
	 */
	adopted?: Record<string, { readonly session: string; readonly cwd?: string; readonly upTo: string; readonly cursor?: string }>;
	/** What the agents produced with their tools (AR26): files they wrote, artifacts they published. */
	produced?: ProducedArtifact[];
}

export class AgentNotReadyError extends Error {
	constructor(readonly agentId: string, readonly readiness: Readiness) {
		super(`${agentId} is not ready: ${readiness.reason ?? 'unknown reason'}`);
	}
}

export type TurnSink = (agent: Agent, event: AgentEvent | { kind: 'start' } | { kind: 'end' }) => void;

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

export class Room {
	private readonly listeners = new Set<() => void>();
	/** Runs after every agent turn, before the next one starts (checkpoints, shared memory). */
	afterTurn?: (agent: Agent, reply: string) => Promise<void>;
	/** The shared rules and memory every agent gets (AR23). */
	shared?: () => Promise<{ text: string; version: string } | undefined>;

	constructor(readonly state: RoomState, private readonly registry: AgentRegistry, private readonly now: () => Date = () => new Date()) { }

	get id(): string { return this.state.id; }
	get messages(): readonly Message[] { return this.state.messages; }
	get roster(): readonly string[] { return this.state.roster; }

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	/**
	 * Adds an agent, also while another agent's turn is running: that turn is not
	 * stopped, and the newcomer answers in the running round with the whole thread.
	 */
	async invite(agentId: string): Promise<void> {
		const agent = this.registry.get(agentId);
		if (!agent) {
			throw new Error(`unknown agent: ${agentId}`);
		}
		if (this.state.roster.includes(agentId)) {
			return;
		}
		const readiness = await agent.readiness();
		if (!readiness.ready) {
			throw new AgentNotReadyError(agentId, readiness);
		}
		this.state.roster.push(agentId);
		this.append({ kind: 'system', id: 'room', name: 'Arkestra' }, `${agent.name} joined and received the thread from the beginning.`);
	}

	remove(agentId: string): void {
		const index = this.state.roster.indexOf(agentId);
		if (index >= 0) {
			this.state.roster.splice(index, 1);
			const agent = this.registry.get(agentId);
			this.append({ kind: 'system', id: 'room', name: 'Arkestra' }, `${agent?.name ?? agentId} left the room.`);
		}
	}

	/**
	 * Adds the user's message and runs one round: every agent in the roster (or
	 * only those in `to`) takes a turn in order with the full transcript. The
	 * roster is read live, so an agent invited during the round still answers.
	 */
	async say(text: string, sink: TurnSink, signal: AbortSignal, to?: readonly string[]): Promise<void> {
		this.append({ kind: 'user', id: 'user', name: 'You' }, text);
		const done = new Set<string>();
		for (let i = 0; i < this.state.roster.length; i++) {
			if (signal.aborted) {
				return;
			}
			const agentId = this.state.roster[i];
			if (done.has(agentId) || (to && to.length && !to.includes(agentId))) {
				continue;
			}
			done.add(agentId);
			const agent = this.registry.get(agentId);
			if (!agent) {
				continue;
			}
			await this.runTurn(agent, sink, signal);
		}
	}

	/** The user's message without a round: a template room routes it itself. */
	addUser(text: string): void {
		this.append({ kind: 'user', id: 'user', name: 'You' }, text);
	}

	/** A room line, for everyone or only for the agents in `to` (a template's instruction). */
	post(text: string, to?: readonly string[], name = 'Arkestra'): void {
		this.append({ kind: 'system', id: 'room', name }, text, to);
	}

	/** One turn of one agent with the transcript; resolves to what it wrote. */
	async turnOf(agentId: string, sink: TurnSink, signal: AbortSignal): Promise<string> {
		const agent = this.registry.get(agentId);
		if (!agent) {
			throw new Error(`unknown agent: ${agentId}`);
		}
		return this.runTurn(agent, sink, signal);
	}

	/**
	 * What an adopted session (AR39) wrote elsewhere since (a terminal, the vendor's app): new
	 * entries are appended, an answer that grew is updated in place, an entry the thread already
	 * has is not added again (by its id). The cursor is kept for the next follow.
	 */
	followed(agentId: string, entries: readonly SessionEntry[], cursor?: string, lines?: readonly string[]): void {
		const adopted = this.state.adopted?.[agentId];
		if (!adopted) {
			return;
		}
		const producedSome = !!lines?.length && this.produce(agentId, lines);
		const name = this.registry.get(agentId)?.name ?? this.state.messages.find(m => m.author.kind === 'agent' && m.author.id === agentId)?.author.name ?? agentId;
		const index = new Map<string, number>();
		this.state.messages.forEach((m, i) => { if (m.source?.agent === agentId) { index.set(m.source.entry, i); } });
		let changed = false;
		for (const e of entries) {
			const at = e.id ? index.get(e.id) : undefined;
			if (at !== undefined) {
				const old = this.state.messages[at];
				if (old.text !== e.text) {
					this.state.messages[at] = { ...old, text: e.text };
					changed = true;
				}
				continue;
			}
			const message = sessionMessage({ id: agentId, name }, e, this.now);
			this.state.messages.push(message);
			if (e.id) {
				index.set(e.id, this.state.messages.length - 1);
			}
			changed = true;
		}
		if (cursor !== undefined && cursor !== adopted.cursor) {
			this.state.adopted = { ...this.state.adopted, [agentId]: { ...adopted, cursor } };
			changed = true;
		}
		if (changed || producedSome) {
			this.touch();
		}
	}

	/** An agent's raw session or output lines: what it produced in them is kept (AR26). True: something new. */
	produce(agentId: string, lines: readonly string[]): boolean {
		const merged = mergeProduced(this.state.produced, artifactsFromSessionLines(lines, agentId));
		if (merged) {
			this.state.produced = merged;
		}
		return !!merged;
	}

	/** The room saved the template state in place; listeners save the room. */
	touch(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private async runTurn(agent: Agent, sink: TurnSink, signal: AbortSignal): Promise<string> {
		let reply = '';
		const lines: string[] = [];
		const shared = await this.shared?.().catch(() => undefined);
		sink(agent, { kind: 'start' });
		try {
			const adopted = this.state.adopted?.[agent.id];
			if (adopted && agent.adoptSession) {
				agent.adoptSession(this.id, { id: adopted.session, ...(adopted.cwd ? { cwd: adopted.cwd } : {}) }, seenBy(this.state.messages, agent.id, adopted.upTo));
			}
			const choice = this.state.choices?.[agent.id];
			await agent.turn({ roomId: this.id, transcript: [...this.state.messages], ...(this.state.mode === 'plan' ? { mode: 'plan' as const } : {}), ...(shared ? { shared } : {}), ...(choice?.model ? { model: choice.model } : {}), ...(choice?.effort ? { effort: choice.effort } : {}) }, event => {
				if (event.kind === 'line') {
					lines.push(event.line);
					return;
				}
				if (event.kind === 'text') {
					reply += reply ? `\n\n${event.text}` : event.text;
				}
				sink(agent, event);
			}, signal);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			sink(agent, { kind: 'error', text });
			reply += reply ? `\n\n[error] ${text}` : `[error] ${text}`;
		}
		sink(agent, { kind: 'end' });
		const producedSome = lines.length > 0 && this.produce(agent.id, lines);
		if (reply) {
			this.append({ kind: 'agent', id: agent.id, name: agent.name }, reply);
		} else if (producedSome) {
			this.touch();
		}
		await this.afterTurn?.(agent, reply).catch(() => undefined);
		return reply;
	}

	private append(author: Author, text: string, to?: readonly string[]): void {
		this.state.messages.push({ id: newId(), at: this.now().toISOString(), author, text, ...(to?.length ? { to: [...to] } : {}) });
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export function newRoomState(title: string, project?: string): RoomState {
	return { id: newId(), title, ...(project ? { project } : {}), roster: [], messages: [] };
}

/**
 * What an adopted session already holds: every message up to the later of the last one it came
 * with and the agent's own last answer (after an IDE restart the agent has to be told again).
 */
export function seenBy(messages: readonly Message[], agentId: string, upTo: string): string[] {
	let last = messages.findIndex(m => m.id === upTo);
	messages.forEach((m, i) => { if (m.author.kind === 'agent' && m.author.id === agentId) { last = Math.max(last, i); } });
	// What came in live from the session (AR39) is in it too, wherever it stands in the thread.
	return messages.filter((m, i) => i <= last || m.source?.agent === agentId).map(m => m.id);
}

/** One entry of an agent's session as a thread message, under its author. */
function sessionMessage(agent: { id: string; name: string }, e: SessionEntry, now: () => Date): Message {
	const at = e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : now().toISOString();
	const author: Author = e.role === 'user' ? { kind: 'user', id: 'user', name: 'You' } : e.role === 'system' ? { kind: 'system', id: 'system', name: agent.name } : { kind: 'agent', id: agent.id, name: agent.name };
	return { id: newId(), at, author, text: e.text, ...(e.id ? { source: { agent: agent.id, entry: e.id } } : {}) };
}

/** What an agent's sessionHistory gave: its entries, and the follow cursor when it has one (an older agent gives a list). */
export function sessionHistoryOf(read: readonly SessionEntry[] | SessionHistory | undefined): SessionHistory {
	if (Array.isArray(read)) {
		return { entries: read };
	}
	const h = read as SessionHistory | undefined;
	return { entries: h?.entries ?? [], ...(typeof h?.cursor === 'string' ? { cursor: h.cursor } : {}), ...(Array.isArray(h?.lines) ? { lines: h.lines.filter((l): l is string => typeof l === 'string') } : {}) };
}

/**
 * A thread that continues an existing CLI session (AR39): its messages, then the agent goes on
 * in it. The history's cursor is kept for the live follow, which then starts exactly after what
 * was imported; without one it starts at the session's end when the thread is first followed.
 */
export function importedRoomState(agent: { id: string; name: string }, session: ExistingSession, history: readonly SessionEntry[] | SessionHistory, project?: string, now: () => Date = () => new Date()): RoomState {
	const { entries, cursor, lines } = sessionHistoryOf(history);
	const state = newRoomState(session.title, project);
	const at = (e: SessionEntry) => e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : now().toISOString();
	state.roster.push(agent.id);
	state.messages.push({ id: newId(), at: entries[0] ? at(entries[0]) : now().toISOString(), author: { kind: 'system', id: 'system', name: 'Arkestra' }, text: `${agent.name} session continued here${session.cwd ? ` (${session.cwd})` : ''}.` });
	for (const e of entries) {
		state.messages.push(sessionMessage(agent, e, now));
	}
	state.adopted = { [agent.id]: { session: session.id, ...(session.cwd ? { cwd: session.cwd } : {}), upTo: state.messages.at(-1)!.id, ...(cursor !== undefined ? { cursor } : {}) } };
	const produced = lines?.length ? artifactsFromSessionLines(lines, agent.id) : [];
	if (produced.length) {
		state.produced = mergeProduced(undefined, produced);
	}
	return state;
}

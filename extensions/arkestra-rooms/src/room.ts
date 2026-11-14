/*---------------------------------------------------------------------------------------------
 *  Arkestra. A room: one thread that any number of agents share, joinable mid-run.
 *--------------------------------------------------------------------------------------------*/

import type { TemplateState } from './templates/types';
import type { BestRun } from './best';
import type { Agent, AgentEvent, AgentRegistry, ExistingSession, Readiness, SessionEntry } from './agent';

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
	/** A 2ARK template room's state (review, coding, audit), when the room runs one. */
	template?: TemplateState;
	/** Plan mode: the agents read and plan, nothing is changed until the user executes the plan. */
	mode?: 'plan';
	/** Best-of-N runs of this room (AR24). */
	best?: BestRun[];
	/** The model and effort chosen per agent in this thread (AR38). */
	choices?: Record<string, { model?: string; effort?: string }>;
	/**
	 * Existing CLI sessions this thread continues (AR39), per agent: the session, its folder, and
	 * the last message that came from it (everything up to there the session already holds).
	 */
	adopted?: Record<string, { readonly session: string; readonly cwd?: string; readonly upTo: string }>;
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

	/** The room saved the template state in place; listeners save the room. */
	touch(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private async runTurn(agent: Agent, sink: TurnSink, signal: AbortSignal): Promise<string> {
		let reply = '';
		const shared = await this.shared?.().catch(() => undefined);
		sink(agent, { kind: 'start' });
		try {
			const adopted = this.state.adopted?.[agent.id];
			if (adopted && agent.adoptSession) {
				agent.adoptSession(this.id, { id: adopted.session, ...(adopted.cwd ? { cwd: adopted.cwd } : {}) }, seenBy(this.state.messages, agent.id, adopted.upTo));
			}
			const choice = this.state.choices?.[agent.id];
			await agent.turn({ roomId: this.id, transcript: [...this.state.messages], ...(this.state.mode === 'plan' ? { mode: 'plan' as const } : {}), ...(shared ? { shared } : {}), ...(choice?.model ? { model: choice.model } : {}), ...(choice?.effort ? { effort: choice.effort } : {}) }, event => {
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
		if (reply) {
			this.append({ kind: 'agent', id: agent.id, name: agent.name }, reply);
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
	return messages.slice(0, last + 1).map(m => m.id);
}

/** A thread that continues an existing CLI session (AR39): its messages, then the agent goes on in it. */
export function importedRoomState(agent: { id: string; name: string }, session: ExistingSession, entries: readonly SessionEntry[], project?: string, now: () => Date = () => new Date()): RoomState {
	const state = newRoomState(session.title, project);
	const at = (e: SessionEntry) => e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : now().toISOString();
	state.roster.push(agent.id);
	state.messages.push({ id: newId(), at: entries[0] ? at(entries[0]) : now().toISOString(), author: { kind: 'system', id: 'system', name: 'Arkestra' }, text: `${agent.name} session continued here${session.cwd ? ` (${session.cwd})` : ''}.` });
	for (const e of entries) {
		state.messages.push({ id: newId(), at: at(e), author: e.role === 'user' ? { kind: 'user', id: 'user', name: 'You' } : { kind: 'agent', id: agent.id, name: agent.name }, text: e.text });
	}
	state.adopted = { [agent.id]: { session: session.id, ...(session.cwd ? { cwd: session.cwd } : {}), upTo: state.messages.at(-1)!.id } };
	return state;
}

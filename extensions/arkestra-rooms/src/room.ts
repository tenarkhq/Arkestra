/*---------------------------------------------------------------------------------------------
 *  Arkestra. A room: one thread that any number of agents share, joinable mid-run.
 *--------------------------------------------------------------------------------------------*/

import type { Agent, AgentEvent, AgentRegistry, Readiness } from './agent';

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
}

export interface RoomState {
	readonly id: string;
	title: string;
	/** Project folder or repository the room belongs to, if any. */
	project?: string;
	/** Agent ids in the order they answer. */
	roster: string[];
	messages: Message[];
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

	private async runTurn(agent: Agent, sink: TurnSink, signal: AbortSignal): Promise<void> {
		let reply = '';
		sink(agent, { kind: 'start' });
		try {
			await agent.turn({ roomId: this.id, transcript: [...this.state.messages] }, event => {
				if (event.kind === 'text') {
					reply += event.text;
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
	}

	private append(author: Author, text: string): void {
		this.state.messages.push({ id: newId(), at: this.now().toISOString(), author, text });
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export function newRoomState(title: string, project?: string): RoomState {
	return { id: newId(), title, ...(project ? { project } : {}), roster: [], messages: [] };
}

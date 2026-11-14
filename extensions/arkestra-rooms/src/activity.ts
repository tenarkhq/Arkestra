/*---------------------------------------------------------------------------------------------
 *  Arkestra. What each agent of a room is doing right now: the Agents tile shows it.
 *--------------------------------------------------------------------------------------------*/

export type AgentState = 'idle' | 'queued' | 'answering';

export interface AgentActivity {
	readonly state: AgentState;
	/** The last tool line of the running or last turn. */
	readonly tool?: string;
	/** The error of the last turn, if it ended with one. */
	readonly error?: string;
	/** When the state last changed (ISO). */
	readonly since: string;
}

/** Activity per room and agent; listeners hear every change. */
export class ActivityBoard {
	private readonly rooms = new Map<string, Map<string, AgentActivity>>();
	private readonly listeners = new Set<(roomId: string) => void>();

	constructor(private readonly now: () => Date = () => new Date()) { }

	onDidChange(listener: (roomId: string) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	get(roomId: string, agentId: string): AgentActivity {
		return this.rooms.get(roomId)?.get(agentId) ?? { state: 'idle', since: '' };
	}

	/** A round starts: these agents wait for their turn. */
	queue(roomId: string, agentIds: readonly string[]): void {
		for (const id of agentIds) {
			this.set(roomId, id, { state: 'queued' }, false);
		}
		this.fire(roomId);
	}

	start(roomId: string, agentId: string): void {
		this.set(roomId, agentId, { state: 'answering' });
	}

	tool(roomId: string, agentId: string, text: string): void {
		this.set(roomId, agentId, { ...this.get(roomId, agentId), tool: text });
	}

	error(roomId: string, agentId: string, text: string): void {
		this.set(roomId, agentId, { ...this.get(roomId, agentId), error: text });
	}

	end(roomId: string, agentId: string): void {
		const last = this.get(roomId, agentId);
		this.set(roomId, agentId, { state: 'idle', ...(last.tool ? { tool: last.tool } : {}), ...(last.error ? { error: last.error } : {}) });
	}

	/** The round ended or was cancelled: nobody is waiting or answering any more. */
	settle(roomId: string): void {
		for (const [id, a] of this.rooms.get(roomId) ?? []) {
			if (a.state !== 'idle') {
				this.set(roomId, id, { ...a, state: 'idle' }, false);
			}
		}
		this.fire(roomId);
	}

	private set(roomId: string, agentId: string, value: Omit<AgentActivity, 'since'> & { since?: string }, fire = true): void {
		let room = this.rooms.get(roomId);
		if (!room) {
			room = new Map();
			this.rooms.set(roomId, room);
		}
		const previous = room.get(agentId);
		// A new turn starts clean; within a turn tool and error accumulate.
		const fresh = value.state === 'answering' && previous?.state !== 'answering';
		room.set(agentId, {
			state: value.state,
			...(!fresh && value.tool ? { tool: value.tool } : {}),
			...(!fresh && value.error ? { error: value.error } : {}),
			since: previous?.state === value.state && previous.since ? previous.since : this.now().toISOString(),
		});
		if (fire) {
			this.fire(roomId);
		}
	}

	private fire(roomId: string): void {
		for (const listener of [...this.listeners]) {
			listener(roomId);
		}
	}
}

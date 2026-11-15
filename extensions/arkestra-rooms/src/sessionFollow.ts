/*---------------------------------------------------------------------------------------------
 *  Arkestra. A thread that continues a CLI session follows it live (AR39): what is written in
 *  that session elsewhere (a terminal, the vendor's app) comes into the thread while the room
 *  is loaded, and every view hears it through the room's change event. No VS Code.
 *--------------------------------------------------------------------------------------------*/

import type { Agent, AgentRegistry } from './agent';
import type { Room } from './room';

interface Watch {
	readonly agent: Agent;
	readonly session: string;
	readonly handle: { dispose(): void };
	readonly ready: Promise<void>;
}

export class SessionFollow {
	private readonly rooms = new Map<string, { room: Room; watches: Map<string, Watch> }>();
	private readonly registration: { dispose(): void };

	constructor(private readonly registry: AgentRegistry) {
		// An agent comes later (an SSH machine) or again (its settings changed): follow with it.
		this.registration = registry.onDidChange(() => this.rooms.forEach(r => this.sync(r)));
	}

	/** Follows the sessions this room continues, from where the last follow stopped. */
	attach(room: Room): void {
		if (!room.state.adopted || this.rooms.has(room.id)) {
			return;
		}
		const entry = { room, watches: new Map<string, Watch>() };
		this.rooms.set(room.id, entry);
		this.sync(entry);
	}

	/** The room's sessions changed (moved to another agent): follow what it continues now. */
	refresh(room: Room): void {
		const entry = this.rooms.get(room.id);
		if (entry) {
			this.sync(entry);
		} else {
			this.attach(room);
		}
	}

	detach(roomId: string): void {
		this.rooms.get(roomId)?.watches.forEach(w => w.handle.dispose());
		this.rooms.delete(roomId);
	}

	/** Resolves once every followed session of the room has caught up, or after `ms`. */
	async caughtUp(roomId: string, ms = 8000): Promise<void> {
		const watches = [...this.rooms.get(roomId)?.watches.values() ?? []];
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([Promise.all(watches.map(w => w.ready)), new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
		clearTimeout(timer);
	}

	private sync(entry: { room: Room; watches: Map<string, Watch> }): void {
		const adopted = entry.room.state.adopted ?? {};
		for (const [agentId, watch] of entry.watches) {
			if (this.registry.get(agentId) !== watch.agent || adopted[agentId]?.session !== watch.session) {
				watch.handle.dispose();
				entry.watches.delete(agentId);
			}
		}
		for (const [agentId, link] of Object.entries(adopted)) {
			const agent = this.registry.get(agentId);
			if (entry.watches.has(agentId) || !agent?.watchSession) {
				continue;
			}
			let caughtUp!: () => void;
			const ready = new Promise<void>(resolve => { caughtUp = resolve; });
			let live = true;
			try {
				// The cursor is read now: a follow started again goes on where the last one stopped.
				const watch = agent.watchSession(link.session, (entries, cursor, meta, lines) => {
					if (live) {
						entry.room.followed(agentId, entries, cursor, meta, lines);
					}
					caughtUp();
				}, link.cursor);
				entry.watches.set(agentId, { agent, session: link.session, ready, handle: { dispose: () => { live = false; watch.dispose(); } } });
			} catch {
				/* not a session this agent can follow */
			}
		}
	}

	dispose(): void {
		this.registration.dispose();
		[...this.rooms.keys()].forEach(id => this.detach(id));
	}
}

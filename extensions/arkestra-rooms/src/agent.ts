/*---------------------------------------------------------------------------------------------
 *  Arkestra. The contract every agent in a room fulfils, whatever its provider.
 *--------------------------------------------------------------------------------------------*/

import type { Message } from './room';

/** Why an agent cannot be invited right now, and what fixes it. */
export type ReadinessFix = 'install' | 'signIn' | 'quota' | 'retry';

export interface Readiness {
	readonly ready: boolean;
	/** Shown in the invite list when the agent is not ready. */
	readonly reason?: string;
	readonly fix?: ReadinessFix;
	/** What the user can do about it right there: sign in, set a key, open the install guide. */
	readonly actions?: readonly ReadinessAction[];
}

export interface ReadinessAction {
	readonly title: string;
	run(): Thenable<unknown> | Promise<unknown>;
}

export type AgentEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'tool'; readonly text: string }
	| { readonly kind: 'error'; readonly text: string }
	| { readonly kind: 'usage'; readonly usage: Usage }
	| { readonly kind: 'work'; readonly work: WorkUpdate };

/**
 * What an agent does beside its answer (AR37), as the vendors' desktop apps show it: its task
 * list, sub-agents, background commands, chapters, and when it waits for the user.
 * `finished` ends the sub-agent or background command with that id; `poll` says that a later
 * `finished` with this id reports the state of the background command `target`.
 */
export type WorkUpdate =
	| { readonly type: 'todos'; readonly items: readonly { readonly text: string; readonly status: 'pending' | 'in_progress' | 'completed' }[] }
	| { readonly type: 'subagent'; readonly id: string; readonly name: string; readonly task?: string; readonly status: 'running' | 'done' | 'error'; readonly result?: string }
	| { readonly type: 'background'; readonly id: string; readonly command: string; readonly status: 'running' | 'done' | 'error'; readonly output?: string }
	| { readonly type: 'finished'; readonly id: string; readonly ok: boolean; readonly text?: string }
	| { readonly type: 'poll'; readonly id: string; readonly target: string; readonly kill?: boolean }
	| { readonly type: 'chapter'; readonly title: string; readonly summary?: string }
	| { readonly type: 'waiting'; readonly reason?: string };

/** Token, context and quota figures an agent reports (AR25); every field is optional. */
export interface Usage {
	/** Tokens of this turn so far (increments: the room adds them up). */
	readonly input?: number;
	readonly output?: number;
	readonly cached?: number;
	/** How full the agent's context is now. */
	readonly context?: { readonly used: number; readonly window?: number };
	/** Cost of this turn in USD, when the agent knows it. */
	readonly costUsd?: number;
	/** The account's quota windows (for example 5 hours, a week): how much is used. */
	readonly limits?: readonly { readonly label: string; readonly usedPercent: number; readonly resetsAt?: string }[];
}


export interface TurnInput {
	readonly roomId: string;
	/** The whole thread from its first message, every author included. */
	readonly transcript: readonly Message[];
	/** 'plan': the room is in Plan mode; the agent may read but must not change anything. */
	readonly mode?: 'plan';
	/** The shared rules and memory (AR23): sent when a session has not seen this version yet. */
	readonly shared?: { readonly text: string; readonly version: string };
	/** The folder this turn works in, when not the project (a Best-of-N attempt's work tree). Local agents only. */
	readonly cwd?: string;
	/** The model and reasoning effort chosen for this agent in this thread (AR38); unset: the agent's own default. */
	readonly model?: string;
	readonly effort?: string;
}

export interface Agent {
	/** Stable id, unique in the registry, for example `claude` or `codex@dev-szerver`. */
	readonly id: string;
	readonly name: string;
	/** Provider and where it runs, for the invite list: `Claude Code · helyi`. */
	readonly detail: string;
	readiness(): Promise<Readiness>;
	/** One turn: reads the transcript, streams events, resolves when the turn ends. */
	turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void>;
	/** The models and efforts the user can choose from (AR38); an agent without it offers no choice. */
	choices?(): Promise<AgentChoices>;
	/** The sessions its CLI already has on its machine (AR39); an agent without it has none to offer. */
	existingSessions?(): Promise<readonly ExistingSession[]>;
	/** The messages of one of those sessions. */
	sessionHistory?(sessionId: string): Promise<readonly SessionEntry[]>;
	/**
	 * Binds the room to an existing session: the next turn continues it (in its folder) and sends
	 * only the messages not in `seen`. Does nothing while the room already has a session here.
	 */
	adoptSession?(roomId: string, session: { readonly id: string; readonly cwd?: string }, seen: readonly string[]): void;
	/**
	 * Follows one of those sessions live (it goes on in a terminal or the vendor's app): the
	 * entries appended (or an answer grown) after `cursor`, each with its id, and the cursor to
	 * go on from later. No cursor: from now on. The first call comes once it has caught up.
	 * The turns the room itself sent into the session are left out.
	 */
	watchSession?(sessionId: string, onEntries: (entries: readonly SessionEntry[], cursor: string) => void, cursor?: string): { dispose(): void };
}

/** A session the agent's own CLI already has on its machine (AR39): started in a terminal, an IDE, or earlier. */
export interface ExistingSession {
	readonly id: string;
	readonly title: string;
	/** The folder the session worked in, on the agent's machine. */
	readonly cwd?: string;
	/** ISO time of its last activity. */
	readonly updatedAt: string;
}

/** One message of an existing session, as the thread shows it. */
export interface SessionEntry {
	/** `system`: a short line of the session's own (a background task finished). */
	readonly role: 'user' | 'agent' | 'system';
	readonly text: string;
	readonly at?: string;
	/** Stable within the session: the same entry read again (or grown) has the same id. */
	readonly id?: string;
}

/** What an agent can run with: its models, each with the reasoning efforts it knows (none: no effort choice). */
export interface AgentChoices {
	readonly models: readonly { readonly id: string; readonly label: string; readonly detail?: string; readonly efforts?: readonly string[]; readonly defaultEffort?: string }[];
}

export interface InviteEntry {
	readonly agent: Agent;
	readonly readiness: Readiness;
}

/** Every agent Arkestra knows of. Adapters (Claude Code, Codex, OpenAI, ACP) register here. */
export class AgentRegistry {
	private readonly agents = new Map<string, Agent>();
	private readonly listeners = new Set<() => void>();

	/** Called when an agent comes or goes (a machine added or removed). */
	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	register(agent: Agent): { dispose(): void } {
		if (this.agents.has(agent.id)) {
			throw new Error(`agent already registered: ${agent.id}`);
		}
		this.agents.set(agent.id, agent);
		this.listeners.forEach(l => l());
		return { dispose: () => { this.agents.delete(agent.id); this.listeners.forEach(l => l()); } };
	}

	get(id: string): Agent | undefined {
		return this.agents.get(id);
	}

	/** Every registered agent. */
	all(): Agent[] {
		return [...this.agents.values()];
	}

	/** Every known agent with its readiness: ready ones first, each group by name. */
	async inviteList(exclude: readonly string[] = []): Promise<InviteEntry[]> {
		const candidates = [...this.agents.values()].filter(a => !exclude.includes(a.id));
		const entries = await Promise.all(candidates.map(async agent => {
			let readiness: Readiness;
			try {
				readiness = await agent.readiness();
			} catch (error) {
				readiness = { ready: false, reason: String(error instanceof Error ? error.message : error), fix: 'retry' };
			}
			return { agent, readiness };
		}));
		return entries.sort((a, b) =>
			Number(b.readiness.ready) - Number(a.readiness.ready) || a.agent.name.localeCompare(b.agent.name));
	}
}

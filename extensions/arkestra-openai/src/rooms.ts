/*---------------------------------------------------------------------------------------------
 *  Arkestra. The parts of the rooms contract this adapter uses (arkestra-rooms/src/agent.ts).
 *--------------------------------------------------------------------------------------------*/

export interface Message {
	readonly id: string;
	readonly at: string;
	readonly author: { readonly kind: 'user' | 'agent' | 'system'; readonly id: string; readonly name: string };
	readonly text: string;
	/** Agent ids this message is for (a template's instruction); absent: everyone. */
	readonly to?: readonly string[];
}

export interface Readiness {
	readonly ready: boolean;
	readonly reason?: string;
	readonly fix?: 'install' | 'signIn' | 'quota' | 'retry';
	readonly actions?: readonly { readonly title: string; run(): Thenable<unknown> | Promise<unknown> }[];
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
	readonly id: string;
	readonly name: string;
	readonly detail: string;
	readiness(): Promise<Readiness>;
	turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void>;
	/** The models and efforts the user can choose from (AR38); an agent without it offers no choice. */
	choices?(): Promise<AgentChoices>;
}

/** What an agent can run with: its models, each with the reasoning efforts it knows (none: no effort choice). */
export interface AgentChoices {
	readonly models: readonly { readonly id: string; readonly label: string; readonly detail?: string; readonly efforts?: readonly string[]; readonly defaultEffort?: string }[];
}

export interface ArkestraRoomsApi {
	registerAgent(agent: Agent): { dispose(): void };
}

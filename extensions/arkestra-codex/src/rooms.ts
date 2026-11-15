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
	readonly actions?: readonly {
		readonly title: string;
		readonly detail?: string;
		run(): Thenable<unknown> | Promise<unknown>;
		/** One secret the page asks for in its own password field (an API key), handed to `save` instead of `run` prompting. */
		readonly secret?: { readonly label: string; readonly placeholder?: string; save(value: string): Thenable<unknown> | Promise<unknown> };
	}[];
}

export type AgentEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'tool'; readonly text: string }
	| { readonly kind: 'error'; readonly text: string }
	| { readonly kind: 'usage'; readonly usage: Usage }
	| { readonly kind: 'work'; readonly work: WorkUpdate }
	/** One raw line of the agent's own output (stream-json, a rollout line), for what it produced with its tools (AR26). */
	| { readonly kind: 'line'; readonly line: string };

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
	/** The sessions its CLI already has on its machine (AR39); an agent without it has none to offer. */
	existingSessions?(): Promise<readonly ExistingSession[]>;
	/**
	 * The messages of one of those sessions. With a cursor (the one `watchSession` takes), the
	 * live follow goes on exactly after what was read, so nothing written in between is lost.
	 */
	sessionHistory?(sessionId: string): Promise<readonly SessionEntry[] | SessionHistory>;
	/** Goes up when the agent reads more out of its session files than before: older imports read again once. */
	readonly historyVersion?: number;
	/**
	 * Binds the room to an existing session: the next turn continues it (in its folder) and sends
	 * only the messages not in `seen`. Does nothing while the room already has a session here.
	 */
	adoptSession?(roomId: string, session: { readonly id: string; readonly cwd?: string }, seen: readonly string[]): void;
	/**
	 * Follows one of those sessions live: the entries appended (or an answer grown) after
	 * `cursor`, each with its id, and the cursor to go on from later. No cursor: from now on.
	 * `lines`: the session file's raw lines behind them that hold tool uses, for the artifacts (AR26).
	 */
	watchSession?(sessionId: string, onEntries: (entries: readonly SessionEntry[], cursor: string, meta?: SessionMeta, lines?: readonly string[]) => void, cursor?: string): { dispose(): void };
	/** The account's quota windows now (the share used of a week, of five hours), as its vendor's app shows them; none: not known. */
	quota?(): Promise<readonly { readonly label: string; readonly usedPercent: number; readonly resetsAt?: string }[]>;
	/** What a session's folder on the agent's machine has changed in git (files, added and removed lines; `?`: new), as the apps count it. */
	worktreeChanges?(cwd: string): Promise<readonly { readonly path: string; readonly added?: number; readonly removed?: number; readonly status: 'M' | '?' }[]>;
	/** Each session's turn on the agent's machine as it changes, live (whoever drives it); `at`: epoch seconds of its last write. */
	watchStates?(onState: (s: { readonly id: string; readonly state: 'run' | 'idle'; readonly at: number; readonly doing?: string; readonly bg?: readonly { readonly id: string; readonly name: string; readonly since: string }[]; readonly done?: number }) => void): { dispose(): void };
}

/** What an agent can run with: its models, each with the reasoning efforts it knows (none: no effort choice). */
/** A session the agent's own CLI already has on its machine (AR39): started in a terminal, an IDE, or earlier. */
export interface ExistingSession {
	readonly id: string;
	readonly title: string;
	/** The folder the session worked in, on the agent's machine. */
	readonly cwd?: string;
	/** ISO time of its last activity. */
	readonly updatedAt: string;
}

/** A session's messages as read, and where the live follow goes on from. */
export interface SessionHistory {
	readonly entries: readonly SessionEntry[];
	readonly cursor?: string;
	/** The session file's raw lines read that hold tool uses, for the artifacts (AR26). */
	readonly lines?: readonly string[];
	/** What the session file says about the session itself, when it says it. */
	readonly meta?: SessionMeta;
}

/** A session's model and context fill, as its file tells them (the latest model call). */
export interface SessionMeta {
	/** The model id of the latest answer, for example `claude-opus-5-5`. */
	readonly model?: string;
	/** Tokens in the context at the latest model call. */
	readonly context?: number;
	/** The size of that context window, when the file tells it (Codex does). */
	readonly window?: number;
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

export interface AgentChoices {
	readonly models: readonly { readonly id: string; readonly label: string; readonly detail?: string; readonly efforts?: readonly string[]; readonly defaultEffort?: string }[];
}

export interface ArkestraRoomsApi {
	registerAgent(agent: Agent): { dispose(): void };
	/** Absent in an older rooms extension. */
	readonly permissions?: PermissionsApi;
}

/** What an agent wants to do, in the permission rules' terms (`Bash`, `Edit`, `Read`, `WebFetch`, a tool name). */
export interface PermissionRequest {
	readonly tool: string;
	readonly command?: string;
	readonly path?: string;
	readonly url?: string;
	readonly title: string;
}

/** The rooms' permission lists per machine and project (AR22). */
export interface PermissionsApi {
	rules(machine: string): { readonly allow: readonly string[]; readonly deny: readonly string[] };
	decide(machine: string, request: PermissionRequest): 'allow' | 'deny' | undefined;
	ask(agentName: string, machine: string, request: PermissionRequest, signal: AbortSignal): Promise<'allow' | 'deny' | undefined>;
	requestFromAcp(toolCall: unknown): PermissionRequest;
	readonly onDidChange: (listener: () => void) => { dispose(): void };
}


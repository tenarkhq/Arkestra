/*---------------------------------------------------------------------------------------------
 *  Arkestra. The parts of the rooms contract this adapter uses (arkestra-rooms/src/agent.ts).
 *--------------------------------------------------------------------------------------------*/

export interface Message {
	readonly id: string;
	readonly at: string;
	readonly author: { readonly kind: 'user' | 'agent' | 'system'; readonly id: string; readonly name: string };
	readonly text: string;
}

export interface Readiness {
	readonly ready: boolean;
	readonly reason?: string;
	readonly fix?: 'install' | 'signIn' | 'quota' | 'retry';
}

export type AgentEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'tool'; readonly text: string }
	| { readonly kind: 'error'; readonly text: string };

export interface TurnInput {
	readonly roomId: string;
	readonly transcript: readonly Message[];
}

export interface Agent {
	readonly id: string;
	readonly name: string;
	readonly detail: string;
	readiness(): Promise<Readiness>;
	turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void>;
}

export interface ArkestraRoomsApi {
	registerAgent(agent: Agent): { dispose(): void };
}

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
	| { readonly kind: 'error'; readonly text: string };

export interface TurnInput {
	readonly roomId: string;
	/** The whole thread from its first message, every author included. */
	readonly transcript: readonly Message[];
	/** 'plan': the room is in Plan mode; the agent may read but must not change anything. */
	readonly mode?: 'plan';
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
}

export interface InviteEntry {
	readonly agent: Agent;
	readonly readiness: Readiness;
}

/** Every agent Arkestra knows of. Adapters (Claude Code, Codex, OpenAI, ACP) register here. */
export class AgentRegistry {
	private readonly agents = new Map<string, Agent>();

	register(agent: Agent): { dispose(): void } {
		if (this.agents.has(agent.id)) {
			throw new Error(`agent already registered: ${agent.id}`);
		}
		this.agents.set(agent.id, agent);
		return { dispose: () => { this.agents.delete(agent.id); } };
	}

	get(id: string): Agent | undefined {
		return this.agents.get(id);
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

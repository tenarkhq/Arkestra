/*---------------------------------------------------------------------------------------------
 *  Arkestra. Runs a template engine in a room: every delivery becomes an instruction for one
 *  agent in the thread, each agent works through its own queue (the two work in parallel,
 *  as in 2ARK), and every answer goes back to the engine.
 *--------------------------------------------------------------------------------------------*/

import type { AgentEvent } from '../agent';
import type { Room } from '../room';
import { TemplateEngine, type TemplateIO } from './engine';
import { other, type Role } from './signals';
import type { TemplateState } from './types';

export type RunEvent =
	| { readonly kind: 'start'; readonly role: Role; readonly name: string }
	| { readonly kind: 'agent'; readonly role: Role; readonly name: string; readonly event: AgentEvent }
	| { readonly kind: 'answer'; readonly role: Role; readonly name: string; readonly text: string }
	| { readonly kind: 'notice'; readonly text: string }
	| { readonly kind: 'wait'; readonly role: Role; readonly name: string; readonly question: string }
	| { readonly kind: 'end'; readonly reason: string }
	| { readonly kind: 'paused'; readonly reason: string }
	| { readonly kind: 'settled' };

export type RunOutcome = 'ended' | 'waiting' | 'paused' | 'idle';

export class TemplateRun {
	readonly engine: TemplateEngine;
	private readonly pending: Record<Role, boolean> = { A: false, B: false };
	private readonly running: Partial<Record<Role, Promise<void>>> = {};
	private readonly listeners = new Set<(e: RunEvent) => void>();
	private abort = new AbortController();
	private pausedWith: string | undefined;

	constructor(private readonly room: Room, readonly state: TemplateState, io: TemplateIO, private readonly onActivity?: (role: Role, agentId: string, event: AgentEvent | { kind: 'start' } | { kind: 'end' }) => void) {
		this.engine = new TemplateEngine(state, io, {
			deliver: (role, text) => {
				this.room.post(text, [state.members[role].id], `Arkestra → ${state.members[role].name}`);
				this.pending[role] = true;
				this.kick(role);
			},
			notice: text => {
				this.room.post(text);
				this.emit({ kind: 'notice', text });
			},
			wait: (role, question) => this.emit({ kind: 'wait', role, name: state.members[role].name, question }),
			end: reason => {
				this.room.post(`Vége: ${reason}`);
				this.emit({ kind: 'end', reason });
			},
			changed: () => {
				this.room.state.template = state;
				this.room.touch();
			},
		});
	}

	get busy(): boolean {
		return !!(this.running.A || this.running.B);
	}

	get paused(): string | undefined {
		return this.pausedWith;
	}

	on(listener: (e: RunEvent) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	/** Resolves when no agent works or waits for a turn: why it stopped. */
	settled(): Promise<RunOutcome> {
		if (!this.busy) {
			return Promise.resolve(this.outcome());
		}
		return new Promise(resolve => {
			const sub = this.on(e => {
				if (e.kind === 'settled') {
					sub.dispose();
					resolve(this.outcome());
				}
			});
		});
	}

	/** Stops the running turns; the room keeps its state, and the user's next word resumes it. */
	pause(reason: string): void {
		this.pausedWith = reason;
		this.abort.abort();
		this.emit({ kind: 'paused', reason });
	}

	/** Clears a pause before the user's word or Continue goes to the engine. */
	unpause(): void {
		if (this.abort.signal.aborted) {
			this.abort = new AbortController();
		}
		this.pausedWith = undefined;
	}

	/** Mentions of the members (@Codex) in the user's text: who it is for. */
	addressed(text: string): Role[] {
		const roles: Role[] = [];
		for (const role of ['A', 'B'] as Role[]) {
			const name = this.state.members[role].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			if (new RegExp(`(^|[^\\p{L}\\p{N}_@])@${name}`, 'iu').test(text)) {
				roles.push(role);
			}
		}
		return roles;
	}

	private outcome(): RunOutcome {
		if (this.state.ended) {
			return 'ended';
		}
		if (this.pausedWith) {
			return 'paused';
		}
		return Object.keys(this.state.waiting).length ? 'waiting' : 'idle';
	}

	private emit(e: RunEvent): void {
		for (const listener of [...this.listeners]) {
			listener(e);
		}
	}

	private kick(role: Role): void {
		if (this.running[role] || this.pausedWith) {
			return;
		}
		const member = this.state.members[role];
		this.running[role] = (async () => {
			try {
				while (this.pending[role] && !this.pausedWith) {
					this.pending[role] = false;
					this.emit({ kind: 'start', role, name: member.name });
					const reply = await this.room.turnOf(member.id, (agent, event) => {
						this.onActivity?.(role, agent.id, event);
						if (event.kind !== 'start' && event.kind !== 'end') {
							this.emit({ kind: 'agent', role, name: member.name, event });
						}
					}, this.abort.signal);
					if (this.pausedWith) {
						break;
					}
					this.emit({ kind: 'answer', role, name: member.name, text: reply });
					if (!reply.trim() || /^\[error\]/.test(reply.trim())) {
						// An agent that failed or said nothing stops the room; the user's word resumes it.
						this.pause(reply.trim() ? `${member.name}: ${reply.trim().replace(/^\[error\]\s*/, '')}` : `${member.name} nem válaszolt.`);
						break;
					}
					await this.engine.answer(role, reply);
				}
			} catch (error) {
				this.pause(`${member.name}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				this.running[role] = undefined;
				if (!this.running[other(role)]) {
					this.emit({ kind: 'settled' });
				}
			}
		})();
	}
}

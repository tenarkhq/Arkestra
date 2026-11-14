/*---------------------------------------------------------------------------------------------
 *  Arkestra. Rooms working on a task (AR30): which issue or PR a room works on, where it
 *  stands, and its progress list. The project views show this beside the task. No VS Code
 *  here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import type { RoomState } from './room';

/** A room working on a task, as the project views see it. */
export interface TaskRoom {
	readonly roomId: string;
	readonly title: string;
	/** The task references the room carries: `#41`, an issue or PR URL, `T27`. */
	readonly refs: readonly string[];
	readonly type: 'coding' | 'audit' | 'review' | 'chat';
	/** running: an agent is answering; waiting: it waits for the user; idle; ended. */
	readonly status: 'running' | 'waiting' | 'idle' | 'ended';
	/** A short line: `coding`, `slice plan waits for approval`, `verifying`, the reason it ended. */
	readonly phase: string;
	readonly agents: number;
	/** Ticked and all items of the room's progress list (haladas.md), when it has one. */
	readonly progress?: { readonly done: number; readonly total: number };
}

const REF = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+|(?<![\w/])#\d+\b/g;

/** The task references of a room: its template's issue or document, and those in its title. */
export function taskRefs(state: RoomState): string[] {
	const refs = new Set<string>();
	const t = state.template;
	for (const text of [t?.code?.issue, t?.review?.source, state.title]) {
		for (const m of (text ?? '').match(REF) ?? []) {
			refs.add(m);
		}
	}
	if (t?.code?.issue && /^T\d+/.test(t.code.issue)) {
		refs.add(t.code.issue);
	}
	return [...refs];
}

/** Where a room stands. */
export function roomPhase(state: RoomState, busy: boolean): Pick<TaskRoom, 'status' | 'phase' | 'type'> {
	const t = state.template;
	if (!t) {
		return { type: 'chat', status: busy ? 'running' : 'idle', phase: busy ? 'answering' : 'thread' };
	}
	if (t.ended) {
		return { type: t.type, status: 'ended', phase: t.ended };
	}
	const waiting = Object.values(t.waiting ?? {}).filter(Boolean);
	const phase = t.type === 'coding'
		? t.code?.planState === 'waiting' ? 'slice plan waits for approval' : t.code?.verifying ? 'verifying' : 'coding'
		: t.type === 'audit'
			? ({ audit: 'auditing', merge: 'merging the audits', approval: 'findings wait for approval', fix: 'fixing', verify: 'verifying the fixes', fixed: 'fixed', closed: 'closed' } as Record<string, string>)[t.audit?.phase ?? 'audit'] ?? 'auditing'
			: t.review?.version ? `review · v${t.review.version}` : 'review';
	if (t.pending) {
		return { type: t.type, status: 'waiting', phase: `round limit reached · ${phase}` };
	}
	return { type: t.type, status: busy ? 'running' : waiting.length ? 'waiting' : 'idle', phase: waiting.length && !busy ? `waits for you · ${phase}` : phase };
}

/** Ticked and all checklist items of a Markdown progress list (`- [x]` / `- [ ]`). */
export function progressFromMarkdown(text: string): { done: number; total: number } | undefined {
	let done = 0;
	let total = 0;
	for (const line of text.split('\n')) {
		const m = /^\s*[-*+]\s+\[([ xX])\]/.exec(line);
		if (m) {
			total++;
			if (m[1] !== ' ') {
				done++;
			}
		}
	}
	return total ? { done, total } : undefined;
}

/** The task rooms among all rooms: those with a task reference. */
export function taskRooms(states: readonly RoomState[], busy: (id: string) => boolean, progress: (id: string) => { done: number; total: number } | undefined): TaskRoom[] {
	const out: TaskRoom[] = [];
	for (const state of states) {
		const refs = taskRefs(state);
		if (!refs.length) {
			continue;
		}
		const p = progress(state.id);
		out.push({ roomId: state.id, title: state.title, refs, agents: state.roster.length, ...roomPhase(state, busy(state.id)), ...(p ? { progress: p } : {}) });
	}
	return out;
}

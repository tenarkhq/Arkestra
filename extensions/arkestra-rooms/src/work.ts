/*---------------------------------------------------------------------------------------------
 *  Arkestra. An agent's work beside its answer (AR37): task list, sub-agents, background
 *  commands, chapters, waiting for the user; and the turn's state, as the vendors' desktop
 *  apps show them. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import type { WorkUpdate } from './agent';

export interface WorkItem {
	readonly id: string;
	readonly name: string;
	readonly detail?: string;
	readonly status: 'running' | 'done' | 'error';
	readonly result?: string;
	readonly since: string;
	readonly ended?: string;
}

export interface AgentWork {
	readonly todos: readonly { readonly text: string; readonly status: 'pending' | 'in_progress' | 'completed' }[];
	readonly subagents: readonly WorkItem[];
	readonly background: readonly WorkItem[];
	readonly chapters: readonly { readonly title: string; readonly summary?: string; readonly at: string }[];
	/** Why the agent waits for the user now, if it does. */
	readonly waiting?: string;
	/** Poll ids → the background command they report on (and whether they stop it). */
	readonly polls: Readonly<Record<string, { readonly target: string; readonly kill?: boolean }>>;
	/** Background commands' own ids (the shell id an agent gives back) → our item id. */
	readonly aliases: Readonly<Record<string, string>>;
}

export const EMPTY_WORK: AgentWork = { todos: [], subagents: [], background: [], chapters: [], polls: {}, aliases: {} };

const KEEP = 30;
const short = (text: string | undefined, n = 400) => text === undefined ? undefined : text.length > n ? text.slice(0, n - 1) + '…' : text;

function upsert(list: readonly WorkItem[], item: WorkItem): WorkItem[] {
	const at = list.findIndex(x => x.id === item.id);
	const next = at < 0 ? [...list, item] : list.map((x, i) => i === at ? { ...x, ...item, since: x.since } : x);
	// Finished ones beyond the limit go first; running ones always stay.
	while (next.length > KEEP) {
		const old = next.findIndex(x => x.status !== 'running');
		if (old < 0) {
			break;
		}
		next.splice(old, 1);
	}
	return next;
}

/** A background command's state in a poll's answer: `<status>completed</status>`, `status: running`, an exit code. */
export function polledStatus(text: string): 'running' | 'done' | 'error' | undefined {
	const s = /<status>\s*(\w+)\s*<\/status>/i.exec(text)?.[1] ?? /\bstatus:\s*(\w+)/i.exec(text)?.[1];
	if (s) {
		return /^(running|pending|in_?progress)$/i.test(s) ? 'running' : /^(failed|error|killed|errored)$/i.test(s) ? 'error' : 'done';
	}
	const code = /<exit_code>\s*(-?\d+)\s*<\/exit_code>|exit code:?\s*(-?\d+)/i.exec(text);
	return code ? (Number(code[1] ?? code[2]) === 0 ? 'done' : 'error') : undefined;
}

export function applyWork(work: AgentWork, u: WorkUpdate, now: string): AgentWork {
	switch (u.type) {
		case 'todos':
			return { ...work, todos: u.items.slice(0, 50).map(i => ({ text: short(i.text, 200)!, status: i.status })) };
		case 'subagent':
			return { ...work, subagents: upsert(work.subagents, { id: u.id, name: u.name, ...(u.task ? { detail: short(u.task, 200) } : {}), status: u.status, ...(u.result ? { result: short(u.result) } : {}), since: now, ...(u.status !== 'running' ? { ended: now } : {}) }) };
		case 'background':
			return { ...work, background: upsert(work.background, { id: u.id, name: short(u.command, 200)!, status: u.status, ...(u.output ? { result: short(u.output) } : {}), since: now, ...(u.status !== 'running' ? { ended: now } : {}) }) };
		case 'poll':
			return { ...work, polls: { ...work.polls, [u.id]: { target: u.target, ...(u.kill ? { kill: true } : {}) } } };
		case 'chapter':
			return { ...work, chapters: [...work.chapters, { title: short(u.title, 120)!, ...(u.summary ? { summary: short(u.summary, 300) } : {}), at: now }].slice(-KEEP) };
		case 'waiting':
			return u.reason ? { ...work, waiting: u.reason } : (({ waiting: _w, ...rest }) => rest)(work);
		case 'finished': {
			const sub = work.subagents.find(s => s.id === u.id);
			if (sub) {
				return { ...work, subagents: upsert(work.subagents, { ...sub, status: u.ok ? 'done' : 'error', ...(u.text ? { result: short(u.text) } : {}), ended: now }) };
			}
			const bg = work.background.find(b => b.id === u.id);
			if (bg) {
				// The first answer to a background command only says it started, with the shell's id.
				const started = /running in (the )?background/i.test(u.text ?? '');
				const shell = /\bID:?\s*([\w-]+)/i.exec(u.text ?? '')?.[1];
				if (started && u.ok) {
					return { ...work, ...(shell ? { aliases: { ...work.aliases, [shell]: bg.id } } : {}), background: upsert(work.background, { ...bg, status: 'running' }) };
				}
				return { ...work, background: upsert(work.background, { ...bg, status: u.ok ? 'done' : 'error', ...(u.text ? { result: short(u.text) } : {}), ended: now }) };
			}
			const poll = work.polls[u.id];
			if (poll) {
				const { [u.id]: _done, ...polls } = work.polls;
				const id = work.aliases[poll.target] ?? poll.target;
				const target = work.background.find(b => b.id === id);
				if (!target) {
					return { ...work, polls };
				}
				const status = poll.kill ? (u.ok ? 'done' : target.status) : polledStatus(u.text ?? '') ?? target.status;
				return { ...work, polls, background: upsert(work.background, { ...target, status, ...(u.text && !poll.kill ? { result: short(u.text) } : {}), ...(status !== 'running' ? { ended: now } : {}) }) };
			}
			return work;
		}
	}
}

/** A new turn: the waiting reason belongs to the last turn; the task list, sub-agents and background work go on. */
export function newTurn(work: AgentWork): AgentWork {
	return (({ waiting: _w, ...rest }) => rest)(work);
}

export type TurnState = 'working' | 'waiting' | 'queued' | 'done' | 'error' | 'idle';

export function turnState(state: 'idle' | 'queued' | 'answering', work: AgentWork | undefined, error: string | undefined, hasRun: boolean): TurnState {
	if (state === 'answering') {
		return work?.waiting ? 'waiting' : 'working';
	}
	if (state === 'queued') {
		return 'queued';
	}
	return error ? 'error' : hasRun ? 'done' : 'idle';
}

export const TURN_TEXT: Record<TurnState, string> = { working: 'working', waiting: 'waits for you', queued: 'waiting for its turn', done: 'done', error: 'error', idle: 'idle' };

/** Totals over many agents: for the status bar and the Activity view's title. */
export function workTotals(list: readonly { state: TurnState; work?: AgentWork }[]): { working: number; waiting: number; background: number; subagents: number; errors: number } {
	let working = 0, waiting = 0, background = 0, subagents = 0, errors = 0;
	for (const a of list) {
		working += a.state === 'working' ? 1 : 0;
		waiting += a.state === 'waiting' ? 1 : 0;
		errors += a.state === 'error' ? 1 : 0;
		background += a.work?.background.filter(b => b.status === 'running').length ?? 0;
		subagents += a.work?.subagents.filter(s => s.status === 'running').length ?? 0;
	}
	return { working, waiting, background, subagents, errors };
}

export function totalsText(t: ReturnType<typeof workTotals>): string {
	return [
		t.working ? `${t.working} working` : '',
		t.waiting ? `${t.waiting} waiting for you` : '',
		t.subagents ? `${t.subagents} sub-agent${t.subagents === 1 ? '' : 's'}` : '',
		t.background ? `${t.background} in the background` : '',
		t.errors ? `${t.errors} error${t.errors === 1 ? '' : 's'}` : '',
	].filter(Boolean).join(' · ') || 'nothing running';
}

/** The work part of an agent's card in the Agents tile: task list, sub-agents, background, chapters. */
export function workHtml(work: AgentWork | undefined, esc: (s: string) => string): string {
	if (!work) {
		return '';
	}
	const parts: string[] = [];
	if (work.waiting) {
		parts.push(`<div class="wait">⏸ ${esc(work.waiting)}</div>`);
	}
	if (work.todos.length) {
		const done = work.todos.filter(t => t.status === 'completed').length;
		const icon = (s: string) => s === 'completed' ? '✓' : s === 'in_progress' ? '▸' : '○';
		parts.push(`<details class="work"${work.todos.some(t => t.status !== 'completed') ? ' open' : ''}><summary>Tasks ${done}/${work.todos.length}</summary><ul>${work.todos.map(t => `<li class="todo ${t.status}">${icon(t.status)} ${esc(t.text)}</li>`).join('')}</ul></details>`);
	}
	const items = (title: string, list: readonly WorkItem[]) => {
		if (!list.length) {
			return;
		}
		const running = list.filter(i => i.status === 'running').length;
		parts.push(`<details class="work"${running ? ' open' : ''}><summary>${esc(title)} · ${running ? `${running} running` : 'all finished'}</summary><ul>${[...list].reverse().slice(0, 8).map(i =>
			`<li class="item ${i.status}" title="${esc(i.result ?? '')}"><span class="st">${i.status === 'running' ? '●' : i.status === 'done' ? '✓' : '✕'}</span> ${esc(i.name)}${i.detail ? ` <span class="mut">· ${esc(i.detail)}</span>` : ''}</li>`).join('')}</ul></details>`);
	};
	items('Sub-agents', work.subagents);
	items('Background', work.background);
	if (work.chapters.length) {
		parts.push(`<details class="work"><summary>Chapters · ${work.chapters.length}</summary><ol>${work.chapters.map(c => `<li title="${esc(c.summary ?? '')}">${esc(c.title)}</li>`).join('')}</ol></details>`);
	}
	return parts.join('');
}

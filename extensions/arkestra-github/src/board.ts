/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Board and Table views' model (AR30): columns from the project's Status field,
 *  cards with the project's fields, prerequisites (blocked by), PRs with CI and review, and
 *  two columns of our own: the room running on the task and its progress. No VS Code here.
 *--------------------------------------------------------------------------------------------*/

import { valueText, type ProjectField, type ProjectItem, type ProjectSnapshot } from './project';
import type { JournalEntry, SyncStatus } from './sync';

/** A room working on a task, as the rooms extension reports it (its `TaskRoom`). */
export interface RoomInfo {
	readonly roomId: string;
	readonly title: string;
	readonly refs: readonly string[];
	readonly type: string;
	readonly status: 'running' | 'waiting' | 'idle' | 'ended';
	readonly phase: string;
	readonly agents: number;
	readonly progress?: { readonly done: number; readonly total: number };
}

export type Tone = 'ok' | 'bad' | 'run' | 'muted' | 'warn';

export interface CardField {
	readonly fieldId: string;
	readonly name: string;
	readonly value: string;
	/** The option or iteration id, for editing in the table. */
	readonly valueId?: string;
}

export interface Card {
	readonly id: string;
	readonly type: ProjectItem['type'];
	readonly number?: number;
	readonly url?: string;
	readonly repository?: string;
	readonly title: string;
	readonly state?: string;
	readonly labels: readonly string[];
	readonly assignees: readonly string[];
	readonly statusId?: string;
	readonly status?: string;
	/** Every field with a value (the board shows the card fields, the table all). */
	readonly fields: readonly CardField[];
	readonly blockers: readonly { readonly label: string; readonly open: boolean; readonly itemId?: string }[];
	/** Open issue, nothing open blocks it, not done, no room on it yet. */
	readonly startable: boolean;
	readonly prs: readonly { readonly label: string; readonly tone: Tone; readonly url: string }[];
	readonly review?: { readonly label: string; readonly tone: Tone };
	readonly comments?: number;
	readonly room?: RoomInfo;
	readonly pending?: boolean;
}

export interface Column {
	/** The Status option id; '' for items without a status. */
	readonly id: string;
	readonly name: string;
	readonly color?: string;
	readonly done: boolean;
	readonly cards: readonly Card[];
}

export interface BoardModel {
	readonly project: { readonly title: string; readonly url: string; readonly ref: string };
	readonly statusFieldId?: string;
	readonly columns: readonly Column[];
	/** The fields the table shows and edits (no Status: it has its own column). */
	readonly fields: readonly ProjectField[];
	/** Field ids the cards show. */
	readonly cardFields: readonly string[];
	/** Filter chips: a field's or the labels' / assignees' values. */
	readonly filters: readonly { readonly key: string; readonly name: string; readonly values: readonly string[] }[];
	readonly repositories: readonly string[];
	readonly sync: { readonly text: string; readonly tone: Tone };
	readonly journal: readonly { readonly time: string; readonly direction: 'in' | 'out'; readonly item?: string; readonly text: string; readonly error?: boolean }[];
}

const DONE = /^(done|kész|closed|merged|shipped)$/i;
const RANK: Record<RoomInfo['status'], number> = { running: 0, waiting: 1, idle: 2, ended: 3 };

/** The room on an item: by issue / PR link, `#N`, or a task code the title starts with (`T27`, `AR30`). */
export function roomFor(item: ProjectItem, rooms: readonly RoomInfo[]): RoomInfo | undefined {
	const urls = [item.url, ...item.pullRequests.map(p => p.url)].filter((u): u is string => !!u).map(u => u.toLowerCase());
	const code = /^([A-Z]{1,4}\d+(?:[.·]\d+)?)\b/.exec(item.title)?.[1];
	const matches = rooms.filter(r => r.refs.some(ref => {
		if (ref.startsWith('https://')) {
			return urls.includes(ref.toLowerCase());
		}
		if (ref.startsWith('#')) {
			return item.number !== undefined && ref === `#${item.number}`;
		}
		return !!code && ref === code;
	}));
	return matches.sort((a, b) => RANK[a.status] - RANK[b.status])[0];
}

/** The card fields when none are set: the first four editable fields besides Status. */
export function autoCardFields(fields: readonly ProjectField[], statusId: string | undefined): string[] {
	return fields.filter(f => f.id !== statusId && f.type !== 'other').slice(0, 4).map(f => f.id);
}

function prChip(pr: ProjectItem['pullRequests'][number], isDraft: boolean | undefined): { label: string; tone: Tone; url: string } {
	const base = `PR #${pr.number}`;
	if (pr.state === 'MERGED') {
		return { label: `${base} · merged`, tone: 'ok', url: pr.url };
	}
	if (pr.state === 'CLOSED') {
		return { label: `${base} · closed`, tone: 'muted', url: pr.url };
	}
	if (isDraft) {
		return { label: `${base} · draft`, tone: 'muted', url: pr.url };
	}
	switch (pr.ci) {
		case 'pending': case 'expected': return { label: `${base} · CI running`, tone: 'run', url: pr.url };
		case 'failure': case 'error': return { label: `${base} · CI failed`, tone: 'bad', url: pr.url };
		case 'success': return { label: `${base} · CI green`, tone: 'ok', url: pr.url };
		default: return { label: base, tone: 'muted', url: pr.url };
	}
}

function reviewChip(decision: string | undefined): Card['review'] {
	switch (decision) {
		case 'APPROVED': return { label: 'approved', tone: 'ok' };
		case 'CHANGES_REQUESTED': return { label: 'changes requested', tone: 'bad' };
		case 'REVIEW_REQUIRED': return { label: 'review required', tone: 'warn' };
		default: return undefined;
	}
}

export function syncLine(status: SyncStatus, live: boolean, clock: (ms: number) => string): { text: string; tone: Tone } {
	switch (status.kind) {
		case 'loading': return { text: 'reading…', tone: 'run' };
		case 'synced': return live && status.live ? { text: `in sync · ${clock(status.at)}`, tone: 'ok' } : { text: `read ${clock(status.at)} · polling (relay offline)`, tone: 'warn' };
		case 'error': return { text: status.message, tone: 'bad' };
		default: return { text: 'not loaded', tone: 'muted' };
	}
}

export function toCard(item: ProjectItem, snap: ProjectSnapshot, statusId: string | undefined, rooms: readonly RoomInfo[], pending: ReadonlySet<string> = new Set()): Card {
	const byContent = new Map(snap.items.filter(i => i.contentId).map(i => [i.contentId!, i]));
	const status = statusId ? item.fields[statusId] : undefined;
	const fields: CardField[] = [];
	for (const f of snap.fields) {
		const v = item.fields[f.id];
		if (f.id === statusId || !v) {
			continue;
		}
		fields.push({ fieldId: f.id, name: f.name, value: valueText(v), ...(v.kind === 'option' ? { valueId: v.optionId } : v.kind === 'iteration' ? { valueId: v.iterationId } : {}) });
	}
	const blockers = item.blockedBy.map(b => {
		const on = byContent.get(b.id);
		const same = !item.repository || !b.repository || b.repository.toLowerCase() === item.repository.toLowerCase();
		return { label: same ? `#${b.number}` : `${b.repository}#${b.number}`, open: on ? on.state === 'OPEN' : true, ...(on ? { itemId: on.id } : {}) };
	});
	const room = roomFor(item, rooms);
	const statusName = status?.kind === 'option' ? status.name : undefined;
	const done = !!statusName && DONE.test(statusName);
	return {
		id: item.id,
		type: item.type,
		...(item.number !== undefined ? { number: item.number } : {}),
		...(item.url ? { url: item.url } : {}),
		...(item.repository ? { repository: item.repository } : {}),
		title: item.title,
		...(item.state ? { state: item.state } : {}),
		labels: item.labels,
		assignees: item.assignees,
		...(status?.kind === 'option' ? { statusId: status.optionId, status: status.name } : {}),
		fields,
		blockers,
		startable: item.type === 'issue' && item.state === 'OPEN' && !done && !blockers.some(b => b.open) && (!room || room.status === 'ended'),
		prs: item.pullRequests.map(pr => prChip(pr, item.type === 'pr' ? item.isDraft : undefined)),
		...(reviewChip(item.reviewDecision) ? { review: reviewChip(item.reviewDecision)! } : {}),
		...(item.comments ? { comments: item.comments } : {}),
		...(room ? { room } : {}),
		...(pending.has(item.id) ? { pending: true } : {}),
	};
}

export interface BoardInput {
	readonly snapshot: ProjectSnapshot;
	readonly rooms: readonly RoomInfo[];
	readonly cardFields?: readonly string[];
	readonly status: SyncStatus;
	readonly live: boolean;
	readonly journal: readonly JournalEntry[];
	readonly clock: (ms: number) => string;
}

export function boardModel(input: BoardInput): BoardModel {
	const snap = input.snapshot;
	const statusField = snap.fields.find(f => f.type === 'single_select' && f.name.toLowerCase() === 'status');
	const statusId = statusField?.id;
	const cards = snap.items.map(item => toCard(item, snap, statusId, input.rooms));
	const columns: Column[] = (statusField?.options ?? []).map(o => ({
		id: o.id, name: o.name, ...(o.color ? { color: o.color } : {}), done: DONE.test(o.name),
		cards: cards.filter(c => c.statusId === o.id),
	}));
	const loose = cards.filter(c => !c.statusId || !columns.some(col => col.id === c.statusId));
	if (loose.length || !columns.length) {
		columns.unshift({ id: '', name: 'No status', done: false, cards: loose });
	}
	const wanted = (input.cardFields ?? []).map(n => snap.fields.find(f => f.name.toLowerCase() === n.toLowerCase() || f.id === n)?.id).filter((x): x is string => !!x);
	const fields = snap.fields.filter(f => f.id !== statusId);
	const filters: BoardModel['filters'][number][] = [];
	for (const f of fields.filter(f => f.type === 'single_select' || f.type === 'iteration' || f.type === 'text')) {
		const values = [...new Set(cards.flatMap(c => c.fields.filter(x => x.fieldId === f.id).map(x => x.value)))].sort();
		if (values.length && values.length <= 30) {
			filters.push({ key: `f:${f.id}`, name: f.name, values });
		}
	}
	const labels = [...new Set(cards.flatMap(c => c.labels))].sort();
	if (labels.length) {
		filters.push({ key: 'labels', name: 'Label', values: labels });
	}
	const assignees = [...new Set(cards.flatMap(c => c.assignees))].sort();
	if (assignees.length) {
		filters.push({ key: 'assignees', name: 'Assignee', values: assignees });
	}
	const repoCount = new Map<string, number>();
	for (const c of cards) {
		if (c.repository) {
			repoCount.set(c.repository, (repoCount.get(c.repository) ?? 0) + 1);
		}
	}
	return {
		project: { title: snap.title, url: snap.url, ref: `${snap.owner}/${snap.number}` },
		...(statusId ? { statusFieldId: statusId } : {}),
		columns,
		fields,
		cardFields: wanted.length ? wanted : autoCardFields(snap.fields, statusId),
		filters,
		repositories: [...repoCount.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r),
		sync: syncLine(input.status, input.live, input.clock),
		journal: input.journal.slice(0, 40).map(e => ({ time: input.clock(e.at), direction: e.direction, ...(e.item ? { item: e.item } : {}), text: e.text, ...(e.error ? { error: true } : {}) })),
	};
}

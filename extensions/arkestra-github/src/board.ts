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
	readonly items?: readonly { readonly text: string; readonly done: boolean }[];
	readonly base?: string;
	readonly branches?: readonly string[];
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
	/** Field ids by the job they do on the Table view: lane (Line), executor, reviewer, prerequisite note. */
	readonly roles: FieldRoles;
	readonly sync: SyncLine;
	readonly journal: readonly { readonly time: string; readonly direction: 'in' | 'out'; readonly item?: string; readonly text: string; readonly error?: boolean }[];
}

export interface FieldRoles {
	readonly line?: string;
	readonly executor?: string;
	readonly reviewer?: string;
	readonly prereq?: string;
}

/** The sync state: the text (English) and its parts, so the page can say it in the UI language. */
export interface SyncLine {
	readonly text: string;
	readonly tone: Tone;
	readonly kind: 'loading' | 'synced' | 'offline' | 'error' | 'none';
	readonly at?: string;
}

const DONE = /^(done|kész|closed|merged|shipped)$/i;
const LANE = /^(line|release|milestone|version|kiadás|verzió|sáv)$/i;
const EXECUTOR = /^(végrehajtó|executor)(\s+agent)?$/i;
const REVIEWER = /^(reviewer|review)(\s+agent)?$/i;
const PREREQ = /^(előfeltétel(ek)?|prerequisites?|depends on)$/i;
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

export function syncLine(status: SyncStatus, live: boolean, clock: (ms: number) => string): SyncLine {
	switch (status.kind) {
		case 'loading': return { text: 'reading…', tone: 'run', kind: 'loading' };
		case 'synced': return live && status.live
			? { text: `in sync · ${clock(status.at)}`, tone: 'ok', kind: 'synced', at: clock(status.at) }
			: { text: `read ${clock(status.at)} · polling (relay offline)`, tone: 'warn', kind: 'offline', at: clock(status.at) };
		case 'error': return { text: status.message, tone: 'bad', kind: 'error' };
		default: return { text: 'not loaded', tone: 'muted', kind: 'none' };
	}
}

/** Which fields do the Table view's jobs: by the name set (lane), else by their usual names. */
export function fieldRoles(fields: readonly ProjectField[], laneField?: string): FieldRoles {
	const usable = fields.filter(f => f.type === 'single_select' || f.type === 'text' || f.type === 'iteration');
	const by = (re: RegExp, types: readonly string[] = ['single_select', 'text']) => usable.find(f => types.includes(f.type) && re.test(f.name.trim()))?.id;
	const line = laneField ? usable.find(f => f.name.toLowerCase() === laneField.toLowerCase() || f.id === laneField)?.id : by(LANE, ['single_select', 'text', 'iteration']);
	const executor = by(EXECUTOR);
	const reviewer = by(REVIEWER);
	const prereq = by(PREREQ, ['text']);
	return { ...(line ? { line } : {}), ...(executor ? { executor } : {}), ...(reviewer ? { reviewer } : {}), ...(prereq ? { prereq } : {}) };
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
	/** The lane field's name (the Plan view's), for the Table's Line column and grouping. */
	readonly laneField?: string;
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
	// Status first, in the board's column order; the page adds "not done" (AR30 follow-up).
	if (statusField && columns.length) {
		filters.push({ key: 'status', name: statusField.name, values: columns.map(c => c.name) });
	}
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
		roles: fieldRoles(snap.fields, input.laneField),
		sync: syncLine(input.status, input.live, input.clock),
		journal: input.journal.slice(0, 40).map(e => ({ time: input.clock(e.at), direction: e.direction, ...(e.item ? { item: e.item } : {}), text: e.text, ...(e.error ? { error: true } : {}) })),
	};
}

/** A Table view row: the card, whether its column is done, and its values by filter key. */
export interface TableRow {
	readonly card: Card;
	readonly done: boolean;
	readonly values: Readonly<Record<string, readonly string[]>>;
}

/** A Table view column: '#', Title, Status, a field ('f:<id>') or one of ours (labels, prereq, pr…). */
export interface TableColumn {
	readonly key: string;
	readonly name: string;
	readonly type: string;
}

export interface TableGroup {
	/** The group's value; '' for the rows without one. */
	readonly value: string;
	readonly rows: readonly TableRow[];
}

export type TableSort = { readonly key: string; readonly dir: number } | null | undefined;

export interface TableCell {
	readonly text: string;
	/** ok, warn, run, muted, or none (an empty cell, shown dim). */
	readonly tone?: string;
}

/**
 * The Table view's logic: filters, grouping, sorting, columns, cell text. The page embeds this
 * function's source, so it stays self-contained: no imports and no outer names inside.
 */
export function tableLogic() {
	const FIXED = ['num', 'title'];
	const DONE_NOTE = /^\s*(✓|✔|done\b|kész|kiadva|released|merged|shipped)/i;
	const WARN_NOTE = /(hiányzik|hiány|missing|blocked|blokkol|várakozik|waiting|nincs meg)/i;
	const RUN = /(progress|folyamat|running|doing|review|fejleszt)/i;
	const WAIT = /(wait|vár|blocked|hold|blokk)/i;

	function rows(model: BoardModel): TableRow[] {
		const out: TableRow[] = [];
		for (const col of model.columns) {
			for (const card of col.cards) {
				const values: Record<string, string[]> = { status: [col.name], labels: [...card.labels], assignees: [...card.assignees] };
				for (const f of card.fields) {
					values['f:' + f.fieldId] = [f.value];
				}
				out.push({ card, done: col.done, values });
			}
		}
		return out;
	}

	/** Filters by key ('!done' = every column but the done ones) and the search: title text or `#N`. */
	function filter(list: readonly TableRow[], filters: Readonly<Record<string, string>>, search: string): TableRow[] {
		const q = (search || '').trim().toLowerCase();
		const num = /^#?(\d+)$/.exec(q)?.[1];
		return list.filter(r => {
			for (const key of Object.keys(filters || {})) {
				const want = filters[key];
				if (!want) {
					continue;
				}
				if (want === '!done') {
					if (r.done) {
						return false;
					}
					continue;
				}
				if (!(r.values[key] || []).includes(want)) {
					return false;
				}
			}
			if (!q) {
				return true;
			}
			return (num !== undefined && String(r.card.number) === num) || r.card.title.toLowerCase().includes(q);
		});
	}

	function columns(model: BoardModel): TableColumn[] {
		const cols: TableColumn[] = [{ key: 'num', name: '#', type: 'num' }, { key: 'title', name: 'Title', type: 'title' }];
		if (model.statusFieldId) {
			cols.push({ key: 'status', name: 'Status', type: 'status' });
		}
		for (const f of model.fields) {
			if (f.type !== 'other') {
				cols.push({ key: 'f:' + f.id, name: f.name, type: f.id === model.roles?.prereq ? 'note' : f.type });
			}
		}
		cols.push(
			{ key: 'labels', name: 'Labels', type: 'list' },
			{ key: 'assignees', name: 'Assignees', type: 'list' },
			{ key: 'prereq', name: 'Blocked by', type: 'prereq' },
			{ key: 'pr', name: 'PR', type: 'pr' },
			{ key: 'room', name: 'Room', type: 'room' },
			{ key: 'progress', name: 'Progress', type: 'progress' },
		);
		return cols;
	}

	/** #, Title, Status, Line, executor, reviewer, prerequisite (the note field, else the blockers). */
	function defaultKeys(model: BoardModel): string[] {
		const roles = model.roles || {};
		const keys = [...FIXED];
		if (model.statusFieldId) {
			keys.push('status');
		}
		if (roles.line) {
			keys.push('f:' + roles.line);
		}
		let people = 0;
		for (const id of [roles.executor, roles.reviewer]) {
			if (id) {
				keys.push('f:' + id);
				people++;
			}
		}
		for (const id of model.cardFields || []) {
			if (people >= 2) {
				break;
			}
			if (!keys.includes('f:' + id) && id !== roles.prereq) {
				keys.push('f:' + id);
				people++;
			}
		}
		keys.push(roles.prereq ? 'f:' + roles.prereq : 'prereq');
		const have = new Set(columns(model).map(c => c.key));
		return keys.filter(k => have.has(k));
	}

	/** The columns' keys: the saved choice (unknown keys dropped) or the default; # and Title always first. */
	function columnKeys(model: BoardModel, saved: readonly string[] | null | undefined): string[] {
		const have = new Set(columns(model).map(c => c.key));
		const chosen = Array.isArray(saved) && saved.length ? saved.filter(k => have.has(k)) : defaultKeys(model);
		return [...FIXED, ...chosen.filter(k => !FIXED.includes(k))];
	}

	/** The shown columns, in the chosen order; the grouped-by column is hidden (the group headers say it). */
	function visible(model: BoardModel, saved: readonly string[] | null | undefined, groupKey: string | null | undefined): TableColumn[] {
		const all = columns(model);
		return columnKeys(model, saved).filter(k => k !== groupKey).map(k => all.find(c => c.key === k)!);
	}

	/** Adds a column at the end or takes it away; # and Title stay. */
	function toggle(model: BoardModel, saved: readonly string[] | null | undefined, key: string): string[] {
		const keys = columnKeys(model, saved);
		if (FIXED.includes(key)) {
			return keys;
		}
		return keys.includes(key) ? keys.filter(k => k !== key) : columns(model).some(c => c.key === key) ? [...keys, key] : keys;
	}

	/** What the table can group by: Status and the fields with a short list of values. */
	function groupChoices(model: BoardModel): { key: string; name: string }[] {
		return (model.filters || []).filter(f => f.key === 'status' || (f.key.startsWith('f:') && model.fields.some(x => 'f:' + x.id === f.key && x.type !== 'number'))).map(f => ({ key: f.key, name: f.name }));
	}

	/** The default grouping: by the Line field when there is one. */
	function defaultGroup(model: BoardModel): string {
		const line = model.roles?.line;
		return line && groupChoices(model).some(g => g.key === 'f:' + line) ? 'f:' + line : '';
	}

	function order(model: BoardModel, key: string): string[] {
		if (key === 'status') {
			return model.columns.map(c => c.name);
		}
		const f = model.fields.find(x => 'f:' + x.id === key);
		return [...(f?.options?.map(o => o.name) ?? f?.iterations?.map(i => i.title) ?? [])];
	}

	/** Rows by the key's first value, in the field's own option order, then by name; the empty group last. */
	function groups(model: BoardModel, list: readonly TableRow[], key: string | null | undefined): TableGroup[] {
		if (!key) {
			return [{ value: '', rows: [...list] }];
		}
		const by = new Map<string, TableRow[]>();
		for (const r of list) {
			const v = (r.values[key] || [])[0] || '';
			if (!by.has(v)) {
				by.set(v, []);
			}
			by.get(v)!.push(r);
		}
		const known = order(model, key);
		const rank = (v: string) => v === '' ? Number.MAX_SAFE_INTEGER : known.includes(v) ? known.indexOf(v) : known.length;
		return [...by.entries()]
			.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }))
			.map(([value, rows]) => ({ value, rows }));
	}

	function statusTone(row: TableRow): string {
		const name = row.card.status || '';
		if (!name) {
			return 'none';
		}
		if (row.done) {
			return 'ok';
		}
		return WAIT.test(name) ? 'warn' : RUN.test(name) ? 'run' : 'muted';
	}

	/** The prerequisite note: done (✓, kész, released) green, missing or blocked yellow; open blockers yellow too. */
	function noteTone(text: string, card: Card): string {
		if (DONE_NOTE.test(text)) {
			return 'ok';
		}
		if (WARN_NOTE.test(text) || card.blockers.some(b => b.open)) {
			return 'warn';
		}
		return 'muted';
	}

	function blockersCell(card: Card): TableCell {
		if (!card.blockers.length) {
			return { text: '—', tone: 'none' };
		}
		const open = card.blockers.filter(b => b.open);
		return open.length ? { text: open.map(b => b.label).join(', '), tone: 'warn' } : { text: '✓ ' + card.blockers.map(b => b.label).join(', '), tone: 'ok' };
	}

	function cell(model: BoardModel, row: TableRow, key: string): TableCell {
		const card = row.card;
		switch (key) {
			case 'num': return { text: card.number !== undefined ? String(card.number) : card.type === 'draft' ? 'draft' : '' };
			case 'title': return { text: card.title };
			case 'status': return { text: card.status || '—', tone: statusTone(row) };
			case 'labels': return card.labels.length ? { text: card.labels.join(', ') } : { text: '—', tone: 'none' };
			case 'assignees': return card.assignees.length ? { text: card.assignees.join(', ') } : { text: '—', tone: 'none' };
			case 'prereq': return blockersCell(card);
			case 'pr': {
				const parts = [...card.prs.map(p => p.label), ...(card.review ? [card.review.label] : [])];
				const tone = card.prs[0]?.tone === 'bad' ? 'warn' : card.prs[0]?.tone === 'ok' ? 'ok' : 'muted';
				return parts.length ? { text: parts.join(' · '), tone } : { text: '—', tone: 'none' };
			}
			case 'room': return card.room ? { text: card.room.type + ' · ' + card.room.phase, tone: card.room.status === 'running' ? 'run' : card.room.status === 'waiting' ? 'warn' : 'muted' } : { text: '—', tone: 'none' };
			case 'progress': return card.room?.progress ? { text: card.room.progress.done + '/' + card.room.progress.total } : { text: '—', tone: 'none' };
		}
		const id = key.startsWith('f:') ? key.slice(2) : '';
		const v = card.fields.find(f => f.fieldId === id)?.value;
		if (id && id === model.roles?.prereq) {
			return v ? { text: v, tone: noteTone(v, card) } : blockersCell(card);
		}
		return v ? { text: v } : { text: '—', tone: 'none' };
	}

	function sortValue(model: BoardModel, row: TableRow, key: string): string | number {
		if (key === 'num') {
			return row.card.number ?? 0;
		}
		if (key === 'status') {
			const i = model.columns.findIndex(c => c.cards.some(x => x.id === row.card.id));
			return i < 0 ? Number.MAX_SAFE_INTEGER : i;
		}
		if (key === 'progress') {
			const p = row.card.room?.progress;
			return p && p.total ? p.done / p.total : -1;
		}
		const f = key.startsWith('f:') ? model.fields.find(x => 'f:' + x.id === key) : undefined;
		const text = cell(model, row, key).text;
		if (f?.type === 'number') {
			const n = Number(text);
			return Number.isFinite(n) ? n : -Infinity;
		}
		if (f?.options) {
			const i = f.options.findIndex(o => o.name === text);
			return i < 0 ? Number.MAX_SAFE_INTEGER : i;
		}
		return text === '—' ? '￿' : text.toLowerCase();
	}

	/** A stable sort by a column, ascending (dir 1) or descending (-1); no sort keeps the board order. */
	function sortRows(model: BoardModel, list: readonly TableRow[], sort: TableSort): TableRow[] {
		const out = [...list];
		if (!sort || !sort.key) {
			return out;
		}
		const vals = new Map(out.map(r => [r, sortValue(model, r, sort.key)]));
		return out.sort((a, b) => {
			const x = vals.get(a)!, y = vals.get(b)!;
			const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
			return c * (sort.dir < 0 ? -1 : 1);
		});
	}

	return { rows, filter, columns, defaultKeys, columnKeys, visible, toggle, groupChoices, defaultGroup, groups, cell, sortRows };
}

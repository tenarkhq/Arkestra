/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Plan view's model (AR31), Planner style: release lanes with weighted
 *  progress, branch rails (where the base branch and each open branch stand and what goes on
 *  them next, in order), and a dependency staircase with the critical path. From the GitHub
 *  Project, the repository's branches and the rooms. No VS Code here.
 *--------------------------------------------------------------------------------------------*/

import { valueText, type ProjectField, type ProjectItem, type ProjectSnapshot } from './project';
import { roomFor, type RoomInfo, type Tone } from './board';

export interface GitInfo {
	readonly base: string;
	readonly baseHead?: string;
	/** Newest first. */
	readonly tags: readonly string[];
	/** The base branch's first-parent history, newest first. */
	readonly log: readonly { readonly sha: string; readonly subject: string; readonly refs: readonly string[] }[];
	/** Branch → head and distance from the base. */
	readonly branches: ReadonlyMap<string, { readonly sha: string; readonly ahead?: number; readonly behind?: number }>;
}

export interface Lane {
	readonly name: string;
	readonly state: 'released' | 'development' | 'next' | 'later';
	readonly done: number;
	readonly total: number;
	/** Weighted by the weight field (estimate); 0–100. */
	readonly percent: number;
}

export interface Step {
	readonly label: string;
	readonly sub?: string;
	readonly done?: boolean;
	readonly now?: boolean;
	readonly tone?: Tone;
	readonly url?: string;
	readonly roomId?: string;
}

export interface Rail {
	readonly name: string;
	readonly head?: string;
	readonly kind: 'base' | 'branch';
	readonly note: string;
	readonly steps: readonly Step[];
}

export interface StairCell {
	readonly id: string;
	readonly label: string;
	readonly title: string;
	readonly level: number;
	/** Completion, 0–1. */
	readonly fill: number;
	readonly critical: boolean;
	readonly startable: boolean;
	readonly running: boolean;
	readonly url?: string;
	readonly roomId?: string;
}

export interface PlanModel {
	readonly live?: string;
	readonly laneField?: string;
	readonly weightField?: string;
	readonly lanes: readonly Lane[];
	readonly rails: readonly Rail[];
	readonly levels: number;
	readonly stairs: readonly { readonly lane: string; readonly percent: number; readonly cells: readonly StairCell[] }[];
	readonly critical: readonly { readonly lane: string; readonly path: readonly string[]; readonly ids: readonly string[] }[];
}

const DONE = /^(done|kész|closed|merged|shipped)$/i;
const REVIEW = /review|ellenőrzés/i;
const PROGRESS = /progress|folyamatban|doing|coding/i;
const LANE = /^(line|release|milestone|version|kiadás|verzió|sáv)$/i;
const WEIGHT = /^(estimate|size|points|story points|becslés|weight|súly)$/i;
const BACKLOG = 'Backlog';

/** Natural order for version-like names: 0.9 < 0.10 < 1.0 < 1.x < later words. */
export function versionCompare(a: string, b: string): number {
	const pa = a.match(/\d+|\D+/g) ?? [];
	const pb = b.match(/\d+|\D+/g) ?? [];
	const digitsA = /^\d/.test(a);
	const digitsB = /^\d/.test(b);
	if (digitsA !== digitsB) {
		return digitsA ? -1 : 1;
	}
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i];
		const y = pb[i];
		if (x === undefined || y === undefined) {
			return x === undefined ? -1 : 1;
		}
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny && Number(x) !== Number(y)) {
			return Number(x) - Number(y);
		}
		if (nx !== ny) {
			return nx ? -1 : 1;
		}
		if (!nx && x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

export function findField(fields: readonly ProjectField[], wanted: string | undefined, auto: RegExp, types: readonly ProjectField['type'][]): ProjectField | undefined {
	const usable = fields.filter(f => types.includes(f.type));
	if (wanted) {
		return usable.find(f => f.name.toLowerCase() === wanted.toLowerCase() || f.id === wanted);
	}
	return usable.find(f => auto.test(f.name));
}

function statusOf(item: ProjectItem, statusId: string | undefined): string {
	const v = statusId ? item.fields[statusId] : undefined;
	return v?.kind === 'option' ? v.name : '';
}

export function isDone(item: ProjectItem, statusId: string | undefined): boolean {
	return DONE.test(statusOf(item, statusId)) || item.state === 'CLOSED' || item.state === 'MERGED';
}

/** How far an item is: done 1, in review 0.8, in progress by its room's list (or 0.5), else 0. */
export function fillOf(item: ProjectItem, statusId: string | undefined, room: RoomInfo | undefined): number {
	if (isDone(item, statusId)) {
		return 1;
	}
	const status = statusOf(item, statusId);
	if (REVIEW.test(status)) {
		return 0.8;
	}
	if (room?.progress && room.progress.total) {
		return Math.min(0.9, Math.max(0.1, room.progress.done / room.progress.total));
	}
	return PROGRESS.test(status) || room?.status === 'running' ? 0.5 : 0;
}

/** The dependency level: 0 without prerequisites on the project, else one after the latest prerequisite. */
export function levels(items: readonly ProjectItem[]): Map<string, number> {
	const byContent = new Map(items.filter(i => i.contentId).map(i => [i.contentId!, i]));
	const out = new Map<string, number>();
	const visiting = new Set<string>();
	const level = (item: ProjectItem): number => {
		const known = out.get(item.id);
		if (known !== undefined) {
			return known;
		}
		if (visiting.has(item.id)) {
			return 0; // a cycle: drawn as if it had no prerequisite
		}
		visiting.add(item.id);
		const before = item.blockedBy.map(b => byContent.get(b.id)).filter((x): x is ProjectItem => !!x);
		const l = before.length ? 1 + Math.max(...before.map(level)) : 0;
		visiting.delete(item.id);
		out.set(item.id, l);
		return l;
	};
	items.forEach(level);
	return out;
}

const label = (i: ProjectItem) => i.number !== undefined ? `#${i.number}` : i.title.slice(0, 24);

/** The chain with the most remaining work in a lane, earliest first. */
export function criticalPath(laneItems: readonly ProjectItem[], all: readonly ProjectItem[], remaining: (i: ProjectItem) => number): ProjectItem[] {
	const byContent = new Map(all.filter(i => i.contentId).map(i => [i.contentId!, i]));
	const memo = new Map<string, { total: number; next?: ProjectItem }>();
	const visiting = new Set<string>();
	const walk = (item: ProjectItem): { total: number; next?: ProjectItem } => {
		const known = memo.get(item.id);
		if (known) {
			return known;
		}
		if (visiting.has(item.id)) {
			return { total: 0 };
		}
		visiting.add(item.id);
		let best: { total: number; next?: ProjectItem } = { total: 0 };
		for (const b of item.blockedBy) {
			const before = byContent.get(b.id);
			if (before) {
				const r = walk(before);
				if (r.total > best.total) {
					best = { total: r.total, next: before };
				}
			}
		}
		visiting.delete(item.id);
		const result = { total: remaining(item) + best.total, ...(best.next ? { next: best.next } : {}) };
		memo.set(item.id, result);
		return result;
	};
	let end: ProjectItem | undefined;
	let most = 0;
	for (const i of laneItems) {
		const t = walk(i).total;
		if (t > most) {
			most = t;
			end = i;
		}
	}
	const chain: ProjectItem[] = [];
	for (let cur = end; cur && chain.length < 50; cur = memo.get(cur.id)?.next) {
		chain.unshift(cur);
	}
	return chain;
}

function ciText(pr: ProjectItem['pullRequests'][number]): { sub: string; tone: Tone } {
	switch (pr.ci) {
		case 'pending': case 'expected': return { sub: `PR #${pr.number} · CI running`, tone: 'run' };
		case 'failure': case 'error': return { sub: `PR #${pr.number} · CI failed`, tone: 'bad' };
		case 'success': return { sub: `PR #${pr.number} · CI green`, tone: 'ok' };
		default: return { sub: `PR #${pr.number}`, tone: 'muted' };
	}
}

export interface PlanInput {
	readonly snapshot: ProjectSnapshot;
	readonly rooms: readonly RoomInfo[];
	readonly git?: GitInfo;
	readonly laneField?: string;
	readonly weightField?: string;
}

export function planModel(input: PlanInput): PlanModel {
	const snap = input.snapshot;
	const statusId = snap.fields.find(f => f.type === 'single_select' && f.name.toLowerCase() === 'status')?.id;
	const laneField = findField(snap.fields, input.laneField, LANE, ['single_select', 'text', 'iteration']);
	const weightField = findField(snap.fields, input.weightField, WEIGHT, ['number']);
	const items = snap.items;
	const rooms = new Map(items.map(i => [i.id, roomFor(i, input.rooms)]));
	const fill = (i: ProjectItem) => fillOf(i, statusId, rooms.get(i.id));
	const weight = (i: ProjectItem) => {
		const v = weightField ? i.fields[weightField.id] : undefined;
		return v?.kind === 'number' && v.number > 0 ? v.number : 1;
	};
	const laneOf = (i: ProjectItem) => {
		const v = laneField ? i.fields[laneField.id] : undefined;
		return v ? valueText(v) : BACKLOG;
	};

	// Lanes, in the field's option order, else in version order; Backlog last.
	const names = [...new Set(items.map(laneOf))];
	const optionOrder = laneField?.options?.map(o => o.name) ?? laneField?.iterations?.map(i => i.title);
	names.sort((a, b) => a === BACKLOG ? 1 : b === BACKLOG ? -1 : optionOrder ? optionOrder.indexOf(a) - optionOrder.indexOf(b) : versionCompare(a, b));
	let open = 0;
	const lanes: Lane[] = names.map(name => {
		const own = items.filter(i => laneOf(i) === name);
		const total = own.reduce((s, i) => s + weight(i), 0);
		const doneW = own.reduce((s, i) => s + weight(i) * fill(i), 0);
		const done = own.filter(i => isDone(i, statusId)).length;
		const all = done === own.length;
		const state: Lane['state'] = name === BACKLOG ? 'later' : all ? 'released' : open++ === 0 ? 'development' : open === 2 ? 'next' : 'later';
		return { name, state, done, total: own.length, percent: total ? Math.round(100 * doneW / total) : 0 };
	});

	// The staircase and the critical path of every lane with work left.
	const lv = levels(items);
	const maxLevel = Math.max(0, ...lv.values());
	const critical: { lane: string; path: string[]; ids: string[] }[] = [];
	const onPath = new Set<string>();
	for (const lane of lanes) {
		if (lane.state === 'released') {
			continue;
		}
		const own = items.filter(i => laneOf(i) === lane.name);
		const chain = criticalPath(own, items, i => weight(i) * (1 - fill(i)));
		if (chain.length) {
			chain.forEach(i => onPath.add(i.id));
			critical.push({ lane: lane.name, path: [...chain.map(label), lane.name === BACKLOG ? '' : `Release ${lane.name}`].filter(Boolean), ids: chain.map(i => i.id) });
		}
	}
	const byContent = new Map(items.filter(i => i.contentId).map(i => [i.contentId!, i]));
	const startable = (i: ProjectItem) => i.type === 'issue' && i.state === 'OPEN' && !isDone(i, statusId) && i.blockedBy.every(b => { const x = byContent.get(b.id); return !!x && x.state !== 'OPEN'; }) && !rooms.get(i.id);
	const stairs = lanes.map(lane => ({
		lane: lane.name,
		percent: lane.percent,
		cells: items.filter(i => laneOf(i) === lane.name).sort((a, b) => (lv.get(a.id)! - lv.get(b.id)!) || ((a.number ?? 0) - (b.number ?? 0))).map(i => {
			const room = rooms.get(i.id);
			return {
				id: i.id, label: label(i), title: i.title, level: lv.get(i.id) ?? 0, fill: fill(i), critical: onPath.has(i.id),
				startable: startable(i), running: room?.status === 'running',
				...(i.url ? { url: i.url } : {}), ...(room && room.status !== 'ended' ? { roomId: room.roomId } : {}),
			};
		}),
	}));

	return {
		...(input.git?.tags[0] ? { live: input.git.tags[0] } : {}),
		...(laneField ? { laneField: laneField.name } : {}),
		...(weightField ? { weightField: weightField.name } : {}),
		lanes,
		rails: rails(input, items, statusId, lv, rooms, lanes),
		levels: maxLevel + 1,
		stairs,
		critical,
	};
}

function rails(input: PlanInput, items: readonly ProjectItem[], statusId: string | undefined, lv: Map<string, number>, rooms: Map<string, RoomInfo | undefined>, lanes: readonly Lane[]): Rail[] {
	const git = input.git;
	const base = git?.base ?? 'main';
	const byNumber = new Map(items.filter(i => i.number !== undefined).map(i => [i.number!, i]));
	const byContent = new Map(items.filter(i => i.contentId).map(i => [i.contentId!, i]));
	const out: Rail[] = [];

	// The base branch: what landed last, now, and the open PRs in dependency order, then the release.
	const past: Step[] = (git?.log ?? []).slice(0, 3).reverse().map(c => {
		const tag = c.refs.find(r => r.startsWith('tag: '))?.slice(5);
		const pr = /\(#(\d+)\)\s*$/.exec(c.subject)?.[1];
		return tag
			? { label: `${tag}`, sub: c.subject.slice(0, 70), done: true, tone: 'ok' as Tone }
			: { label: pr ? `#${pr}` : c.sha, sub: c.subject.replace(/\s*\(#\d+\)\s*$/, '').slice(0, 70), done: true };
	});
	const openPrs: { item: ProjectItem; pr: ProjectItem['pullRequests'][number] }[] = [];
	const seen = new Set<number>();
	for (const item of items) {
		for (const pr of item.pullRequests) {
			if (pr.state === 'OPEN' && !seen.has(pr.number)) {
				seen.add(pr.number);
				openPrs.push({ item: item.type === 'pr' ? (items.find(i => i.type === 'issue' && i.pullRequests.some(p => p.number === pr.number)) ?? item) : item, pr });
			}
		}
	}
	openPrs.sort((a, b) => (lv.get(a.item.id)! - lv.get(b.item.id)!) || (a.pr.number - b.pr.number));
	const next: Step[] = openPrs.map(({ item, pr }) => {
		const blockers = item.blockedBy.map(b => byContent.get(b.id)).filter(x => x && !isDone(x, statusId)).map(x => label(x!));
		const ci = ciText(pr);
		return { label: `${label(item)} → ${base}`, sub: blockers.length ? `after ${blockers.join(', ')} · ${ci.sub}` : ci.sub, tone: ci.tone, url: pr.url };
	});
	const dev = lanes.find(l => l.state === 'development');
	out.push({
		name: base, kind: 'base', ...(git?.baseHead ? { head: git.baseHead } : {}),
		note: git ? `${next.length} open PR${next.length === 1 ? '' : 's'} on the way` : 'no local repository',
		steps: [...past, { label: 'now', now: true }, ...next, ...(dev ? [{ label: `${dev.name} tag`, sub: `${dev.done}/${dev.total} done · ${dev.percent}%` }] : [])],
	});

	// Open branches: of open PRs and of rooms' work trees.
	const branches = new Map<string, { item?: ProjectItem; room?: RoomInfo; pr?: ProjectItem['pullRequests'][number] }>();
	for (const { item, pr } of openPrs) {
		if (pr.headRef && pr.headRef !== base) {
			branches.set(pr.headRef, { item, pr, ...(rooms.get(item.id) ? { room: rooms.get(item.id)! } : {}) });
		}
	}
	for (const room of input.rooms) {
		if (room.status === 'ended') {
			continue;
		}
		for (const b of room.branches ?? []) {
			const num = room.refs.map(r => /^#(\d+)$/.exec(r)?.[1] ?? /\/(?:issues|pull)\/(\d+)$/.exec(r)?.[1]).find(Boolean);
			const item = num ? byNumber.get(Number(num)) : undefined;
			branches.set(b, { ...branches.get(b), ...(item ? { item } : {}), room });
		}
	}
	for (const [name, info] of [...branches.entries()].slice(0, 8)) {
		const ref = git?.branches.get(name);
		const steps: Step[] = [];
		for (const it of info.room?.items ?? []) {
			if (it.done) {
				steps.push({ label: it.text, done: true });
			}
		}
		steps.push({ label: 'now', now: true });
		let n = 0;
		for (const it of info.room?.items ?? []) {
			if (!it.done) {
				steps.push({ label: `${String(++n).padStart(2, '0')} ${it.text}` });
			}
		}
		if (info.pr) {
			const ci = ciText(info.pr);
			steps.push({ label: ci.sub, tone: ci.tone, url: info.pr.url });
		}
		steps.push({ label: `merge → ${info.room?.base ?? base}` });
		const where = ref ? [`${ref.ahead ?? '?'} ahead`, ref.behind ? `${ref.behind} behind` : ''].filter(Boolean).join(' · ') : 'not in the local repository';
		const room = info.room ? `${info.room.type} room · ${info.room.phase}${info.room.agents ? ` · ${info.room.agents} agents` : ''}` : '';
		out.push({
			name, kind: 'branch', ...(ref?.sha ? { head: ref.sha } : {}),
			note: [info.item ? `${label(info.item)} ${info.item.title}`.slice(0, 60) : '', room, where].filter(Boolean).join(' · '),
			steps: steps.map(s => info.room && s.now ? { ...s, roomId: info.room.roomId } : s),
		});
	}
	return out;
}

/** `git log --format=%h%x09%s%x09%D` lines. */
export function parseLog(text: string): GitInfo['log'] {
	return text.split('\n').filter(Boolean).map(line => {
		const [sha, subject = '', refs = ''] = line.split('\t');
		return { sha, subject, refs: refs.split(',').map(r => r.trim()).filter(Boolean) };
	});
}

/** `git for-each-ref --format=%(refname:short)%09%(objectname:short)` lines; local branches win over origin's. */
export function parseRefs(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split('\n').filter(Boolean)) {
		const [name, sha] = line.split('\t');
		if (!name || !sha || name.endsWith('/HEAD')) {
			continue;
		}
		const short = name.startsWith('origin/') ? name.slice('origin/'.length) : name;
		if (!out.has(short) || !name.startsWith('origin/')) {
			out.set(short, sha);
		}
	}
	return out;
}

/** `git rev-list --left-right --count base...branch` → behind and ahead. */
export function parseCounts(text: string): { behind: number; ahead: number } | undefined {
	const m = /^(\d+)\s+(\d+)/.exec(text.trim());
	return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : undefined;
}

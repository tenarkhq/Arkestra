/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Boards page's model: every board added (the workspace's project and the
 *  others), each as a tile with its counts, its lines' progress and when it was read last.
 *  No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import { parseProjectRef, type ProjectSnapshot } from './project';
import { isDone, planModel } from './plan';
import type { SyncStatus } from './sync';

export interface BoardEntry {
	/** "owner/number" in lower case. */
	readonly key: string;
	readonly title: string;
	readonly workspace: boolean;
	readonly pinned: boolean;
}

export interface TileLane {
	readonly name: string;
	readonly percent: number;
	readonly done: number;
	readonly total: number;
	readonly released: boolean;
}

export interface BoardTile {
	readonly key: string;
	readonly title: string;
	/** "Owner/number" as GitHub spells the owner (the key until the board is read). */
	readonly ref: string;
	readonly workspace: boolean;
	readonly pinned: boolean;
	readonly url?: string;
	/** unread: never read here; reading: being read now; error: the last read failed. */
	readonly state: 'unread' | 'reading' | 'synced' | 'error';
	readonly error?: string;
	/** When the board was read last (ms). */
	readonly readAt?: number;
	readonly items: number;
	readonly open: number;
	readonly done: number;
	/** Done items of all, 0–100. */
	readonly percent: number;
	/** The lines / releases (the lane field's values), Backlog last; none without a lane field. */
	readonly lanes: readonly TileLane[];
}

/** The key of a board from what was typed: "owner/number" in lower case, undefined when it is no project. */
export function boardKey(text: string): string | undefined {
	const ref = parseProjectRef(text);
	return ref ? `${ref.owner.toLowerCase()}/${ref.number}` : undefined;
}

/** The cache key of a project's snapshot in the extension's global state. */
export function cacheKey(key: string): string {
	return `arkestra.github.project:${key.toLowerCase()}`;
}

/**
 * The boards added before the Boards page kept its own list: the pinned ones, then every other
 * project read here once (its snapshot is cached under `arkestra.github.project:owner/number`).
 */
export function seedBoards(pins: readonly string[], stateKeys: readonly string[]): string[] {
	const cached = stateKeys.map(k => /^arkestra\.github\.project:(.+\/\d+)$/.exec(k)?.[1]).filter((k): k is string => !!k && !!boardKey(k));
	return [...new Set([...pins, ...cached].map(k => k.toLowerCase()))];
}

/** One tile. `laneField` / `weightField`: the settings of the same name (the Plan view's lines). */
export function boardTile(entry: BoardEntry, snap: ProjectSnapshot | undefined, status: SyncStatus | undefined, fields: { laneField?: string; weightField?: string } = {}): BoardTile {
	const state: BoardTile['state'] = status?.kind === 'loading' ? 'reading' : status?.kind === 'error' ? 'error' : snap ? 'synced' : 'unread';
	const base = {
		key: entry.key,
		title: snap?.title ?? (entry.title || entry.key),
		ref: snap ? `${snap.owner}/${snap.number}` : entry.key,
		workspace: entry.workspace,
		pinned: entry.pinned,
		state,
		...(status?.kind === 'error' ? { error: status.message } : {}),
	};
	if (!snap) {
		return { ...base, items: 0, open: 0, done: 0, percent: 0, lanes: [] };
	}
	const statusId = snap.fields.find(f => f.type === 'single_select' && f.name.toLowerCase() === 'status')?.id;
	const done = snap.items.filter(i => isDone(i, statusId)).length;
	let lanes: TileLane[] = [];
	try {
		const plan = planModel({ snapshot: snap, rooms: [], ...(fields.laneField ? { laneField: fields.laneField } : {}), ...(fields.weightField ? { weightField: fields.weightField } : {}) });
		lanes = plan.laneField ? plan.lanes.map(l => ({ name: l.name, percent: l.percent, done: l.done, total: l.total, released: l.state === 'released' })) : [];
	} catch {
		// the counts still show
	}
	const readAt = status?.kind === 'synced' ? Math.max(status.at, snap.fetchedAt || 0) : snap.fetchedAt || undefined;
	return {
		...base,
		url: snap.url,
		...(readAt ? { readAt } : {}),
		items: snap.items.length,
		open: snap.items.length - done,
		done,
		percent: snap.items.length ? Math.round(100 * done / snap.items.length) : 0,
		lanes,
	};
}

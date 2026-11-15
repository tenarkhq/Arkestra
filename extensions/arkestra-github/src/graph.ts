/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Graph view's model (AR32): a free node graph of the project's tasks and the
 *  releases they lead to. Prerequisites are GitHub's "blocked by" links; loose links (that
 *  block nothing) and where each node stands are kept with the workspace. No VS Code here.
 *--------------------------------------------------------------------------------------------*/

import type { ProjectItem, ProjectSnapshot } from './project';
import { roomFor, type RoomInfo, type Tone } from './board';
import { isDone, type PlanModel } from './plan';

export interface GraphNode {
	readonly id: string;
	readonly kind: 'task' | 'milestone';
	readonly label: string;
	readonly title: string;
	readonly status?: string;
	/** One line under the title: CI, the room, what blocks it, startable. */
	readonly sub?: string;
	readonly tone?: Tone;
	readonly lane: string;
	readonly x: number;
	readonly y: number;
	readonly done: boolean;
	/** Completion, 0–1 (the Plan's): drawn as a thin bar, green when done, blue while open. */
	readonly fill: number;
	readonly critical: boolean;
	readonly startable: boolean;
	readonly url?: string;
	readonly roomId?: string;
	/** Only issues can take part in GitHub dependencies. */
	readonly linkable: boolean;
}

export interface GraphEdge {
	readonly from: string;
	readonly to: string;
	/** blocks: GitHub "blocked by" (from blocks to); loose: kept here, blocks nothing; release: a task leading to its lane's release. */
	readonly kind: 'blocks' | 'loose' | 'release';
	readonly critical: boolean;
}

export interface GraphSaved {
	readonly positions?: Readonly<Record<string, readonly [number, number]>>;
	readonly loose?: readonly (readonly [string, string])[];
}

export interface GraphModel {
	readonly nodes: readonly GraphNode[];
	readonly edges: readonly GraphEdge[];
	readonly width: number;
	readonly height: number;
	readonly critical: readonly { readonly lane: string; readonly path: readonly string[] }[];
}

export const NODE = { w: 200, h: 64, dx: 250, dy: 92, pad: 40 } as const;

const label = (i: ProjectItem) => i.number !== undefined ? `#${i.number}` : 'draft';

/** Where nodes go without a saved place: columns by dependency level, rows by lane. */
export function autoLayout(plan: PlanModel, milestones: readonly string[]): Record<string, [number, number]> {
	const out: Record<string, [number, number]> = {};
	let row = 0;
	for (const lane of plan.stairs) {
		if (!lane.cells.length) {
			continue;
		}
		const used = new Map<number, number>();
		let height = 1;
		for (const c of lane.cells) {
			const n = used.get(c.level) ?? 0;
			used.set(c.level, n + 1);
			height = Math.max(height, n + 1);
			out[c.id] = [NODE.pad + c.level * NODE.dx, NODE.pad + (row + n) * NODE.dy];
		}
		const m = `milestone:${lane.lane}`;
		if (milestones.includes(m)) {
			out[m] = [NODE.pad + plan.levels * NODE.dx, NODE.pad + (row + (height - 1) / 2) * NODE.dy];
		}
		row += height + 0.5;
	}
	return out;
}

export function graphModel(snap: ProjectSnapshot, rooms: readonly RoomInfo[], plan: PlanModel, saved: GraphSaved = {}): GraphModel {
	const statusId = snap.fields.find(f => f.type === 'single_select' && f.name.toLowerCase() === 'status')?.id;
	const byContent = new Map(snap.items.filter(i => i.contentId).map(i => [i.contentId!, i]));
	const cells = new Map(plan.stairs.flatMap(s => s.cells.map(c => [c.id, { ...c, lane: s.lane }] as const)));
	const criticalIds = new Set(plan.critical.flatMap(c => c.ids));
	const milestones = plan.lanes.filter(l => l.state !== 'released' && l.name !== 'Backlog').map(l => `milestone:${l.name}`);
	const auto = autoLayout(plan, milestones);
	const at = (id: string): [number, number] => {
		const p = saved.positions?.[id];
		return p ? [p[0], p[1]] : auto[id] ?? [NODE.pad, NODE.pad];
	};

	const nodes: GraphNode[] = snap.items.map(item => {
		const cell = cells.get(item.id);
		const room = roomFor(item, rooms);
		const status = statusId && item.fields[statusId]?.kind === 'option' ? (item.fields[statusId] as { name: string }).name : undefined;
		const open = item.blockedBy.map(b => byContent.get(b.id)).filter(b => !b || b.state === 'OPEN');
		const pr = item.pullRequests.find(p => p.state === 'OPEN');
		const done = isDone(item, statusId);
		const sub = done ? (item.pullRequests.some(p => p.state === 'MERGED') ? 'merged' : 'done')
			: room && room.status !== 'ended' ? `${room.type} room · ${room.status === 'running' ? `running · ${room.agents} agents` : room.phase}`
				: open.length ? `blocked · ${open.map(b => b ? label(b) : '?').join(', ')}`
					: pr ? (pr.ci === 'failure' || pr.ci === 'error' ? 'CI failed' : pr.ci === 'pending' || pr.ci === 'expected' ? 'CI running' : `PR #${pr.number}`)
						: cell?.startable ? 'startable now' : undefined;
		const tone: Tone | undefined = done ? 'ok' : room?.status === 'running' ? 'run' : open.length ? 'bad' : cell?.startable ? 'ok' : undefined;
		const [x, y] = at(item.id);
		return {
			id: item.id, kind: 'task', label: label(item), title: item.title, ...(status ? { status } : {}), ...(sub ? { sub } : {}), ...(tone ? { tone } : {}),
			lane: cell?.lane ?? 'Backlog', x, y, done, fill: done ? 1 : cell?.fill ?? 0, critical: criticalIds.has(item.id), startable: !!cell?.startable,
			...(item.url ? { url: item.url } : {}), ...(room && room.status !== 'ended' ? { roomId: room.roomId } : {}),
			linkable: item.type === 'issue' && !!item.contentId,
		};
	});
	const laneOf = new Map(nodes.map(n => [n.id, n.lane]));

	const edges: GraphEdge[] = [];
	for (const item of snap.items) {
		for (const b of item.blockedBy) {
			const before = byContent.get(b.id);
			if (before) {
				edges.push({ from: before.id, to: item.id, kind: 'blocks', critical: criticalIds.has(before.id) && criticalIds.has(item.id) });
			}
		}
	}
	for (const [a, b] of saved.loose ?? []) {
		if (laneOf.has(a) && laneOf.has(b) && !edges.some(e => (e.from === a && e.to === b) || (e.from === b && e.to === a))) {
			edges.push({ from: a, to: b, kind: 'loose', critical: false });
		}
	}
	for (const m of milestones) {
		const lane = m.slice('milestone:'.length);
		const own = nodes.filter(n => n.lane === lane);
		const openCount = own.filter(n => !n.done).length;
		const [x, y] = at(m);
		nodes.push({ id: m, kind: 'milestone', label: 'Release', title: `Release ${lane}`, sub: openCount ? `${openCount} open prerequisite${openCount === 1 ? '' : 's'}` : 'ready to release', tone: openCount ? 'warn' : 'ok', lane, x, y, done: !openCount, fill: own.length ? (own.length - openCount) / own.length : 1, critical: false, startable: false, linkable: false });
		// The lane's last tasks lead to the release: those that block nothing else in the lane.
		for (const n of own) {
			if (!edges.some(e => e.kind === 'blocks' && e.from === n.id && laneOf.get(e.to) === lane)) {
				edges.push({ from: n.id, to: m, kind: 'release', critical: n.critical });
			}
		}
	}
	const width = Math.max(600, ...nodes.map(n => n.x + NODE.w + NODE.pad));
	const height = Math.max(300, ...nodes.map(n => n.y + NODE.h + NODE.pad));
	return { nodes, edges, width, height, critical: plan.critical.map(c => ({ lane: c.lane, path: c.path })) };
}

/** Whether `blocking` → `blocked` would close a loop of prerequisites. */
export function wouldCycle(edges: readonly GraphEdge[], blocking: string, blocked: string): boolean {
	if (blocking === blocked) {
		return true;
	}
	const next = new Map<string, string[]>();
	for (const e of edges) {
		if (e.kind === 'blocks') {
			next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
		}
	}
	const seen = new Set<string>();
	const stack = [blocked];
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur === blocking) {
			return true;
		}
		if (!seen.has(cur)) {
			seen.add(cur);
			stack.push(...(next.get(cur) ?? []));
		}
	}
	return false;
}

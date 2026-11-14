/*---------------------------------------------------------------------------------------------
 *  Arkestra. A small renderer for mermaid flowcharts (`flowchart` / `graph`, LR / RL / TD /
 *  TB / BT): nodes with their shapes and labels, edges with their labels, a layered layout,
 *  SVG out. Other diagram kinds return undefined and are shown as source. No VS Code, no
 *  dependencies.
 *--------------------------------------------------------------------------------------------*/

export interface FlowNode {
	readonly id: string;
	label: string;
	shape: 'rect' | 'round' | 'diamond' | 'circle' | 'stadium';
}

export interface FlowEdge {
	readonly from: string;
	readonly to: string;
	readonly label?: string;
	readonly dashed?: boolean;
}

export interface Flowchart {
	readonly direction: 'LR' | 'RL' | 'TD' | 'BT';
	readonly nodes: FlowNode[];
	readonly edges: FlowEdge[];
}

const NODE = /([A-Za-z0-9_]\w*)\s*(\[\[(.+?)\]\]|\[\((.+?)\)\]|\(\((.+?)\)\)|\(\[(.+?)\]\)|\[(.+?)\]|\((.+?)\)|\{(.+?)\})?/y;
const EDGE = /\s*(-{2,}>|-\.+->|={2,}>|-{3,}|-\.-)\s*(?:\|([^|]*)\|\s*)?/y;
const EDGE_TEXT = /\s*--\s+([^-][^>]*?)\s+-->\s*/y;
const DASHED_TEXT = /\s*-\.\s+(.+?)\s+\.->\s*/y;

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/<br\s*\/?>/gi, ' ');

/** Parses a flowchart; undefined when the source is not one. */
export function parseFlowchart(source: string): Flowchart | undefined {
	const lines = source.split('\n').map(l => l.replace(/%%.*$/, '').trim()).filter(Boolean);
	const head = /^(?:flowchart|graph)\s*(LR|RL|TD|TB|BT)?\s*;?$/i.exec(lines[0] ?? '');
	if (!head) {
		return undefined;
	}
	const dir = (head[1] ?? 'TD').toUpperCase();
	const direction = (dir === 'TB' ? 'TD' : dir) as Flowchart['direction'];
	const nodes = new Map<string, FlowNode>();
	const edges: FlowEdge[] = [];
	const node = (text: string, at: number): { id: string; end: number } | undefined => {
		NODE.lastIndex = at;
		const m = NODE.exec(text);
		if (!m) {
			return undefined;
		}
		const id = m[1];
		const label = m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9];
		const shape: FlowNode['shape'] = m[5] ? 'circle' : m[6] ? 'stadium' : m[8] ? 'round' : m[9] ? 'diamond' : 'rect';
		const existing = nodes.get(id);
		if (!existing) {
			nodes.set(id, { id, label: label ? unquote(label) : id, shape });
		} else if (label) {
			existing.label = unquote(label);
			existing.shape = shape;
		}
		return { id, end: NODE.lastIndex };
	};
	for (const raw of lines.slice(1)) {
		const line = raw.replace(/;$/, '');
		if (/^(subgraph|end|style|classDef|class|click|linkStyle)\b/.test(line)) {
			continue;
		}
		// A chain: A --> B -->|label| C & D is read left to right ('&' is not supported).
		let at = 0;
		let left = node(line, at);
		if (!left) {
			continue;
		}
		at = left.end;
		while (at < line.length) {
			let label: string | undefined;
			let dashed = false;
			EDGE_TEXT.lastIndex = at;
			DASHED_TEXT.lastIndex = at;
			const t = EDGE_TEXT.exec(line);
			const d = t ? null : DASHED_TEXT.exec(line);
			if (t) {
				label = unquote(t[1]);
				at = EDGE_TEXT.lastIndex;
			} else if (d) {
				label = unquote(d[1]);
				dashed = true;
				at = DASHED_TEXT.lastIndex;
			} else {
				EDGE.lastIndex = at;
				const e = EDGE.exec(line);
				if (!e) {
					break;
				}
				dashed = e[1].includes('.');
				label = e[2] ? unquote(e[2]) : undefined;
				at = EDGE.lastIndex;
			}
			const right = node(line, at);
			if (!right) {
				break;
			}
			edges.push({ from: left.id, to: right.id, ...(label ? { label } : {}), ...(dashed ? { dashed } : {}) });
			left = right;
			at = right.end;
		}
	}
	return nodes.size ? { direction, nodes: [...nodes.values()], edges } : undefined;
}

/** Layers by longest path from the sources, in a depth-first order (an edge back in it is not followed). */
export function layers(chart: Flowchart): Map<string, number> {
	const rank = new Map<string, number>(chart.nodes.map(n => [n.id, 0]));
	const out = new Map<string, string[]>();
	for (const e of chart.edges) {
		out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
	}
	const order: string[] = [];
	const topo = (id: string, seen: Set<string>) => {
		if (seen.has(id)) {
			return;
		}
		seen.add(id);
		for (const next of out.get(id) ?? []) {
			topo(next, seen);
		}
		order.unshift(id);
	};
	const seen = new Set<string>();
	for (const n of chart.nodes) {
		topo(n.id, seen);
	}
	const pos = new Map(order.map((id, i) => [id, i]));
	for (const id of order) {
		for (const next of out.get(id) ?? []) {
			if ((pos.get(next) ?? 0) > (pos.get(id) ?? 0)) {
				rank.set(next, Math.max(rank.get(next)!, rank.get(id)! + 1));
			}
		}
	}
	return rank;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** The chart as SVG; colours come from CSS classes (node, edge, label) of the page. */
export function flowchartSvg(chart: Flowchart): string {
	const rank = layers(chart);
	const charW = 7.2;
	const width = (n: FlowNode) => Math.max(60, Math.min(220, n.label.length * charW + 28));
	const H = 40;
	const horizontal = chart.direction === 'LR' || chart.direction === 'RL';
	const byRank = new Map<number, FlowNode[]>();
	for (const n of chart.nodes) {
		const r = rank.get(n.id)!;
		byRank.set(r, [...(byRank.get(r) ?? []), n]);
	}
	const maxRank = Math.max(...byRank.keys());
	const gapMain = 56;
	const gapCross = 24;
	// Main axis offset per rank: the widest node of each earlier rank (horizontal) or the row height.
	const rankSize = [...Array(maxRank + 1).keys()].map(r => horizontal ? Math.max(...(byRank.get(r) ?? []).map(width), 0) : H);
	const mainAt = (r: number) => rankSize.slice(0, r).reduce((a, b) => a + b + gapMain, 0);
	const pos = new Map<string, { x: number; y: number; w: number }>();
	let crossMax = 0;
	for (const [r, list] of byRank) {
		let cross = 0;
		for (const n of list) {
			const w = width(n);
			const main = mainAt(r) + (horizontal ? (rankSize[r] - w) / 2 : 0);
			pos.set(n.id, horizontal ? { x: main, y: cross, w } : { x: cross, y: main, w });
			cross += (horizontal ? H : w) + gapCross;
		}
		crossMax = Math.max(crossMax, cross - gapCross);
	}
	const total = mainAt(maxRank) + rankSize[maxRank];
	const W = (horizontal ? total : crossMax) + 16;
	const Ht = (horizontal ? crossMax : total) + 16;
	const flip = (p: { x: number; y: number; w: number }) => chart.direction === 'RL' ? { ...p, x: total - p.x - p.w } : chart.direction === 'BT' ? { ...p, y: total - p.y - H } : p;
	const box = (id: string) => flip(pos.get(id)!);
	const parts: string[] = [];
	for (const e of chart.edges) {
		const a = box(e.from);
		const b = box(e.to);
		const [x1, y1, x2, y2] = horizontal
			? (a.x <= b.x ? [a.x + a.w, a.y + H / 2, b.x, b.y + H / 2] : [a.x, a.y + H / 2, b.x + b.w, b.y + H / 2])
			: (a.y <= b.y ? [a.x + a.w / 2, a.y + H, b.x + b.w / 2, b.y] : [a.x + a.w / 2, a.y, b.x + b.w / 2, b.y + H]);
		parts.push(`<line class="edge${e.dashed ? ' dashed' : ''}" x1="${x1 + 8}" y1="${y1 + 8}" x2="${x2 + 8}" y2="${y2 + 8}" marker-end="url(#arrow)"/>`);
		if (e.label) {
			parts.push(`<text class="elabel" x="${(x1 + x2) / 2 + 8}" y="${(y1 + y2) / 2 + 4}" text-anchor="middle">${esc(e.label)}</text>`);
		}
	}
	for (const n of chart.nodes) {
		const p = box(n.id);
		const x = p.x + 8;
		const y = p.y + 8;
		const shape = n.shape === 'diamond'
			? `<polygon class="node" points="${x + p.w / 2},${y} ${x + p.w},${y + H / 2} ${x + p.w / 2},${y + H} ${x},${y + H / 2}"/>`
			: n.shape === 'circle'
				? `<ellipse class="node" cx="${x + p.w / 2}" cy="${y + H / 2}" rx="${p.w / 2}" ry="${H / 2}"/>`
				: `<rect class="node" x="${x}" y="${y}" width="${p.w}" height="${H}" rx="${n.shape === 'stadium' ? H / 2 : n.shape === 'round' ? 10 : 4}"/>`;
		parts.push(`${shape}<text class="nlabel" x="${x + p.w / 2}" y="${y + H / 2 + 4}" text-anchor="middle">${esc(n.label.length > 30 ? n.label.slice(0, 29) + '…' : n.label)}</text>`);
	}
	return `<svg class="flowchart" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}">`
		+ '<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>'
		+ parts.join('') + '</svg>';
}

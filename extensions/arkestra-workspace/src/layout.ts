/*---------------------------------------------------------------------------------------------
 *  Arkestra. Mozaik and Pult: the workspace as tiles in the editor grid. A layout is the grid
 *  (VS Code's editor layout) plus what each tile shows; saved layouts keep both.
 *--------------------------------------------------------------------------------------------*/

export type Tile =
	| { readonly kind: 'room' }
	| { readonly kind: 'agents' }
	/** Pult: the lane of the room's slot-th agent (0-based, in answer order). */
	| { readonly kind: 'lane'; readonly slot: number }
	| { readonly kind: 'terminal' }
	| { readonly kind: 'file'; readonly uri: string }
	| { readonly kind: 'diff'; readonly original: string; readonly modified: string };

/** VS Code's `vscode.setEditorLayout` shape: 0 = side by side, 1 = stacked. */
export interface GroupLayout {
	readonly size?: number;
	readonly groups?: readonly GroupLayout[];
}

export interface EditorLayout {
	readonly orientation: 0 | 1;
	readonly groups: readonly GroupLayout[];
}

export interface SavedLayout {
	readonly name: string;
	readonly layout: EditorLayout;
	/** Tiles of each leaf group, in grid order (left to right, top to bottom). */
	readonly tiles: readonly (readonly Tile[])[];
}

/** How many tiles (leaf groups) a layout has. */
export function leafCount(layout: EditorLayout | GroupLayout): number {
	const groups = layout.groups ?? [];
	return groups.length ? groups.reduce((n, g) => n + leafCount(g), 0) : 1;
}

/**
 * The default Mozaik: the room on the left; on the right the agents beside the code
 * (diffs, files) above a terminal.
 */
export function mosaic(name = 'Mozaik'): SavedLayout {
	return {
		name,
		layout: {
			orientation: 0,
			groups: [
				{ size: 0.42 },
				{
					size: 0.58,
					groups: [
						{ size: 0.62, groups: [{ size: 0.36 }, { size: 0.64 }] },
						{ size: 0.38 },
					],
				},
			],
		},
		tiles: [[{ kind: 'room' }], [{ kind: 'agents' }], [], [{ kind: 'terminal' }]],
	};
}

/** Pult lanes: at least one, at most this many side by side. */
export const PULT_MAX_LANES = 4;

/**
 * Pult: one lane per agent of the room side by side on top; below them the room (the
 * thread and the shared input) beside the code and the terminal.
 */
export function pult(agents: number, name = 'Pult'): SavedLayout {
	const lanes = Math.min(PULT_MAX_LANES, Math.max(1, Math.floor(agents) || 0));
	return {
		name,
		layout: {
			orientation: 1,
			groups: [
				{ size: 0.62, groups: Array.from({ length: lanes }, () => ({ size: 1 / lanes })) },
				{ size: 0.38, groups: [{ size: 0.4 }, { size: 0.35 }, { size: 0.25 }] },
			],
		},
		tiles: [
			...Array.from({ length: lanes }, (_, slot): Tile[] => [{ kind: 'lane', slot }]),
			[{ kind: 'room' }],
			[],
			[{ kind: 'terminal' }],
		],
	};
}

function validGroup(raw: unknown, depth: number): GroupLayout | undefined {
	if (!raw || typeof raw !== 'object' || depth > 6) {
		return undefined;
	}
	const g = raw as { size?: unknown; groups?: unknown };
	const size = typeof g.size === 'number' && g.size > 0 ? g.size : undefined;
	if (g.groups === undefined) {
		return size === undefined ? {} : { size };
	}
	if (!Array.isArray(g.groups) || g.groups.length === 0) {
		return undefined;
	}
	const groups = g.groups.map(x => validGroup(x, depth + 1));
	return groups.every(Boolean) ? { ...(size === undefined ? {} : { size }), groups: groups as GroupLayout[] } : undefined;
}

function validTile(raw: unknown): Tile | undefined {
	const t = raw as { kind?: unknown; uri?: unknown; original?: unknown; modified?: unknown; slot?: unknown } | null;
	switch (t?.kind) {
		case 'room': case 'agents': case 'terminal':
			return { kind: t.kind };
		case 'lane':
			return typeof t.slot === 'number' && Number.isInteger(t.slot) && t.slot >= 0 && t.slot < 16 ? { kind: 'lane', slot: t.slot } : undefined;
		case 'file':
			return typeof t.uri === 'string' ? { kind: 'file', uri: t.uri } : undefined;
		case 'diff':
			return typeof t.original === 'string' && typeof t.modified === 'string' ? { kind: 'diff', original: t.original, modified: t.modified } : undefined;
		default:
			return undefined;
	}
}

/** A stored layout, checked; tiles padded or cut to the grid's tile count. */
export function readLayout(raw: unknown): SavedLayout | undefined {
	const r = raw as { name?: unknown; layout?: { orientation?: unknown; groups?: unknown }; tiles?: unknown } | null;
	if (!r || typeof r.name !== 'string' || !r.name.trim() || !r.layout || (r.layout.orientation !== 0 && r.layout.orientation !== 1)) {
		return undefined;
	}
	const root = validGroup({ groups: r.layout.groups }, 0);
	if (!root?.groups) {
		return undefined;
	}
	const layout: EditorLayout = { orientation: r.layout.orientation, groups: root.groups };
	const count = leafCount(layout);
	const tiles = Array.from({ length: count }, (_, i) => {
		const group = Array.isArray(r.tiles) ? r.tiles[i] : undefined;
		return Array.isArray(group) ? group.map(validTile).filter((t): t is Tile => !!t) : [];
	});
	return { name: r.name.trim(), layout, tiles };
}

/** What an open tab is, as far as a layout can bring it back. */
export type TabDescriptor =
	| { readonly type: 'chat' }
	| { readonly type: 'webview'; readonly viewType: string }
	| { readonly type: 'terminal' }
	| { readonly type: 'text'; readonly uri: string }
	| { readonly type: 'diff'; readonly original: string; readonly modified: string }
	| { readonly type: 'other' };

/** A lane tab does not say its slot; `capture` numbers lanes in grid order, this gives slot 0. */
export function tileFromTab(tab: TabDescriptor, laneSlot = 0): Tile | undefined {
	switch (tab.type) {
		case 'chat': return { kind: 'room' };
		// Webview view types of extension panels come prefixed with "mainThreadWebview-".
		case 'webview': return /(^|-)arkestra\.agents$/.test(tab.viewType) ? { kind: 'agents' }
			: /(^|-)arkestra\.lane$/.test(tab.viewType) ? { kind: 'lane', slot: laneSlot } : undefined;
		case 'terminal': return { kind: 'terminal' };
		case 'text': return /^(file|vscode-remote|untitled):/.test(tab.uri) && !tab.uri.startsWith('untitled:') ? { kind: 'file', uri: tab.uri } : undefined;
		case 'diff': return { kind: 'diff', original: tab.original, modified: tab.modified };
		default: return undefined;
	}
}

/** The current workspace as a layout: the grid and every group's restorable tabs. */
export function capture(name: string, layout: EditorLayout, groups: readonly (readonly TabDescriptor[])[]): SavedLayout {
	const count = leafCount(layout);
	let lanes = 0;
	const tiles = Array.from({ length: count }, (_, i) => (groups[i] ?? []).map(tab => {
		const tile = tileFromTab(tab, lanes);
		if (tile?.kind === 'lane') {
			lanes++;
		}
		return tile;
	}).filter((t): t is Tile => !!t));
	return { name, layout, tiles };
}

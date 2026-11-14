/*---------------------------------------------------------------------------------------------
 *  Arkestra. Artifacts (AR26): what agents produce in any thread, in one gallery. Diagrams
 *  (mermaid), documents (markdown), pages (HTML), images (SVG, image links) and code blocks
 *  are found in the agents' answers; the same title in a later answer is the next version.
 *  No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import type { Message, RoomState } from './room';

export type ArtifactKind = 'diagram' | 'document' | 'page' | 'code' | 'image';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['diagram', 'document', 'page', 'code', 'image'];

export interface ArtifactVersion {
	readonly n: number;
	readonly at: string;
	readonly messageId: string;
	readonly content: string;
	/** Fence language for code; `data:` or a path for an image link. */
	readonly language?: string;
}

export interface Artifact {
	/** Stable across rebuilds: room, kind and the normalised title. */
	readonly key: string;
	readonly kind: ArtifactKind;
	readonly title: string;
	readonly roomId: string;
	readonly roomTitle: string;
	readonly project?: string;
	readonly agentId: string;
	readonly agentName: string;
	readonly versions: readonly ArtifactVersion[];
}

/** Code blocks shorter than this are part of the answer, not an artifact. */
export const MIN_CODE_LINES = 5;

const KIND_BY_LANGUAGE: Record<string, ArtifactKind> = {
	mermaid: 'diagram', md: 'document', markdown: 'document', html: 'page', htm: 'page', svg: 'image',
};

interface Found {
	readonly kind: ArtifactKind;
	readonly title: string;
	readonly content: string;
	readonly language?: string;
}

const clean = (s: string) => s.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();

/** The title of a block: a filename in the info string, else the nearest heading or label above it. */
function titleFor(lines: readonly string[], fenceLine: number, info: string): string | undefined {
	const file = /\b([\w.-]+\.[a-z0-9]{1,6})\b/i.exec(info.split(/\s+/).slice(1).join(' '))?.[1];
	if (file) {
		return file;
	}
	for (let i = fenceLine - 1; i >= Math.max(0, fenceLine - 4); i--) {
		const l = lines[i].trim();
		if (!l) {
			continue;
		}
		const heading = /^#{1,6}\s+(.+)$/.exec(l)?.[1] ?? /^\*\*(.+?)\*\*:?$/.exec(l)?.[1] ?? /^(.{3,80}):$/.exec(l)?.[1];
		if (heading) {
			return clean(heading);
		}
		const path = /`([\w./-]+\.[a-z0-9]{1,6})`/i.exec(l)?.[1];
		if (path) {
			return path;
		}
		break;
	}
	return undefined;
}

/** The artifacts in one answer, in order. */
export function findInAnswer(text: string): Found[] {
	const out: Found[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
		if (open) {
			const fence = open[1];
			const info = open[2].trim();
			let j = i + 1;
			while (j < lines.length && !new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[j])) {
				j++;
			}
			if (j >= lines.length) {
				break; // an unclosed block is not an artifact
			}
			const body = lines.slice(i + 1, j).join('\n');
			const language = info.split(/\s+/)[0].toLowerCase();
			const kind = KIND_BY_LANGUAGE[language] ?? (j - i - 1 >= MIN_CODE_LINES && language && !['text', 'txt', 'console', 'shell-session', 'log', 'output'].includes(language) ? 'code' : undefined);
			if (kind && body.trim()) {
				const title = titleFor(lines, i, info) ?? defaultTitle(kind, body, language);
				out.push({ kind, title, content: body, ...(language ? { language } : {}) });
			}
			i = j;
			continue;
		}
		for (const m of lines[i].matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
			out.push({ kind: 'image', title: clean(m[1]) || m[2].split('/').pop()!.slice(0, 60), content: m[2], language: 'link' });
		}
	}
	return out;
}

function defaultTitle(kind: ArtifactKind, body: string, language: string): string {
	const first = body.split('\n').map(l => l.trim()).find(Boolean) ?? '';
	if (kind === 'document') {
		return clean(/^#{1,6}\s+(.+)$/.exec(first)?.[1] ?? first).slice(0, 60) || 'Dokumentum';
	}
	if (kind === 'page') {
		return clean(/<title>([^<]+)<\/title>/i.exec(body)?.[1] ?? /<h1[^>]*>([^<]+)</i.exec(body)?.[1] ?? '') || 'Oldal';
	}
	if (kind === 'diagram') {
		return `${first.split(/\s+/)[0] || 'mermaid'} ábra`;
	}
	return `${language || 'kód'} · ${clean(first).slice(0, 40)}`;
}

const keyOf = (roomId: string, kind: ArtifactKind, title: string) => `${roomId}|${kind}|${title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`;

/** A room's artifacts with their versions, newest version last. */
export function roomArtifacts(room: RoomState, extra: readonly { title: string; kind: ArtifactKind; versions: readonly ArtifactVersion[]; agentId: string; agentName: string }[] = []): Artifact[] {
	const byKey = new Map<string, { a: Omit<Artifact, 'versions'>; versions: ArtifactVersion[] }>();
	const add = (kind: ArtifactKind, title: string, agentId: string, agentName: string, v: Omit<ArtifactVersion, 'n'>) => {
		const key = keyOf(room.id, kind, title);
		let entry = byKey.get(key);
		if (!entry) {
			entry = { a: { key, kind, title, roomId: room.id, roomTitle: room.title, ...(room.project ? { project: room.project } : {}), agentId, agentName }, versions: [] };
			byKey.set(key, entry);
		}
		if (entry.versions.at(-1)?.content === v.content) {
			return; // repeated unchanged: not a new version
		}
		entry.versions.push({ ...v, n: entry.versions.length + 1 });
		entry.a = { ...entry.a, agentId, agentName }; // the latest version's author
	};
	for (const m of room.messages as readonly Message[]) {
		if (m.author.kind !== 'agent') {
			continue;
		}
		for (const f of findInAnswer(m.text)) {
			add(f.kind, f.title, m.author.id, m.author.name, { at: m.at, messageId: m.id, content: f.content, ...(f.language ? { language: f.language } : {}) });
		}
	}
	for (const e of extra) {
		for (const v of e.versions) {
			add(e.kind, e.title, e.agentId, e.agentName, v);
		}
	}
	return [...byKey.values()].map(e => ({ ...e.a, versions: e.versions }));
}

export interface ArtifactFilter {
	readonly query?: string;
	readonly project?: string;
	readonly kinds?: readonly ArtifactKind[];
	readonly agents?: readonly string[];
}

/** The gallery's list: filtered, pinned first (when asked), then newest first. */
export function filterArtifacts(all: readonly Artifact[], filter: ArtifactFilter, pinned: ReadonlySet<string>, pinnedFirst = true): Artifact[] {
	const q = filter.query?.trim().toLowerCase();
	const latest = (a: Artifact) => a.versions.at(-1)?.at ?? '';
	return all
		.filter(a => !filter.project || (a.project ?? '') === filter.project)
		.filter(a => !filter.kinds?.length || filter.kinds.includes(a.kind))
		.filter(a => !filter.agents?.length || filter.agents.some(n => a.agentName.toLowerCase().startsWith(n.toLowerCase())))
		.filter(a => !q || a.title.toLowerCase().includes(q) || a.roomTitle.toLowerCase().includes(q) || (a.versions.at(-1)?.content.toLowerCase().includes(q) ?? false))
		.sort((a, b) => (pinnedFirst ? Number(pinned.has(b.key)) - Number(pinned.has(a.key)) : 0) || latest(b).localeCompare(latest(a)));
}

/** The group of artifacts no agent is known for (an old record without its author). */
export const UNKNOWN_AUTHOR = 'unknown';

/** The artifact's author as a group key: its agent's id, or unknown. */
export const authorKey = (a: Pick<Artifact, 'agentId' | 'agentName'>): string => a.agentId && a.agentName ? a.agentId : UNKNOWN_AUTHOR;

/** The machine an agent runs on, from its id (`codex@prd` → `prd`); none: this machine. */
const machineOf = (agentId: string): string | undefined => agentId.includes('@') ? agentId.slice(agentId.indexOf('@') + 1) || undefined : undefined;

/**
 * Each author's label in the gallery: the agent's name (its latest), with the machine when two
 * agents share a name (`Claude · tenark-claude`), and `names.unknown` for artifacts without one.
 */
export function authorLabels(all: readonly Pick<Artifact, 'agentId' | 'agentName' | 'versions'>[], names: { readonly unknown: string; readonly local: string }): Map<string, string> {
	const latest = new Map<string, { name: string; at: string }>();
	for (const a of all) {
		const key = authorKey(a);
		const at = a.versions.at(-1)?.at ?? '';
		const known = latest.get(key);
		if (!known || at > known.at) {
			latest.set(key, { name: key === UNKNOWN_AUTHOR ? names.unknown : a.agentName, at });
		}
	}
	// Shared labels are told apart all at once, from the labels before the step.
	const apart = (labels: Map<string, string>, more: (key: string, label: string) => string) => {
		const shared = new Set([...labels.values()].filter((l, i, all) => all.indexOf(l) !== i));
		return new Map([...labels].map(([key, label]) => [key, key !== UNKNOWN_AUTHOR && shared.has(label) ? more(key, label) : label]));
	};
	const byName = new Map([...latest].map(([key, v]) => [key, v.name]));
	const byMachine = apart(byName, (key, name) => `${name} · ${machineOf(key) ?? names.local}`);
	return apart(byMachine, (key, label) => `${label} · ${key}`); // the same name on the same machine: the id tells them apart
}

export interface AuthorGroup<T> {
	readonly key: string;
	readonly label: string;
	readonly items: T[];
}

/** A sorted list by author: the groups in the order of their first item (newest first), each keeping the list's order. */
export function groupByAuthor<T extends Pick<Artifact, 'agentId' | 'agentName'>>(sorted: readonly T[], labels: ReadonlyMap<string, string>, unknown: string): AuthorGroup<T>[] {
	const groups = new Map<string, AuthorGroup<T>>();
	for (const a of sorted) {
		const key = authorKey(a);
		let group = groups.get(key);
		if (!group) {
			group = { key, label: labels.get(key) ?? (key === UNKNOWN_AUTHOR ? unknown : a.agentName), items: [] };
			groups.set(key, group);
		}
		group.items.push(a);
	}
	return [...groups.values()];
}

/** The file extension a version is saved with (open in a tab, send as @file). */
export function extensionFor(a: Pick<Artifact, 'kind'>, v: Pick<ArtifactVersion, 'language'>): string {
	switch (a.kind) {
		case 'diagram': return 'mmd';
		case 'document': return 'md';
		case 'page': return 'html';
		case 'image': return v.language === 'svg' ? 'svg' : 'txt';
		default: {
			const map: Record<string, string> = { typescript: 'ts', ts: 'ts', javascript: 'js', js: 'js', python: 'py', py: 'py', rust: 'rs', go: 'go', json: 'json', yaml: 'yaml', yml: 'yml', bash: 'sh', sh: 'sh', css: 'css', sql: 'sql', java: 'java', csharp: 'cs', cpp: 'cpp', c: 'c', ruby: 'rb', php: 'php', toml: 'toml', xml: 'xml' };
			return map[v.language ?? ''] ?? 'txt';
		}
	}
}

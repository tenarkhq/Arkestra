/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar's sections: the user makes them and puts threads into them. Nothing
 *  is filed on its own; a thread in no section waits under "No section".
 *--------------------------------------------------------------------------------------------*/

import type { ThreadSummary } from './threads';

export interface Section {
	readonly id: string;
	readonly name: string;
	readonly threadIds: readonly string[];
}

/** Sections from storage: bad entries dropped, a thread kept only in its first section. */
export function parseSections(raw: unknown): Section[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const ids = new Set<string>();
	const threads = new Set<string>();
	const out: Section[] = [];
	for (const entry of raw) {
		const s = entry as { id?: unknown; name?: unknown; threadIds?: unknown } | null;
		if (!s || typeof s.id !== 'string' || !s.id || ids.has(s.id) || typeof s.name !== 'string' || !s.name.trim()) {
			continue;
		}
		ids.add(s.id);
		const own = (Array.isArray(s.threadIds) ? s.threadIds : []).filter((t): t is string => typeof t === 'string' && !!t && !threads.has(t));
		own.forEach(t => threads.add(t));
		out.push({ id: s.id, name: s.name.trim(), threadIds: [...new Set(own)] });
	}
	return out;
}

/** A new section at the end; an empty name or a taken id changes nothing. */
export function addSection(list: readonly Section[], id: string, name: string): Section[] {
	const n = name.trim();
	if (!n || !id || list.some(s => s.id === id)) {
		return [...list];
	}
	return [...list, { id, name: n, threadIds: [] }];
}

export function renameSection(list: readonly Section[], id: string, name: string): Section[] {
	const n = name.trim();
	return list.map(s => s.id === id && n ? { ...s, name: n } : s);
}

/** Deletes a section; its threads go back to "No section". */
export function deleteSection(list: readonly Section[], id: string): Section[] {
	return list.filter(s => s.id !== id);
}

/** Moves a section before another one (`before` missing or unknown: to the end). */
export function moveSection(list: readonly Section[], id: string, before: string | undefined): Section[] {
	const moving = list.find(s => s.id === id);
	if (!moving || before === id) {
		return [...list];
	}
	const rest = list.filter(s => s.id !== id);
	const at = before === undefined ? -1 : rest.findIndex(s => s.id === before);
	return at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)];
}

/** One step up (-1) or down (+1). */
export function shiftSection(list: readonly Section[], id: string, delta: -1 | 1): Section[] {
	const i = list.findIndex(s => s.id === id);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= list.length) {
		return [...list];
	}
	const out = [...list];
	[out[i], out[j]] = [out[j], out[i]];
	return out;
}

/** Puts a thread into a section (out of any other); `undefined`: into no section. */
export function moveThread(list: readonly Section[], threadId: string, sectionId: string | undefined): Section[] {
	const target = sectionId !== undefined && list.some(s => s.id === sectionId) ? sectionId : undefined;
	return list.map(s => {
		const without = s.threadIds.filter(t => t !== threadId);
		return s.id === target ? { ...s, threadIds: [threadId, ...without] } : without.length === s.threadIds.length ? s : { ...s, threadIds: without };
	});
}

/** Drops the ids of threads that no longer exist; the same array when nothing went. */
export function keepThreads(list: readonly Section[], existing: ReadonlySet<string>): readonly Section[] {
	if (list.every(s => s.threadIds.every(t => existing.has(t)))) {
		return list;
	}
	return list.map(s => ({ ...s, threadIds: s.threadIds.filter(t => existing.has(t)) }));
}

export function sectionOf(list: readonly Section[], threadId: string): string | undefined {
	return list.find(s => s.threadIds.includes(threadId))?.id;
}

/** First run: the categories the user gave threads before become sections, by name. */
export function sectionsFromCategories(threads: readonly ThreadSummary[], newId: (index: number) => string): Section[] {
	const names = [...new Set(threads.map(t => t.category?.trim()).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
	return names.map((name, i) => ({ id: newId(i), name, threadIds: threads.filter(t => t.category?.trim() === name).map(t => t.id) }));
}

/** Search: every word of the query in the title, case and accents ignored. */
export function matches(title: string, query: string): boolean {
	const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const words = fold(query).split(/\s+/).filter(Boolean);
	const t = fold(title);
	return words.every(w => t.includes(w));
}

export interface SidebarLayout {
	readonly pinned: readonly ThreadSummary[];
	readonly sections: readonly { readonly section: Section; readonly threads: readonly ThreadSummary[] }[];
	readonly unsectioned: readonly ThreadSummary[];
	readonly archived: readonly ThreadSummary[];
}

const newestFirst = (a: ThreadSummary, b: ThreadSummary) => b.lastAt.localeCompare(a.lastAt) || a.title.localeCompare(b.title);

/**
 * Every thread once: archived at the end, pinned under Pinned, the rest in the section the user
 * put it in or under "No section". Newest first everywhere; sections keep the user's order.
 */
export function layoutThreads(threads: readonly ThreadSummary[], sections: readonly Section[], query = ''): SidebarLayout {
	const shown = threads.filter(t => matches(t.title, query));
	const live = shown.filter(t => !t.archived);
	const filed = new Map<string, string>();
	for (const s of sections) {
		for (const t of s.threadIds) {
			filed.set(t, s.id);
		}
	}
	const rest = live.filter(t => !t.pinned);
	return {
		pinned: live.filter(t => t.pinned).sort(newestFirst),
		sections: sections.map(section => ({ section, threads: rest.filter(t => filed.get(t.id) === section.id).sort(newestFirst) })),
		unsectioned: rest.filter(t => !filed.has(t.id)).sort(newestFirst),
		archived: shown.filter(t => t.archived).sort(newestFirst),
	};
}

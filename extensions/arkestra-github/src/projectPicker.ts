/*---------------------------------------------------------------------------------------------
 *  Arkestra. The board's own project list (Follow a project…): the rows the page draws in place
 *  of a quick pick at the top. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import type { ProjectChoice } from './project';

/** The board's own project list (Follow a project…), as the page draws it. */
export interface ProjectPicker {
	readonly loading: boolean;
	readonly projects: readonly { readonly ref: string; readonly title: string; readonly detail: string; readonly current: boolean }[];
	readonly listError?: string;
	readonly error?: string;
	readonly current: string;
}

/** The picker's rows: open projects first, each with owner/number, closed and current marked. */
export function pickerProjects(projects: readonly ProjectChoice[], current: string, t: { closed: string; current: string }): ProjectPicker['projects'] {
	const open = projects.filter(p => !p.closed);
	const closed = projects.filter(p => p.closed);
	return [...open, ...closed].map(p => {
		const ref = `${p.owner}/${p.number}`;
		const now = ref.toLowerCase() === current.trim().toLowerCase();
		return { ref, title: p.title, detail: [ref, p.closed ? t.closed : '', now ? t.current : ''].filter(Boolean).join(' · '), current: now };
	});
}

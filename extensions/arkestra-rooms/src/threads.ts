/*---------------------------------------------------------------------------------------------
 *  Arkestra. Every chat thread is its own room: the room id travels in the chat result's
 *  metadata, so the next request in the same thread finds it again in the history.
 *--------------------------------------------------------------------------------------------*/

import type { Message, RoomState } from './room';
import { withoutAttachments } from './references';

export const ROOM_ID_KEY = 'arkestraRoomId';

/** The room id of the thread from its history (the newest answer that carries one), if any. */
export function roomIdFromHistory(history: readonly unknown[]): string | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const id = (history[i] as { result?: { metadata?: Record<string, unknown> } })?.result?.metadata?.[ROOM_ID_KEY];
		if (typeof id === 'string' && /^[A-Za-z0-9-]+$/.test(id)) {
			return id;
		}
	}
	return undefined;
}

/** A room title from the thread's first message. */
export function titleFrom(prompt: string, fallback: string): string {
	const line = prompt.trim().split('\n')[0].trim();
	if (!line) {
		return fallback;
	}
	return line.length > 48 ? line.slice(0, 47).trimEnd() + '…' : line;
}


/** The URI scheme of rooms as native chat sessions: `arkestra-room:/room/<id>`. */
export const ROOM_SCHEME = 'arkestra-room';

export function roomIdFromSessionPath(path: string): string | undefined {
	const match = /^\/room\/([A-Za-z0-9-]+)$/.exec(path);
	return match?.[1];
}

/** A room's messages as chat history: each user message a request, everything after it its response. */
export type HistoryTurn = { readonly kind: 'request'; readonly prompt: string } | { readonly kind: 'response'; readonly markdown: string };

export function historyTurns(messages: readonly Message[]): HistoryTurn[] {
	const turns: HistoryTurn[] = [];
	let response: string[] = [];
	let leading: string[] = [];
	const flush = () => {
		if (response.length) {
			turns.push({ kind: 'response', markdown: response.join('\n\n') });
			response = [];
		}
	};
	for (const m of messages) {
		if (m.author.kind === 'user') {
			flush();
			const { message, count } = withoutAttachments(m.text);
			turns.push({ kind: 'request', prompt: count ? `${message}\n\n_(+${count} hivatkozott anyag)_` : message });
			if (leading.length) {
				response.push(...leading);
				leading = [];
			}
			continue;
		}
		const part = m.author.kind === 'agent' ? `**${m.author.name}**\n\n${m.text}`
			: m.to ? `_${m.author.name}: ${instructionLine(m.text)}_`
				: `_${m.text}_`;
		(turns.length ? response : leading).push(part);
	}
	flush();
	return turns;
}

/** A template's instruction in the thread: its own part (after the briefing), first line. */
export function instructionLine(text: string): string {
	const own = text.split(/\n---\n/).at(-1)!.trim();
	const first = own.split('\n').find(l => l.trim())?.trim() ?? '';
	return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

export interface ThreadSummary {
	readonly id: string;
	readonly title: string;
	readonly project?: string;
	readonly category?: string;
	readonly pinned: boolean;
	/** ISO time of the last message, or empty. */
	readonly lastAt: string;
	readonly agents: number;
}

export function summarize(state: RoomState): ThreadSummary {
	return {
		id: state.id,
		title: state.title,
		...(state.project ? { project: state.project } : {}),
		...(state.category ? { category: state.category } : {}),
		pinned: !!state.pinned,
		lastAt: state.messages.at(-1)?.at ?? '',
		agents: state.roster.length,
	};
}

/** A project's threads for the left column: pinned first, then by category, newest first inside each. */
export interface ProjectThreads {
	readonly project: string | undefined;
	readonly pinned: readonly ThreadSummary[];
	readonly uncategorized: readonly ThreadSummary[];
	readonly categories: readonly { readonly name: string; readonly threads: readonly ThreadSummary[] }[];
	readonly count: number;
}

const newestFirst = (a: ThreadSummary, b: ThreadSummary) => b.lastAt.localeCompare(a.lastAt) || a.title.localeCompare(b.title);

export function groupThreads(threads: readonly ThreadSummary[], currentProject: string | undefined): { current: ProjectThreads; others: ProjectThreads[] } {
	const byProject = new Map<string | undefined, ThreadSummary[]>();
	for (const t of threads) {
		byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);
	}
	const group = (project: string | undefined, list: readonly ThreadSummary[]): ProjectThreads => {
		const pinned = list.filter(t => t.pinned).sort(newestFirst);
		const rest = list.filter(t => !t.pinned);
		const names = [...new Set(rest.map(t => t.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
		return {
			project,
			pinned,
			uncategorized: rest.filter(t => !t.category).sort(newestFirst),
			categories: names.map(name => ({ name, threads: rest.filter(t => t.category === name).sort(newestFirst) })),
			count: list.length,
		};
	};
	const current = group(currentProject, byProject.get(currentProject) ?? []);
	byProject.delete(currentProject);
	const others = [...byProject.entries()]
		.map(([project, list]) => group(project, list))
		.sort((a, b) => (a.project === undefined ? 1 : b.project === undefined ? -1 : projectName(a.project).localeCompare(projectName(b.project))));
	return { current, others };
}

/** The display name of a project (workspace folder URI): its last path segment. */
export function projectName(project: string | undefined): string {
	if (!project) {
		return '';
	}
	const path = project.replace(/\/+$/, '');
	return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || project;
}

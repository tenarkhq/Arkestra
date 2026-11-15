/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar's default listing: every thread and every CLI session of every
 *  connected machine, grouped by agent (Claude, Codex, ...), newest first. A session continued
 *  here shows as its thread's row; a session or thread the user put into a section shows only
 *  there (sections and Pinned come before this listing). No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import { machineOf } from './machinesModel';
import { matches } from './sections';
import { agentKind, isLocalAgent, type ListedSession } from './sessionHome';
import type { ThreadSummary } from './threads';

/** One agent's listing of its machine's sessions (the last one that worked). */
export interface AgentListing {
	readonly agentId: string;
	readonly sessions: readonly ListedSession[];
}

/** A session no thread continues yet: opening, moving or pinning it continues it first. */
export interface SessionEntry {
	readonly agentId: string;
	readonly session: ListedSession;
}

export type GroupItem =
	| { readonly kind: 'thread'; readonly thread: ThreadSummary; readonly at: string; readonly machine?: string; readonly running: boolean }
	| { readonly kind: 'session'; readonly entry: SessionEntry; readonly at: string; readonly machine: string; readonly running: boolean };

/**
 * One agent's group: `claude`, `codex` (or another CLI's id), `several` (a thread several kinds
 * of agents work in) or `other` (a thread with no agent yet). `older`: past the recent window.
 */
export interface AgentGroup {
	readonly id: string;
	readonly items: readonly GroupItem[];
	readonly older: readonly GroupItem[];
}

/** Sessions newer than this many days show; the rest wait behind "Show older". */
export const RECENT_DAYS = 30;
/** A session whose file changed this recently is shown as running. */
export const RUNNING_MS = 120_000;

/** `<agentId>\n<sessionId>`, the id of a session row. */
export function sessionRowId(agentId: string, sessionId: string): string {
	return `${agentId}\n${sessionId}`;
}

/** The same session wherever it is listed: its CLI and its id (a copy here has the server's id). */
const sameSession = (agentId: string, sessionId: string) => `${agentKind(agentId)}\n${sessionId}`;

/** Which group a thread belongs to: its continued session's CLI, else its agents' one kind. */
export function threadGroup(t: ThreadSummary): string {
	const adopted = t.adopted?.[0];
	if (adopted) {
		return agentKind(adopted.agent);
	}
	const kinds = [...new Set((t.roster ?? []).map(agentKind))];
	return kinds.length === 1 ? kinds[0] : kinds.length ? 'several' : 'other';
}

/** The machine a thread's work runs on: its continued session's, else its only agent's. */
export function threadMachine(t: ThreadSummary): string | undefined {
	const agent = t.adopted?.[0]?.agent ?? (t.roster?.length === 1 ? t.roster[0] : undefined);
	return agent ? machineOf(agent) : undefined;
}

/**
 * The sessions to list, each once: a session several agents list (a copy here and its SSH
 * machine) is the SSH machine's; a copy here that no SSH machine lists is left out while an SSH
 * agent of its CLI exists (that machine owns it; its listing failed or does not reach that far).
 */
export function uniqueSessions(listings: readonly AgentListing[]): SessionEntry[] {
	const remoteKinds = new Set(listings.filter(l => !isLocalAgent(l.agentId)).map(l => agentKind(l.agentId)));
	const byKey = new Map<string, SessionEntry>();
	for (const l of listings) {
		for (const session of l.sessions) {
			if (session.elsewhere && remoteKinds.has(agentKind(l.agentId))) {
				continue;
			}
			const key = sameSession(l.agentId, session.id);
			const had = byKey.get(key);
			if (!had || (isLocalAgent(had.agentId) && !isLocalAgent(l.agentId))) {
				byKey.set(key, { agentId: l.agentId, session });
			}
		}
	}
	return [...byKey.values()];
}

const GROUP_ORDER = ['claude', 'codex'];
const LAST = ['several', 'other'];

/** Claude, Codex, the other CLIs by name, then the threads of several agents, then those of none. */
export function groupOrder(a: string, b: string, label: (id: string) => string = id => id): number {
	const rank = (id: string) => GROUP_ORDER.includes(id) ? GROUP_ORDER.indexOf(id) : LAST.includes(id) ? 100 + LAST.indexOf(id) : 50;
	return rank(a) - rank(b) || label(a).localeCompare(label(b));
}

const time = (iso: string) => Date.parse(iso) || 0;

/**
 * The agent groups under Pinned and the sections. `threads`: those the default listing shows
 * (not pinned, in no section, not archived); `all`: every thread, so that a session a thread
 * continues anywhere (a section, Pinned, Archived) never shows a second time.
 */
export function agentGroups(input: {
	readonly threads: readonly ThreadSummary[];
	readonly all: readonly ThreadSummary[];
	readonly listings: readonly AgentListing[];
	readonly query: string;
	readonly now: number;
	readonly busy: (threadId: string) => boolean;
	readonly label?: (groupId: string) => string;
	readonly days?: number;
}): AgentGroup[] {
	const sessions = uniqueSessions(input.listings);
	const listed = new Map(sessions.map(e => [sameSession(e.agentId, e.session.id), e.session]));
	const continued = new Set(input.all.flatMap(t => (t.adopted ?? []).map(a => sameSession(a.agent, a.session))));
	const recentFrom = input.now - (input.days ?? RECENT_DAYS) * 86_400_000;
	const fresh = (iso: string) => input.now - time(iso) < RUNNING_MS;
	const items: { group: string; item: GroupItem }[] = [];
	for (const t of input.threads) {
		if (!matches(t.title, input.query)) {
			continue;
		}
		const own = (t.adopted ?? []).map(a => listed.get(sameSession(a.agent, a.session))).filter((s): s is ListedSession => !!s);
		const at = [t.lastAt, ...own.map(s => s.updatedAt)].reduce((a, b) => time(b) > time(a) ? b : a, '');
		const machine = threadMachine(t);
		items.push({ group: threadGroup(t), item: { kind: 'thread', thread: t, at, ...(machine ? { machine } : {}), running: input.busy(t.id) || own.some(s => fresh(s.updatedAt)) } });
	}
	for (const entry of sessions) {
		if (continued.has(sameSession(entry.agentId, entry.session.id)) || !matches(entry.session.title, input.query)) {
			continue;
		}
		items.push({ group: agentKind(entry.agentId), item: { kind: 'session', entry, at: entry.session.updatedAt, machine: machineOf(entry.agentId), running: fresh(entry.session.updatedAt) } });
	}
	const title = (i: GroupItem) => i.kind === 'thread' ? i.thread.title : i.entry.session.title;
	const newestFirst = (a: GroupItem, b: GroupItem) => time(b.at) - time(a.at) || title(a).localeCompare(title(b));
	const ids = [...new Set(items.map(i => i.group))].sort((a, b) => groupOrder(a, b, input.label));
	return ids.map(id => {
		const own = items.filter(i => i.group === id).map(i => i.item).sort(newestFirst);
		// While searching every match shows; a running one is never folded away.
		const recent = (i: GroupItem) => !!input.query.trim() || i.running || time(i.at) >= recentFrom || (i.kind === 'thread' && !i.at);
		return { id, items: own.filter(recent), older: own.filter(i => !recent(i)) };
	});
}

/** How many machines the listed rows come from: a row names its machine only when there are several. */
export function machineCount(groups: readonly AgentGroup[]): number {
	return new Set(groups.flatMap(g => [...g.items, ...g.older].map(i => i.machine).filter((m): m is string => !!m))).size;
}

/** A chat row's status dot: runs, waits for the user, stuck, or done with an answer not seen yet. */
export type RowState = 'run' | 'wait' | 'err' | 'done';

/**
 * The dot of one row. Waiting for the user beats everything (a question, a permission, a plan to
 * execute), then a stuck turn, then running; "done" only for an answer not seen yet, which the
 * Claude app's account knows for its sessions and Arkestra for its own threads.
 */
export function rowState(input: {
	readonly running: boolean;
	readonly failed?: boolean;
	readonly planWaiting?: boolean;
	readonly cloud?: { readonly worker?: string; readonly unread?: boolean };
	readonly answeredAt?: string;
	readonly viewedAt?: string;
	readonly selected?: boolean;
}): RowState | undefined {
	if (input.cloud?.worker === 'requires_action' || input.planWaiting) {
		return 'wait';
	}
	if (input.failed) {
		return 'err';
	}
	if (input.running || input.cloud?.worker === 'running') {
		return 'run';
	}
	if (input.selected) {
		return undefined;
	}
	const unseen = input.cloud ? !!input.cloud.unread : !!input.answeredAt && (!input.viewedAt || input.answeredAt > input.viewedAt);
	return unseen ? 'done' : undefined;
}

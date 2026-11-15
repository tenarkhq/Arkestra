/*---------------------------------------------------------------------------------------------
 *  Arkestra. Where a CLI session really lives (AR39). This machine can hold a copy of an SSH
 *  machine's sessions (the vendor's desktop app keeps them in ~/.claude/projects too): such a
 *  copy does not grow, and a turn there would run on the wrong machine. A session whose folder
 *  is not here and that the SSH machine has is that machine's. No VS Code.
 *--------------------------------------------------------------------------------------------*/

import type { Agent, ExistingSession } from './agent';
import { artifactsFromSessionLines, mergeProduced } from './produced';
import { mergeHistory, sessionHistoryOf, withMeta, type Message, type RoomState } from './room';

/** A session as the Machines list shows it; `elsewhere`: a copy from another machine that no SSH machine here lists. */
export type ListedSession = ExistingSession & { readonly elsewhere?: boolean };

/** The CLI an agent runs, without its machine: `claude@prd` → `claude`. */
export function agentKind(agentId: string): string {
	const at = agentId.indexOf('@');
	return at >= 0 ? agentId.slice(0, at) : agentId;
}

/** Whether an agent runs on this machine (its id names no machine). */
export function isLocalAgent(agentId: string): boolean {
	return !agentId.includes('@');
}

/** A session of this machine's agent that worked in a folder this machine does not have: a copy. */
export function isForeign(agentId: string, cwd: string | undefined, isLocalFolder: (cwd: string) => boolean): boolean {
	return isLocalAgent(agentId) && !!cwd && !isLocalFolder(cwd);
}

/**
 * This machine's sessions for the Machines list: a copy that an SSH machine lists is left to
 * that machine; a copy nobody lists stays, marked as one.
 */
export function placeLocalSessions(agentId: string, local: readonly ExistingSession[], isLocalFolder: (cwd: string) => boolean, remote: readonly (readonly ExistingSession[])[]): ListedSession[] {
	const there = new Set(remote.flatMap(list => list.map(s => s.id)));
	return local.flatMap((s): ListedSession[] => !isForeign(agentId, s.cwd, isLocalFolder) ? [s] : there.has(s.id) ? [] : [{ ...s, elsewhere: true }]);
}

/** The SSH agent (same CLI) whose machine has the session a copy here stands for, with its listing of it. */
export function homeOf<A extends { readonly id: string }>(agentId: string, session: { readonly id: string; readonly cwd?: string }, isLocalFolder: (cwd: string) => boolean, candidates: readonly { readonly agent: A; readonly sessions: readonly ExistingSession[] }[]): { agent: A; session: ExistingSession } | undefined {
	if (!isForeign(agentId, session.cwd, isLocalFolder)) {
		return undefined;
	}
	for (const c of candidates) {
		const found = !isLocalAgent(c.agent.id) && agentKind(c.agent.id) === agentKind(agentId) ? c.sessions.find(s => s.id === session.id) : undefined;
		if (found) {
			return { agent: c.agent, session: found };
		}
	}
	return undefined;
}

/**
 * Moves a thread that follows a copy here to the SSH agent that has the session: its place in
 * the roster, the adopted session (its follow starts again), the model choice, and its messages'
 * author and source; a project that was only the copy's folder is dropped. True when it moved.
 */
export function rehome(state: RoomState, from: string, to: { readonly id: string; readonly name: string; readonly cwd?: string }): boolean {
	const link = state.adopted?.[from];
	if (!link || from === to.id) {
		return false;
	}
	const { cursor: _cursor, ...rest } = link;
	const adopted = { ...state.adopted };
	delete adopted[from];
	// The session's folder as its machine names it (a copy may name another path).
	adopted[to.id] = to.cwd ? { ...rest, cwd: to.cwd } : rest;
	state.adopted = adopted;
	state.roster = [...new Set(state.roster.map(id => id === from ? to.id : id))];
	if (state.choices?.[from]) {
		const choices = { ...state.choices, [to.id]: state.choices[from] };
		delete choices[from];
		state.choices = choices;
	}
	state.messages = state.messages.map((m): Message => {
		const author = m.author.kind === 'agent' && m.author.id === from ? { kind: 'agent' as const, id: to.id, name: to.name } : m.author;
		const source = m.source?.agent === from ? { ...m.source, agent: to.id } : m.source;
		// "… session continued here (folder)." names the folder where the session now is.
		const old = `session continued here (${link.cwd}).`;
		const text = m.author.kind === 'system' && to.cwd && link.cwd && to.cwd !== link.cwd && m.text.endsWith(old) ? m.text.slice(0, -old.length) + `session continued here (${to.cwd}).` : m.text;
		return author === m.author && source === m.source && text === m.text ? m : { ...m, author, text, ...(source ? { source } : {}) };
	});
	if (state.project && link.cwd && filePath(state.project) === link.cwd) {
		delete state.project;
	}
	return true;
}

function filePath(uri: string): string | undefined {
	try {
		return /^file:/.test(uri) ? decodeURIComponent(new URL(uri).pathname) : undefined;
	} catch {
		return undefined;
	}
}

/** The thread's line where the CLI compacted its conversation. */
export const COMPACTED = 'Conversation compacted';

/** A background task's report (`<task-notification>`) as a short line: its summaries. */
export function taskNotice(text: string): string | undefined {
	if (!text.trimStart().startsWith('<task-notification>')) {
		return undefined;
	}
	const summaries = [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1].trim()).filter(Boolean);
	return summaries.join(' · ') || 'Background task finished';
}

/**
 * A thread imported by an older build can hold what the CLI wrote for itself as the user's
 * messages: a compaction's summary, a task report's XML. They become the short lines the import
 * makes now. True when something changed.
 */
export function cleanSessionMessages(state: RoomState): boolean {
	let changed = false;
	const out: Message[] = [];
	for (const m of state.messages) {
		const text = m.author.kind !== 'user' ? undefined : /This session is being continued from a previous conversation/.test(m.text.slice(0, 1000)) ? COMPACTED : taskNotice(m.text);
		if (text === undefined) {
			out.push(m);
			continue;
		}
		changed = true;
		const last = out.at(-1);
		if (text === COMPACTED && last?.author.kind === 'system' && last.text === COMPACTED) {
			continue; // the compaction's own line is there already (read again from the session)
		}
		out.push({ ...m, author: { kind: 'system', id: 'system', name: 'Arkestra' }, text });
	}
	state.messages = out;
	return changed;
}

/** The fullest context the adopted sessions of these agents report, in tokens (their window is not known). */
export function sessionContext(state: RoomState, roster: readonly string[]): number | undefined {
	const used = roster.map(id => state.adopted?.[id]?.context).filter((n): n is number => typeof n === 'number' && n > 0);
	return used.length ? Math.max(...used) : undefined;
}

/**
 * Once per open of a thread that continues sessions: one that follows a copy of an SSH
 * machine's session moves to that machine's agent (`home` finds it) and reads the session there;
 * one an older reader imported (`Agent.historyVersion`) reads it again. What the thread lacks
 * goes in at its place, and the follow goes on from the read's cursor. True when it changed.
 */
export async function healAdopted(state: RoomState, registry: { get(id: string): Agent | undefined }, home: (agentId: string, session: { readonly id: string; readonly cwd?: string }) => Promise<{ readonly agent: Agent; readonly session?: { readonly cwd?: string } } | undefined>): Promise<boolean> {
	let changed = false;
	for (const [agentId, link] of Object.entries(state.adopted ?? {})) {
		let id = agentId;
		let agent = registry.get(agentId);
		const found = await home(agentId, { id: link.session, ...(link.cwd ? { cwd: link.cwd } : {}) }).catch(() => undefined);
		if (found && rehome(state, agentId, { id: found.agent.id, name: found.agent.name, ...(found.session?.cwd ? { cwd: found.session.cwd } : {}) })) {
			id = found.agent.id;
			agent = found.agent;
			changed = true;
		}
		const now = state.adopted?.[id];
		if (!now || !agent?.sessionHistory || (id === agentId && (agent.historyVersion ?? 1) <= (now.version ?? 1))) {
			continue;
		}
		// Not read: read again on the next open; a moved thread follows from the session's end meanwhile.
		changed = await readAgain(state, id, agent) || changed;
	}
	return changed;
}

/**
 * Reads an adopted session once more into its thread: what the thread lacks goes in at its
 * place, what the agent produced with its tools is kept (AR26; a thread read by an older reader
 * has none), and the follow goes on from the read's cursor. False when it could not be read.
 */
export async function readAgain(state: RoomState, id: string, agent: Agent): Promise<boolean> {
	const now = state.adopted?.[id];
	const read = now && agent.sessionHistory ? await agent.sessionHistory(now.session).catch(() => undefined) : undefined;
	if (!now || read === undefined) {
		return false;
	}
	const { entries, cursor, meta, lines } = sessionHistoryOf(read);
	mergeHistory(state, { id, name: agent.name }, entries);
	cleanSessionMessages(state);
	const produced = lines?.length ? mergeProduced(state.produced, artifactsFromSessionLines(lines, id)) : undefined;
	if (produced) {
		state.produced = produced;
	}
	state.adopted = { ...state.adopted, [id]: withMeta({ ...now, ...(cursor !== undefined ? { cursor } : {}), ...(agent.historyVersion !== undefined ? { version: agent.historyVersion } : {}) }, meta) };
	return true;
}

/**
 * The SSH agent (same CLI) whose machine lists this thread's session too: where a thread whose
 * local agent cannot run here (its CLI is not installed) can go on. Only for a local agent.
 */
export function elsewhere<A extends { readonly id: string }>(agentId: string, sessionId: string | undefined, candidates: readonly { readonly agent: A; readonly sessions: readonly ExistingSession[] }[]): A | undefined {
	if (!sessionId || !isLocalAgent(agentId)) {
		return undefined;
	}
	return candidates.find(c => !isLocalAgent(c.agent.id) && agentKind(c.agent.id) === agentKind(agentId) && c.sessions.some(s => s.id === sessionId))?.agent;
}

/**
 * Moves the thread from this computer's agent to the SSH agent that has its session (the
 * user's choice: "Continue on tenark-claude"), then reads the session there. True when it moved.
 */
export async function continueOn(state: RoomState, from: string, to: Agent): Promise<boolean> {
	if (!rehome(state, from, { id: to.id, name: to.name })) {
		return false;
	}
	await readAgain(state, to.id, to);
	return true;
}

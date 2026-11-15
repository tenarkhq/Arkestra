/*---------------------------------------------------------------------------------------------
 *  Arkestra. What the Machines page shows: this machine and each SSH machine, and under each
 *  the sessions of all its agents' CLIs together, newest first. No VS Code here, so it is
 *  testable.
 *--------------------------------------------------------------------------------------------*/

import type { ExistingSession } from './agent';

/** This machine's id; an SSH machine has the id of its `arkestra.connections.machines` entry. */
export const LOCAL = 'local';

/** A machine of the `arkestra.connections.machines` setting. */
export interface MachineEntry {
	readonly id: string;
	readonly name: string;
	/** The SSH destination: user@host or an alias of ~/.ssh/config, with its port. */
	readonly host: string;
	/** The project folder set for it (~/… on the remote home); unset: the home folder. */
	readonly folder?: string;
}

/** What one agent's listing gave: still running, its sessions, or why it failed. */
export type Listing =
	| { readonly state: 'loading' }
	| { readonly state: 'ok'; readonly sessions: readonly ExistingSession[] }
	| { readonly state: 'error'; readonly message: string };

/** An agent whose CLI sessions can be continued here, as the left bar's source names it. */
export interface ListedAgent {
	readonly id: string;
	readonly name: string;
}

export type AgentKind = 'claude' | 'codex' | 'other';

export interface PageSession {
	/** `<agentId>\n<sessionId>`: the click sends it back. */
	readonly key: string;
	readonly kind: AgentKind;
	/** Claude, Codex: the agent without its machine. */
	readonly agent: string;
	readonly title: string;
	readonly folder: string;
	/** The whole folder, for the tooltip and the search. */
	readonly cwd: string;
	readonly updatedAt: string;
	readonly when: string;
	/** Continued here already: the room of its thread. */
	readonly thread?: string;
}

/**
 * `idle`: not read yet (folded), `loading`: a listing is running, `ok`: every listing worked,
 * `partial`: some failed, `error`: every one failed, `none`: no agent on the machine to ask.
 */
export type MachineState = 'idle' | 'loading' | 'ok' | 'partial' | 'error' | 'none';

/**
 * Whether the machine is reachable now: `connected`, `connecting` (the first check runs),
 * `unreachable` (the network or the host does not answer; the reason is the tooltip),
 * `error` (it answers but refuses or fails: a key, a host key, no ssh; the reason is shown),
 * `unknown` (no check exists for it: the Connections extension does not know it).
 */
export type ConnectionState = 'connected' | 'connecting' | 'unreachable' | 'error' | 'unknown';

/** The Connections extension's check of one machine (its probe result). */
export interface ProbeLike {
	readonly reachable: boolean;
	readonly error?: string;
	/** The login's home folder on the machine. */
	readonly home?: string;
}

/** The last check of a machine and whether one runs now; `unknown`: the machine has no check. */
export interface ConnectionEntry {
	readonly checking: boolean;
	readonly result?: ProbeLike | 'unknown';
	/** When the result came (ms). */
	readonly at?: number;
}

export interface PageConnection {
	readonly state: ConnectionState;
	readonly reason?: string;
}

/** SSH's words for a host it cannot get to, as against one that answers and refuses. */
const UNREACHABLE = /timed? ?out|could not resolve|name or service not known|nodename nor servname|temporary failure in name resolution|connection refused|no route to host|network is (unreachable|down)|host is down|connection (closed|reset)|broken pipe|kex_exchange_identification/i;

/**
 * A machine's connection from its last check. This machine is always connected; a check that
 * runs again keeps the last result shown, so the page does not flicker every half minute.
 */
export function connectionState(local: boolean, entry: ConnectionEntry | undefined): PageConnection {
	if (local) {
		return { state: 'connected' };
	}
	const result = entry?.result;
	if (!result) {
		return { state: 'connecting' };
	}
	if (result === 'unknown') {
		return { state: 'unknown' };
	}
	if (result.reachable) {
		return { state: 'connected' };
	}
	const reason = result.error?.trim() || undefined;
	return { state: reason && !UNREACHABLE.test(reason) ? 'error' : 'unreachable', ...(reason ? { reason } : {}) };
}

/** Whether the page reads a machine's sessions: once it answers (or no check exists for it). */
export function canList(connection: PageConnection): boolean {
	return connection.state === 'connected' || connection.state === 'unknown';
}

/** Where a machine's terminals and new sessions start: its set folder on its real home, else the home. */
export function defaultFolder(configured: string | undefined, home: string | undefined): string {
	const folder = configured?.trim();
	if (!folder || folder === '~') {
		return home || '~';
	}
	return home && folder.startsWith('~/') ? `${home.replace(/\/+$/, '')}/${folder.slice(2)}` : folder;
}

export interface PageMachine {
	readonly id: string;
	readonly name: string;
	readonly host: string;
	readonly local: boolean;
	/** In the machine list of the Connections extension: it can be edited and removed. */
	readonly configured: boolean;
	/** Its default folder, resolved on its home once a check told it. */
	readonly folder: string;
	/** The folder as the connection has it (empty: the home folder), for the page's edit form. */
	readonly setFolder: string;
	readonly connection: PageConnection;
	/** When it was checked last (relative); empty for this machine and before the first answer. */
	readonly checked: string;
	/** Sessions per agent, of the agents read so far. */
	readonly counts: readonly { readonly kind: AgentKind; readonly agent: string; readonly n: number }[];
	readonly state: MachineState;
	readonly errors: readonly { readonly agent: string; readonly message: string }[];
	readonly sessions: readonly PageSession[];
}

export interface MachinesModel {
	readonly machines: readonly PageMachine[];
}

/** The machine an agent runs on: `codex@dev` runs on `dev`, `claude` here. */
export function machineOf(agentId: string): string {
	const at = agentId.indexOf('@');
	return at < 0 ? LOCAL : agentId.slice(at + 1);
}

export function agentKind(agentId: string): AgentKind {
	const base = agentId.replace(/@.*$/, '');
	return base === 'claude' || base === 'codex' ? base : 'other';
}

/** `Claude · dev` is Claude on the machine dev. */
export function agentLabel(name: string): string {
	return name.replace(/ · .*$/, '');
}

export function sessionKey(agentId: string, sessionId: string): string {
	return `${agentId}\n${sessionId}`;
}

/** Valid machines from the raw setting (the Connections extension's own rules, read only). */
export function readMachineEntries(raw: unknown): MachineEntry[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>([LOCAL]);
	const list: MachineEntry[] = [];
	for (const entry of raw) {
		const e = entry as { id?: unknown; name?: unknown; host?: unknown; port?: unknown; folder?: unknown } | null;
		if (!e || typeof e.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(e.id) || seen.has(e.id) || typeof e.host !== 'string' || !e.host.trim()) {
			continue;
		}
		seen.add(e.id);
		const host = e.host.trim() + (typeof e.port === 'number' && e.port > 0 ? `:${e.port}` : '');
		const folder = typeof e.folder === 'string' && e.folder.trim() ? e.folder.trim() : undefined;
		list.push({ id: e.id, name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : e.host.trim(), host, ...(folder ? { folder } : {}) });
	}
	return list;
}

/** `5 min ago`, `3 hours ago`, `yesterday`, else the date, in the user's language. */
export function relativeTime(iso: string, now: number, language: string): string {
	const at = Date.parse(iso);
	if (!iso || Number.isNaN(at)) {
		return '';
	}
	const seconds = Math.round((at - now) / 1000);
	const rtf = new Intl.RelativeTimeFormat(language || 'en', { numeric: 'auto' });
	const abs = Math.abs(seconds);
	if (abs < 60) {
		return rtf.format(0, 'second');
	}
	if (abs < 3600) {
		return rtf.format(Math.round(seconds / 60), 'minute');
	}
	if (abs < 86_400) {
		return rtf.format(Math.round(seconds / 3600), 'hour');
	}
	if (abs < 7 * 86_400) {
		return rtf.format(Math.round(seconds / 86_400), 'day');
	}
	return new Date(at).toLocaleDateString(language || 'en', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** A machine's state from its agents' listings (undefined: not asked yet). */
function stateOf(listings: readonly (Listing | undefined)[]): MachineState {
	if (!listings.length) {
		return 'none';
	}
	if (listings.every(l => !l)) {
		return 'idle';
	}
	if (listings.some(l => !l || l.state === 'loading')) {
		return 'loading';
	}
	const failed = listings.filter(l => l!.state === 'error').length;
	return failed === 0 ? 'ok' : failed === listings.length ? 'error' : 'partial';
}

/**
 * The page: this machine first, then the SSH machines in their setting's order, then a machine
 * only an agent still names. Under each, its agents' sessions together, newest first.
 */
export function machinesModel(input: {
	readonly machines: readonly MachineEntry[];
	readonly agents: readonly ListedAgent[];
	/** By agent id; an agent missing here has not been asked yet. */
	readonly listings: ReadonlyMap<string, Listing>;
	/** By session key: the room of the thread it was continued in. */
	readonly continued: ReadonlyMap<string, string>;
	/** By machine id: its connection checks. */
	readonly connections: ReadonlyMap<string, ConnectionEntry>;
	readonly labels: { readonly thisMachine: string; readonly local: string };
	/** This machine's default folder: the project, else the home folder. */
	readonly localFolder: string;
	readonly now: number;
	readonly language: string;
}): MachinesModel {
	const order: { id: string; name: string; host: string; folder?: string; configured: boolean }[] = [
		{ id: LOCAL, name: input.labels.thisMachine, host: input.labels.local, configured: false },
		...input.machines.map(m => ({ id: m.id, name: m.name, host: m.host, ...(m.folder ? { folder: m.folder } : {}), configured: true })),
	];
	for (const agent of input.agents) {
		const id = machineOf(agent.id);
		if (!order.some(m => m.id === id)) {
			order.push({ id, name: agent.name.includes(' · ') ? agent.name.replace(/^.*? · /, '') : id, host: '', configured: false });
		}
	}
	return {
		machines: order.map((m): PageMachine => {
			const agents = input.agents.filter(a => machineOf(a.id) === m.id);
			const sessions: PageSession[] = [];
			const errors: { agent: string; message: string }[] = [];
			const counts: { kind: AgentKind; agent: string; n: number }[] = [];
			for (const agent of agents) {
				const listing = input.listings.get(agent.id);
				if (listing?.state === 'error') {
					errors.push({ agent: agentLabel(agent.name), message: listing.message });
				} else if (listing?.state === 'ok') {
					counts.push({ kind: agentKind(agent.id), agent: agentLabel(agent.name), n: listing.sessions.length });
					for (const s of listing.sessions) {
						const key = sessionKey(agent.id, s.id);
						const thread = input.continued.get(key);
						sessions.push({
							key, kind: agentKind(agent.id), agent: agentLabel(agent.name), title: s.title || s.id,
							folder: s.cwd ? s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '' : '', cwd: s.cwd ?? '',
							updatedAt: s.updatedAt, when: relativeTime(s.updatedAt, input.now, input.language),
							...(thread ? { thread } : {}),
						});
					}
				}
			}
			sessions.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
			const state = stateOf(agents.map(a => input.listings.get(a.id)));
			const local = m.id === LOCAL;
			const check = input.connections.get(m.id);
			const home = check?.result && check.result !== 'unknown' ? check.result.home : undefined;
			return {
				id: m.id, name: m.name, host: m.host, local, configured: m.configured,
				folder: local ? input.localFolder : defaultFolder(m.folder, home),
				setFolder: m.folder ?? '',
				connection: connectionState(local, check),
				checked: !local && check?.at ? relativeTime(new Date(check.at).toISOString(), input.now, input.language) : '',
				counts, state, errors, sessions,
			};
		}),
	};
}

/** The page's filters: agent kind, machine id, and a search over the title and the folder. */
export interface MachinesFilter {
	readonly agent: string;
	readonly machine: string;
	readonly query: string;
}

/** Whether a session passes the filters. The page runs this very function (its source is inlined). */
export function sessionMatches(s: { kind: string; title: string; cwd: string }, machineId: string, f: MachinesFilter): boolean {
	if (f.agent && s.kind !== f.agent) {
		return false;
	}
	if (f.machine && machineId !== f.machine) {
		return false;
	}
	const q = f.query.trim().toLowerCase();
	return !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q);
}

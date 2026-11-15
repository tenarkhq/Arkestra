/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar as one page (arkestra.sidebar): New chat, Search, Boards, Artifacts,
 *  Machines, then Pinned, the user's sections, every thread and CLI session of the connected
 *  machines grouped by agent, and the archived ones. The user makes the sections and puts
 *  threads into them, which takes them out of the agent lists; nothing is filed on its own.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ListedSession } from './sessionHome';
import { agentGroups, machineCount as rowMachines, sessionRowId, threadGroup, threadMachine, type AgentListing, type GroupItem, type SessionEntry } from './leftBar';
import { LOCAL, readMachineEntries, relativeTime } from './machinesModel';
import { addSection, deleteSection, keepThreads, layoutThreads, matches, moveSection, moveThread, parseSections, renameSection, sectionOf, sectionsFromCategories, shiftSection, type Section } from './sections';
import { MachinesPage } from './machinesPage';
import { THREAD_VIEW_TYPE } from './threadView';
import { sidebarHtml, type SidebarGroup, type SidebarMessage, type SidebarModel, type SidebarRow, type SidebarStrings } from './sidebarHtml';
import { FONT_ROOT, pageFonts } from './webviewFonts';
import { projectName, type ThreadSummary } from './threads';

/** The sections in globalState: [{ id, name, threadIds }]. */
export /** A non-empty string from the page. */
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const SECTIONS_KEY = 'arkestra.rooms.sections';
const NEW_CHAT = 'arkestra.rooms.newChat';
/** While the bar is visible its machines' sessions are read again this often. */
const POLL_MS = 30_000;
/** A machine whose listing failed is asked again only after this long (it may be off). */
const RETRY_MS = 120_000;
/** Renders this soon after something the user did show at once, even under the mouse. */
const LOUD_MS = 3_000;

export interface SidebarBoard { readonly key: string; readonly title: string; readonly workspace: boolean; readonly pinned: boolean }

/** A CLI whose sessions on its machine can be continued here (AR39). */
export interface MachineSessions {
	readonly id: string;
	readonly name: string;
	/**
	 * Newest first; this machine's list leaves out the copies an SSH machine has and marks the
	 * others. `fresh`: read the machine again instead of a listing kept from the last minutes.
	 */
	sessions(fresh?: boolean): Promise<readonly ListedSession[]>;
}

/** What the page shows, fed by the extension. */
export interface SidebarSource {
	threads(): Promise<ThreadSummary[]>;
	busy(roomId: string): boolean;
	/** The room of the thread used last. */
	currentThread(): string | undefined;
	boards(): readonly SidebarBoard[];
	pinnedArtifacts(): Promise<readonly { key: string; title: string; kind: string }[]>;
	machineSessions(): readonly MachineSessions[];
	/** Clears the cached session lists. */
	refreshSessions(): void;
	/**
	 * Continues a session in a thread (with its history and the live follow) without opening it,
	 * or finds the thread that already does; its room id.
	 */
	adoptSession(agentId: string, session: ListedSession): Promise<string | undefined>;
	/** By `<agentId>\n<sessionId>`: the room of the thread a session was continued in. */
	continuedSessions(): Promise<ReadonlyMap<string, string>>;
	/** Threads, boards or pins changed. */
	readonly onDidChange: vscode.Event<void>;
}

export class SidebarView implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly id = 'arkestra.sidebar';
	private view: vscode.WebviewView | undefined;
	private query = '';
	private timer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;
	/** Whether the pending render only refreshes (the page holds it while the mouse is on the list). */
	private quiet = true;
	/** When the user last did something in the bar. */
	private actedAt = 0;
	/** The threads of the last render, for the selection. */
	private shown: readonly ThreadSummary[] = [];
	/** The last listing that worked, per agent: a machine that fails keeps what it showed. */
	private readonly listings = new Map<string, readonly ListedSession[]>();
	private readonly listing = new Set<string>();
	private readonly failedAt = new Map<string, number>();
	private poll: ReturnType<typeof setInterval> | undefined;
	/** The session rows of the last render by id, for the actions that continue them first. */
	private sessionRows = new Map<string, SessionEntry>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext, private readonly source: SidebarSource) {
		this.disposables.push(
			vscode.window.registerWebviewViewProvider(SidebarView.id, this, { webviewOptions: { retainContextWhenHidden: true } }),
			source.onDidChange(() => this.schedule()),
			vscode.window.tabGroups.onDidChangeTabs(() => this.postSelection()),
			vscode.window.tabGroups.onDidChangeTabGroups(() => this.postSelection()),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('arkestra.connections.machines')) { this.schedule(); } }),
			new MachinesPage(source),
		);
	}

	dispose(): void {
		clearTimeout(this.timer);
		clearInterval(this.poll);
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [FONT_ROOT] };
		view.webview.html = sidebarHtml(randomBytes(16).toString('base64'), strings(), pageFonts(view.webview));
		view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.watch(false); } }, undefined, this.disposables);
		view.onDidChangeVisibility(() => {
			this.watch(view.visible);
			if (view.visible) {
				this.loadSessions(true);
				if (this.dirty) { this.schedule(); }
			}
		}, undefined, this.disposables);
		this.watch(view.visible);
		this.loadSessions(false);
		view.webview.onDidReceiveMessage((m: SidebarMessage) => this.receive(m).catch(error => {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}), undefined, this.disposables);
	}

	private schedule(quiet = true): void {
		this.quiet &&= quiet && Date.now() - this.actedAt > LOUD_MS;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			const q = this.quiet;
			this.quiet = true;
			void this.render(q);
		}, 80);
	}

	// ---- the machines' sessions --------------------------------------------------------------
	/** Every ~30 s while the bar is visible. */
	private watch(on: boolean): void {
		clearInterval(this.poll);
		this.poll = on ? setInterval(() => this.loadSessions(true), POLL_MS) : undefined;
	}

	/**
	 * Reads every agent's sessions on its machine, each on its own; one still reading is not asked
	 * again, one that failed lately waits. A failure keeps the last list and says nothing.
	 */
	private loadSessions(fresh: boolean): void {
		const agents = this.source.machineSessions();
		const ids = new Set(agents.map(a => a.id));
		for (const id of [...this.listings.keys()]) {
			if (!ids.has(id)) {
				this.listings.delete(id);
				this.schedule();
			}
		}
		for (const agent of agents) {
			if (this.listing.has(agent.id) || Date.now() - (this.failedAt.get(agent.id) ?? 0) < RETRY_MS) {
				continue;
			}
			this.listing.add(agent.id);
			agent.sessions(fresh).then(sessions => {
				this.failedAt.delete(agent.id);
				this.listings.set(agent.id, sessions);
				this.schedule();
			}, () => {
				this.failedAt.set(agent.id, Date.now());
			}).finally(() => this.listing.delete(agent.id));
		}
	}

	/** A thread's id; a session row's id continues the session first (or finds its thread). */
	private async roomOf(id: string): Promise<string | undefined> {
		const entry = this.sessionRows.get(id);
		if (!entry) {
			return id;
		}
		const room = await this.source.adoptSession(entry.agentId, entry.session);
		this.acted();
		return room;
	}

	private acted(): void {
		this.actedAt = Date.now();
	}

	// ---- state -----------------------------------------------------------------------------
	private sections(): Section[] {
		return parseSections(this.context.globalState.get(SECTIONS_KEY));
	}

	private async save(sections: readonly Section[]): Promise<void> {
		await this.context.globalState.update(SECTIONS_KEY, sections);
		this.schedule(false);
	}

	/** A new section with the name typed in place in the left bar. */
	private async newSection(name: unknown): Promise<string | undefined> {
		if (!text(name) || !name.trim()) {
			return undefined;
		}
		const id = randomBytes(6).toString('hex');
		await this.save(addSection(this.sections(), id, name.trim()));
		return id;
	}

	// ---- the page ----------------------------------------------------------------------------
	private async render(quiet = false): Promise<void> {
		const view = this.view;
		if (!view) {
			return;
		}
		if (!view.visible) {
			this.dirty = true;
			return;
		}
		this.dirty = false;
		const threads = await this.source.threads();
		this.shown = threads;
		const stored = this.context.globalState.get(SECTIONS_KEY);
		let sections = stored === undefined ? sectionsFromCategories(threads, () => randomBytes(6).toString('hex')) : this.sections();
		const kept = keepThreads(sections, new Set(threads.map(t => t.id)));
		if (stored === undefined || kept !== sections) {
			sections = [...kept];
			await this.context.globalState.update(SECTIONS_KEY, sections);
		}
		const q = this.query;
		const layout = layoutThreads(threads, sections, q);
		const now = Date.now();
		const language = vscode.env.language;
		const when = (iso: string) => relativeTime(iso, now, language);
		const machines = machineNames();
		const listings: AgentListing[] = this.source.machineSessions().flatMap(a => {
			const sessions = this.listings.get(a.id);
			return sessions ? [{ agentId: a.id, sessions }] : [];
		});
		const groups = agentGroups({ threads: layout.unsectioned, all: threads, listings, query: q, now, busy: id => this.source.busy(id), label: groupName });
		const several = rowMachines(groups) > 1;
		const machineLabel = (id: string | undefined) => several && id ? machines.get(id) ?? id : undefined;
		const thread = (t: ThreadSummary, item?: GroupItem): SidebarRow => {
			const section = sectionOf(sections, t.id);
			// In the agent groups the header names the agent; in a section, Pinned or Archived the row does,
			// with its machine while there are several.
			const own = item ? undefined : threadMachine(t);
			const machine = item ? machineLabel(item.machine) : own && machineCount() > 1 ? machines.get(own) ?? own : undefined;
			const agent = item ? undefined : groupName(threadGroup(t));
			return {
				key: `thread:${t.id}`, kind: 'thread', id: t.id, title: t.title,
				tip: [t.title, [projectName(t.project), item?.machine ? machines.get(item.machine) ?? item.machine : '', when(item?.at ?? t.lastAt)].filter(Boolean).join(' · ')].filter(Boolean).join('\n'),
				...((item ? item.running : this.source.busy(t.id)) ? { running: true } : {}),
				...(t.pinned ? { pinned: true } : {}),
				...(t.archived ? { archived: true } : {}),
				...(section ? { section } : {}),
				...(machine ? { machine } : {}),
				...(agent ? { agent } : {}),
			};
		};
		const sessionRows = new Map<string, SessionEntry>();
		const row = (item: GroupItem): SidebarRow => {
			if (item.kind === 'thread') {
				return thread(item.thread, item);
			}
			const { agentId, session } = item.entry;
			const id = sessionRowId(agentId, session.id);
			sessionRows.set(id, item.entry);
			const folder = session.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
			const machine = machineLabel(item.machine);
			return {
				key: `session:${id}`, kind: 'session', id, title: session.title,
				tip: [session.title, [folder, machines.get(item.machine) ?? item.machine, when(session.updatedAt)].filter(Boolean).join(' · '), vscode.l10n.t('Opening it continues the session here.')].join('\n'),
				...(item.running ? { running: true } : {}),
				...(machine ? { machine } : {}),
			};
		};
		const boards = this.source.boards().filter(b => b.pinned && matches(b.title, q))
			.map((b): SidebarRow => ({ key: `board:${b.key}`, kind: 'board', id: b.key, title: b.title, tip: b.key }));
		const artifacts = (await this.source.pinnedArtifacts()).filter(a => matches(a.title, q))
			.map((a): SidebarRow => ({ key: `artifact:${a.key}`, kind: 'artifact', id: a.key, title: a.title, tip: `${a.title}\n${a.kind}` }));
		const sidebarGroups = groups.map((g): SidebarGroup => ({ id: g.id, name: groupName(g.id), rows: g.items.map(row), older: g.older.map(row) }));
		this.sessionRows = sessionRows;
		const model: SidebarModel = {
			machines: machineCount(),
			query: q,
			...(this.selected() ? { selected: this.selected() } : {}),
			pinned: [...boards, ...artifacts, ...layout.pinned.map(t => thread(t))],
			sections: layout.sections.map(s => ({ id: s.section.id, name: s.section.name, rows: s.threads.map(t => thread(t)) })),
			groups: sidebarGroups,
			archived: layout.archived.map(t => thread(t)),
			empty: !threads.length && !listings.some(l => l.sessions.length),
		};
		await view.webview.postMessage({ type: 'model', model, ...(quiet ? { quiet: true } : {}) });
	}

	/** The row of what the active tab shows: a board, the artifact gallery, else the current thread. */
	private selected(): string | undefined {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const input = tab?.input;
		if (input instanceof vscode.TabInputWebview) {
			if (input.viewType.endsWith('arkestra.project')) {
				const board = this.source.boards().find(b => b.title === tab!.label);
				return board ? `board:${board.key}` : undefined;
			}
			if (input.viewType.endsWith('arkestra.artifacts')) {
				return 'nav:artifacts';
			}
			if (input.viewType.endsWith('arkestra.machines')) {
				return 'nav:machines';
			}
			// A thread's own tab: its row (below); any other page selects none.
			if (!input.viewType.endsWith(THREAD_VIEW_TYPE)) {
				return undefined;
			}
		}
		if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputTerminal) {
			return undefined;
		}
		// A chat tab names its thread; the room used last when the title is not unique.
		const named = this.shown.filter(t => t.title === tab?.label);
		const current = named.length === 1 ? named[0].id : this.source.currentThread();
		return current ? `thread:${current}` : undefined;
	}

	private postSelection(): void {
		if (this.view?.visible) {
			void this.view.webview.postMessage({ type: 'select', key: this.selected() ?? null });
		}
	}

	private async receive(m: SidebarMessage): Promise<void> {
		this.acted();
		switch (m?.type) {
			case 'ready':
				this.query = '';
				this.loadSessions(false);
				await this.render();
				return;
			case 'search':
				this.query = typeof m.query === 'string' ? m.query.slice(0, 200) : '';
				await this.render();
				return;
			case 'nav':
				return this.nav(m.item);
			case 'open':
				return text(m.key) ? this.open(m.key) : undefined;
			case 'thread': {
				const commands: Record<string, string> = { pin: 'arkestra.rooms.pin', unpin: 'arkestra.rooms.unpin', rename: 'arkestra.rooms.rename', archive: 'arkestra.rooms.archive', unarchive: 'arkestra.rooms.unarchive', delete: 'arkestra.rooms.delete' };
				const command = commands[m.action];
				if (m.action === 'rename' && !(text(m.name) && m.name.trim())) {
					return; // renamed in place: an empty name keeps the old one
				}
				if (m.action === 'delete' && text(m.id) && this.sessionRows.has(m.id)) {
					return; // a session no thread continues stays on its machine
				}
				// A session row the Claude app lists too is archived there, without a thread here first.
				const bridge = m.action === 'archive' && text(m.id) ? this.sessionRows.get(m.id)?.session.bridge : undefined;
				if (bridge) {
					await vscode.commands.executeCommand('arkestra.rooms.archiveSession', bridge);
					return;
				}
				// A session row is continued in a thread first; the thread then gets the action.
				const room = command && text(m.id) ? await this.roomOf(m.id) : undefined;
				if (command && room) {
					await vscode.commands.executeCommand(command, room, ...(m.action === 'rename' ? [m.name] : []));
				}
				return;
			}
			case 'move': {
				const room = text(m.id) ? await this.roomOf(m.id) : undefined;
				if (room) {
					await this.save(moveThread(this.sections(), room, text(m.section) ? m.section : undefined));
				}
				return;
			}
			case 'moveToNew':
				if (text(m.id)) {
					const id = await this.newSection(m.name);
					const room = id ? await this.roomOf(m.id) : undefined;
					if (id && room) {
						await this.save(moveThread(this.sections(), room, id));
					}
				}
				return;
			case 'reorder':
				if (text(m.id)) {
					await this.save(moveSection(this.sections(), m.id, text(m.before) ? m.before : undefined));
				}
				return;
			case 'section':
				return this.section(m.action, m.id, m.name);
		}
	}

	private async section(action: string, id: unknown, name: unknown): Promise<void> {
		if (action === 'new') {
			await this.newSection(name);
			return;
		}
		const list = this.sections();
		const section = list.find(s => s.id === id);
		if (!section) {
			return;
		}
		if (action === 'rename') {
			if (text(name) && name.trim()) {
				await this.save(renameSection(this.sections(), section.id, name.trim()));
			}
		} else if (action === 'delete') {
			await this.save(deleteSection(list, section.id));
		} else if (action === 'up' || action === 'down') {
			await this.save(shiftSection(list, section.id, action === 'up' ? -1 : 1));
		}
	}

	private async open(key: string): Promise<void> {
		const at = key.indexOf(':');
		const kind = key.slice(0, at);
		const id = key.slice(at + 1);
		if (kind === 'thread') {
			await vscode.commands.executeCommand('arkestra.rooms.openThread', id);
		} else if (kind === 'session') {
			// Continued in a thread (its history, then the live follow) and opened; the list reads again.
			const entry = this.sessionRows.get(id);
			if (entry) {
				await vscode.commands.executeCommand('arkestra.rooms.continueSession', entry.agentId, entry.session);
				this.acted();
				this.loadSessions(true);
				this.schedule(false);
			}
		} else if (kind === 'board') {
			// The window's own board opens with '' (as from its project), any other by its key.
			const board = this.source.boards().find(b => b.key === id);
			await vscode.commands.executeCommand('arkestra.github.openBoard', board?.workspace ? '' : id);
		} else if (kind === 'artifact') {
			await vscode.commands.executeCommand('arkestra.artifacts.reveal', id);
		}
	}

	private async nav(item: unknown): Promise<void> {
		switch (item) {
			case 'newChat': {
				const has = (await vscode.commands.getCommands(true)).includes(NEW_CHAT);
				await vscode.commands.executeCommand(has ? NEW_CHAT : 'arkestra.rooms.newThread');
				return;
			}
			case 'boards':
				await vscode.commands.executeCommand('arkestra.github.openBoards');
				return;
			case 'artifacts':
				await vscode.commands.executeCommand('arkestra.artifacts.open');
				return;
			case 'machines':
				await vscode.commands.executeCommand('arkestra.machines.open');
				return;
		}
	}
}

/** The groups' names: the CLI, else the agents' mix. */
function groupName(id: string): string {
	switch (id) {
		case 'claude': return 'Claude';
		case 'codex': return 'Codex';
		case 'several': return vscode.l10n.t('Several agents');
		case 'other': return vscode.l10n.t('Other chats');
		default: return id.charAt(0).toUpperCase() + id.slice(1);
	}
}

/** The machines' names by id, for the small machine label of a row. */
export function machineNames(): Map<string, string> {
	const entries = readMachineEntries(vscode.workspace.getConfiguration('arkestra.connections').get('machines'));
	// Short: it sits beside the title in a narrow bar.
	return new Map([[LOCAL, process.platform === 'darwin' ? 'Mac' : vscode.l10n.t('This machine')], ...entries.map(m => [m.id, m.name] as const)]);
}

/** The SSH machines of the Connections extension and this one. */
function machineCount(): number {
	const list = vscode.workspace.getConfiguration('arkestra.connections').get<unknown[]>('machines');
	return (Array.isArray(list) ? list.length : 0) + 1;
}

function strings(): SidebarStrings {
	return {
		newChat: vscode.l10n.t('New chat'),
		search: vscode.l10n.t('Search'),
		searchPlaceholder: vscode.l10n.t('Search chats, boards, artifacts'),
		boards: vscode.l10n.t('Boards'),
		artifacts: vscode.l10n.t('Artifacts'),
		machines: vscode.l10n.t('Machines'),
		pinned: vscode.l10n.t('Pinned'),
		newSection: vscode.l10n.t('New section'),
		archived: vscode.l10n.t('Archived'),
		showOlder: vscode.l10n.t('Show older ({0})'),
		showFewer: vscode.l10n.t('Show fewer'),
		noChats: vscode.l10n.t('No chats yet. Start one with New chat, or connect a machine under Machines.'),
		noMatch: vscode.l10n.t('Nothing matches.'),
		more: vscode.l10n.t('More actions'),
		running: vscode.l10n.t('An agent is working'),
		moveTo: vscode.l10n.t('Move to section'),
		noSection: vscode.l10n.t('Remove from section'),
		newSectionMenu: vscode.l10n.t('New section…'),
		sectionName: vscode.l10n.t('Name of the section'),
		pin: vscode.l10n.t('Pin'),
		unpin: vscode.l10n.t('Unpin'),
		rename: vscode.l10n.t('Rename'),
		archive: vscode.l10n.t('Archive'),
		restore: vscode.l10n.t('Restore'),
		delete: vscode.l10n.t('Delete…'),
		renameSection: vscode.l10n.t('Rename section…'),
		moveUp: vscode.l10n.t('Move up'),
		moveDown: vscode.l10n.t('Move down'),
		deleteSection: vscode.l10n.t('Delete section'),
	};
}

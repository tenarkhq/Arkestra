/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar as one page (arkestra.sidebar): New chat, Search, Boards, Artifacts,
 *  Machines, then Pinned, the user's sections, the threads in no section and the archived ones.
 *  The user makes the sections and puts threads into them; nothing is filed on its own.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { ExistingSession } from './agent';
import { addSection, deleteSection, keepThreads, layoutThreads, matches, moveSection, moveThread, parseSections, renameSection, sectionOf, sectionsFromCategories, shiftSection, type Section } from './sections';
import { sidebarHtml, type SidebarMessage, type SidebarModel, type SidebarRow, type SidebarStrings } from './sidebarHtml';
import { FONT_ROOT, pageFonts } from './webviewFonts';
import { projectName, type ThreadSummary } from './threads';

/** The sections in globalState: [{ id, name, threadIds }]. */
export /** A non-empty string from the page. */
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const SECTIONS_KEY = 'arkestra.rooms.sections';
const NEW_CHAT = 'arkestra.rooms.newChat';

export interface SidebarBoard { readonly key: string; readonly title: string; readonly workspace: boolean; readonly pinned: boolean }

/** A CLI whose sessions on its machine can be continued here (AR39). */
export interface MachineSessions {
	readonly id: string;
	readonly name: string;
	sessions(): Promise<readonly ExistingSession[]>;
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
	/** Threads, boards or pins changed. */
	readonly onDidChange: vscode.Event<void>;
}

export class SidebarView implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly id = 'arkestra.sidebar';
	private view: vscode.WebviewView | undefined;
	private query = '';
	private timer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;
	/** The threads of the last render, for the selection. */
	private shown: readonly ThreadSummary[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext, private readonly source: SidebarSource) {
		this.disposables.push(
			vscode.window.registerWebviewViewProvider(SidebarView.id, this, { webviewOptions: { retainContextWhenHidden: true } }),
			source.onDidChange(() => this.schedule()),
			vscode.window.tabGroups.onDidChangeTabs(() => this.postSelection()),
			vscode.window.tabGroups.onDidChangeTabGroups(() => this.postSelection()),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('arkestra.connections.machines')) { this.schedule(); } }),
		);
	}

	dispose(): void {
		clearTimeout(this.timer);
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [FONT_ROOT] };
		view.webview.html = sidebarHtml(randomBytes(16).toString('base64'), strings(), pageFonts(view.webview));
		view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } }, undefined, this.disposables);
		view.onDidChangeVisibility(() => { if (view.visible && this.dirty) { this.schedule(); } }, undefined, this.disposables);
		view.webview.onDidReceiveMessage((m: SidebarMessage) => this.receive(m).catch(error => {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}), undefined, this.disposables);
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.render(), 80);
	}

	// ---- state -----------------------------------------------------------------------------
	private sections(): Section[] {
		return parseSections(this.context.globalState.get(SECTIONS_KEY));
	}

	private async save(sections: readonly Section[]): Promise<void> {
		await this.context.globalState.update(SECTIONS_KEY, sections);
		this.schedule();
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
	private async render(): Promise<void> {
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
		const when = (iso: string) => iso ? new Date(iso).toLocaleString(vscode.env.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
		const row = (t: ThreadSummary): SidebarRow => {
			const section = sectionOf(sections, t.id);
			return {
				key: `thread:${t.id}`, kind: 'thread', id: t.id, title: t.title,
				tip: [t.title, [projectName(t.project), when(t.lastAt)].filter(Boolean).join(' · ')].filter(Boolean).join('\n'),
				...(this.source.busy(t.id) ? { running: true } : {}),
				...(t.pinned ? { pinned: true } : {}),
				...(t.archived ? { archived: true } : {}),
				...(section ? { section } : {}),
			};
		};
		const boards = this.source.boards().filter(b => b.pinned && matches(b.title, q))
			.map((b): SidebarRow => ({ key: `board:${b.key}`, kind: 'board', id: b.key, title: b.title, tip: b.key }));
		const artifacts = (await this.source.pinnedArtifacts()).filter(a => matches(a.title, q))
			.map((a): SidebarRow => ({ key: `artifact:${a.key}`, kind: 'artifact', id: a.key, title: a.title, tip: `${a.title}\n${a.kind}` }));
		const model: SidebarModel = {
			machines: machineCount(),
			query: q,
			...(this.selected() ? { selected: this.selected() } : {}),
			pinned: [...boards, ...artifacts, ...layout.pinned.map(row)],
			sections: layout.sections.map(s => ({ id: s.section.id, name: s.section.name, rows: s.threads.map(row) })),
			unsectioned: layout.unsectioned.map(row),
			archived: layout.archived.map(row),
			empty: !threads.length,
		};
		await view.webview.postMessage({ type: 'model', model });
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
			return undefined;
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
		switch (m?.type) {
			case 'ready':
				this.query = '';
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
				if (command && text(m.id)) {
					await vscode.commands.executeCommand(command, m.id, ...(m.action === 'rename' ? [m.name] : []));
				}
				return;
			}
			case 'move':
				if (text(m.id)) {
					await this.save(moveThread(this.sections(), m.id, text(m.section) ? m.section : undefined));
				}
				return;
			case 'moveToNew':
				if (text(m.id)) {
					const id = await this.newSection(m.name);
					if (id) {
						await this.save(moveThread(this.sections(), m.id, id));
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
				await vscode.commands.executeCommand('arkestra.github.openBoard', '');
				return;
			case 'artifacts':
				await vscode.commands.executeCommand('arkestra.artifacts.open');
				return;
			case 'machines':
				await this.machines();
				return;
		}
	}

	/** Machines: the Machines view, the connections, and the CLI sessions on them to continue here. */
	private async machines(): Promise<void> {
		type Item = vscode.QuickPickItem & { run?: () => Promise<unknown> };
		const agents = this.source.machineSessions();
		const items: Item[] = [
			{ label: `$(remote) ${vscode.l10n.t('Machines and their folders')}`, run: () => Promise.resolve(vscode.commands.executeCommand('arkestra.machines.focus')) },
			{ label: `$(plug) ${vscode.l10n.t('Connections')}`, description: vscode.l10n.t('add, check or remove a machine'), run: () => Promise.resolve(vscode.commands.executeCommand('arkestra.connections.show')) },
			...(agents.length ? [{ label: vscode.l10n.t('Sessions on the machines'), kind: vscode.QuickPickItemKind.Separator } as Item] : []),
			...agents.map((a): Item => ({
				label: `$(${a.id.includes('@') ? 'remote' : 'vm'}) ${a.name}`,
				description: vscode.l10n.t('continue one of its sessions here'),
				run: () => this.sessions(a),
			})),
		];
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Machines') });
		await pick?.run?.();
	}

	private async sessions(agent: MachineSessions): Promise<void> {
		type Item = vscode.QuickPickItem & { session?: ExistingSession };
		const qp = vscode.window.createQuickPick<Item>();
		qp.title = vscode.l10n.t('Sessions of {0}', agent.name);
		qp.placeholder = vscode.l10n.t('Claude Code and Codex sessions started outside Arkestra. Pick one to continue it here.');
		qp.matchOnDescription = true;
		const refresh: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: vscode.l10n.t('Refresh the sessions') };
		qp.buttons = [refresh];
		const when = (iso: string) => iso ? new Date(iso).toLocaleString(vscode.env.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
		const load = async () => {
			qp.busy = true;
			try {
				const sessions = await agent.sessions();
				qp.items = sessions.length
					? sessions.map(session => ({ label: session.title, description: [session.cwd ? path.posix.basename(session.cwd) : '', when(session.updatedAt)].filter(Boolean).join(' · '), session }))
					: [{ label: vscode.l10n.t('No sessions on this machine') }];
			} catch (error) {
				qp.items = [{ label: vscode.l10n.t('Could not read the sessions: {0}', error instanceof Error ? error.message : String(error)) }];
			} finally {
				qp.busy = false;
			}
		};
		const picked = await new Promise<ExistingSession | undefined>(resolve => {
			qp.onDidTriggerButton(() => { this.source.refreshSessions(); void load(); });
			qp.onDidAccept(() => { const s = qp.selectedItems[0]?.session; if (s) { resolve(s); qp.hide(); } });
			qp.onDidHide(() => resolve(undefined));
			qp.show();
			void load();
		});
		qp.dispose();
		if (picked) {
			await vscode.commands.executeCommand('arkestra.rooms.continueSession', agent.id, picked);
		}
	}
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
		unsectioned: vscode.l10n.t('No section'),
		archived: vscode.l10n.t('Archived'),
		noChats: vscode.l10n.t('No chats yet. Start one with New chat.'),
		noMatch: vscode.l10n.t('Nothing matches.'),
		more: vscode.l10n.t('More actions'),
		running: vscode.l10n.t('An agent is working'),
		moveTo: vscode.l10n.t('Move to section'),
		noSection: vscode.l10n.t('No section'),
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

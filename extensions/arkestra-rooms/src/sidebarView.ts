/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar as one page (arkestra.sidebar): New chat, Search, Boards, Artifacts,
 *  Machines, then Pinned, the user's sections, the threads in no section and the archived ones.
 *  The user makes the sections and puts threads into them; nothing is filed on its own.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ExistingSession } from './agent';
import { addSection, deleteSection, keepThreads, layoutThreads, matches, moveSection, moveThread, parseSections, renameSection, sectionOf, sectionsFromCategories, shiftSection, type Section } from './sections';
import { MachinesPage } from './machinesPage';
import { sidebarHtml, type SidebarMessage, type SidebarModel, type SidebarRow, type SidebarStrings } from './sidebarHtml';
import { FONT_ROOT, pageFonts } from './webviewFonts';
import { projectName, type ThreadSummary } from './threads';

/** The sections in globalState: [{ id, name, threadIds }]. */
export const SECTIONS_KEY = 'arkestra.rooms.sections';
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
			new MachinesPage(source),
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

	private async askName(title: string, value = ''): Promise<string | undefined> {
		return (await vscode.window.showInputBox({ title, value, prompt: vscode.l10n.t('The name of the section') }))?.trim() || undefined;
	}

	private async newSection(): Promise<string | undefined> {
		const name = await this.askName(vscode.l10n.t('New section'));
		if (!name) {
			return undefined;
		}
		const id = randomBytes(6).toString('hex');
		await this.save(addSection(this.sections(), id, name));
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
			if (input.viewType.endsWith('arkestra.machines')) {
				return 'nav:machines';
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
		const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
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
				if (command && text(m.id)) {
					await vscode.commands.executeCommand(command, m.id);
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
					const id = await this.newSection();
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
				return this.section(m.action, m.id);
		}
	}

	private async section(action: string, id: unknown): Promise<void> {
		if (action === 'new') {
			await this.newSection();
			return;
		}
		const list = this.sections();
		const section = list.find(s => s.id === id);
		if (!section) {
			return;
		}
		if (action === 'rename') {
			const name = await this.askName(vscode.l10n.t('Rename section'), section.name);
			if (name) {
				await this.save(renameSection(this.sections(), section.id, name));
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
				await vscode.commands.executeCommand('arkestra.machines.open');
				return;
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

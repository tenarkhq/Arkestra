/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Boards page in an editor tab (the left bar's Boards): every board added as a
 *  tile; a tile opens its board, its menu pins, opens GitHub or removes it, and boards are
 *  added with the form in the page, not with a quick pick at the top.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { boardTile, type BoardEntry } from './boards';
import { boardsHtml, type BoardsLabels } from './boardsHtml';
import type { ProjectChoice, ProjectSnapshot } from './project';
import type { SyncStatus } from './sync';

/** The bundled Inter (media/fonts, SIL OFL 1.1): out/ (tsc) and dist/ (esbuild) are both one level under the extension's root. */
const FONT_ROOT = vscode.Uri.file(path.join(__dirname, '..', 'media', 'fonts'));
const VIEW = 'arkestra.boards';

export interface BoardsHost {
	/** Every board added: the workspace's project first. */
	list(): readonly BoardEntry[];
	snapshot(key: string): ProjectSnapshot | undefined;
	/** The board's read state when it is being followed now (the workspace's or an open board). */
	status(key: string): SyncStatus | undefined;
	/** Reads a board that is not open, so its tile is current. */
	read(key: string): void;
	readonly onDidChange: vscode.Event<void>;
	add(key: string): Promise<void>;
	remove(key: string): Promise<void>;
	setPinned(key: string, pinned: boolean): Promise<void>;
	/** The signed-in user's projects and their organizations', for the add form. */
	projects(): Promise<readonly ProjectChoice[]>;
}

function labels(): BoardsLabels {
	return {
		title: vscode.l10n.t('Boards'),
		subtitle: vscode.l10n.t('Every GitHub Project you added, in one place'),
		search: vscode.l10n.t('Search boards'),
		all: vscode.l10n.t('All'),
		pinned: vscode.l10n.t('Pinned'),
		add: vscode.l10n.t('+ Add board'),
		addTitle: vscode.l10n.t('Add board'),
		addHint: vscode.l10n.t('A GitHub Project by owner/number or its URL'),
		placeholder: vscode.l10n.t('owner/number or project URL'),
		invalid: vscode.l10n.t('owner/number, e.g. tenarkhq/3, or https://github.com/orgs/<org>/projects/<n>'),
		already: vscode.l10n.t('This board is already here.'),
		addButton: vscode.l10n.t('Add'),
		cancel: vscode.l10n.t('Cancel'),
		yours: vscode.l10n.t('Your projects'),
		listing: vscode.l10n.t('Reading your projects…'),
		listError: vscode.l10n.t('Your projects could not be listed: {0}'),
		closed: vscode.l10n.t('closed'),
		items: vscode.l10n.t('items'),
		open: vscode.l10n.t('open'),
		done: vscode.l10n.t('done'),
		read: vscode.l10n.t('read {0}'),
		unread: vscode.l10n.t('not read yet'),
		reading: vscode.l10n.t('reading…'),
		failed: vscode.l10n.t('could not be read: {0}'),
		workspace: vscode.l10n.t('this workspace'),
		pinnedTag: vscode.l10n.t('pinned'),
		pin: vscode.l10n.t('Pin'),
		unpin: vscode.l10n.t('Unpin'),
		github: vscode.l10n.t('Open on GitHub'),
		remove: vscode.l10n.t('Remove'),
		confirm: vscode.l10n.t('Remove “{0}” from Boards? The project stays on GitHub.'),
		more: vscode.l10n.t('More actions'),
		moreLanes: vscode.l10n.t('+{0} more'),
		empty: vscode.l10n.t('No boards yet'),
		emptyText: vscode.l10n.t('Add a GitHub Project to follow its work here: what is open, what is done and how far each line is.'),
		noMatch: vscode.l10n.t('Nothing matches the search.'),
		remote: vscode.l10n.t('Remote Control and relay'),
	};
}

/** Boards older than this are read again when the page shows. */
const STALE_MS = 10 * 60_000;

export class BoardsPage implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Open the add form when the page is ready (the board's "+ Board"). */
	private formNext = false;
	/** Whether the page's script listens (it says so with "ready"). */
	private ready = false;

	constructor(private readonly host: BoardsHost) {
		this.disposables.push(
			vscode.commands.registerCommand('arkestra.github.openBoards', (options?: unknown) => this.show(!!(options && typeof options === 'object' && (options as { add?: unknown }).add))),
			vscode.window.registerWebviewPanelSerializer(VIEW, { deserializeWebviewPanel: async panel => this.adopt(panel) }),
			host.onDidChange(() => this.schedule()),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('arkestra.github')) { this.schedule(); } }),
		);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	/** Shows the page; `add`: with the add form open. */
	show(add = false): void {
		this.formNext ||= add;
		if (this.panel) {
			this.panel.reveal();
			if (add) {
				this.post();
			}
			return;
		}
		this.adopt(vscode.window.createWebviewPanel(VIEW, vscode.l10n.t('Boards'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [FONT_ROOT] }));
	}

	private adopt(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		this.ready = false;
		panel.iconPath = new vscode.ThemeIcon('project');
		panel.webview.options = { enableScripts: true, localResourceRoots: [FONT_ROOT] };
		panel.webview.html = boardsHtml(randomBytes(16).toString('base64'), panel.webview.cspSource, labels(), panel.webview.asWebviewUri(FONT_ROOT).toString());
		panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; } });
		panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) { this.readStale(); } });
		panel.webview.onDidReceiveMessage(m => void this.receive(m));
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.post(), 80);
	}

	private post(): void {
		const panel = this.panel;
		if (!panel || !this.ready) {
			return;
		}
		const config = vscode.workspace.getConfiguration('arkestra.github');
		const fields = { laneField: config.get<string>('laneField') || undefined, weightField: config.get<string>('weightField') || undefined };
		const tiles = this.host.list().map(b => boardTile(b, this.host.snapshot(b.key), this.host.status(b.key), fields));
		const openForm = this.formNext;
		this.formNext = false;
		void panel.webview.postMessage({ type: 'data', tiles, openForm });
	}

	/** Reads the boards not followed now whose tile is old or was never read. */
	private readStale(): void {
		const now = Date.now();
		for (const b of this.host.list()) {
			if (this.host.status(b.key)) {
				continue;
			}
			const snap = this.host.snapshot(b.key);
			if (!snap || now - (snap.fetchedAt || 0) > STALE_MS) {
				this.host.read(b.key);
			}
		}
	}

	private async receive(m: any): Promise<void> {
		const key = typeof m?.key === 'string' ? m.key : '';
		const entry = this.host.list().find(b => b.key === key);
		try {
			switch (m?.type) {
				case 'remote': await vscode.commands.executeCommand('arkestra.remote.menu'); return;
				case 'ready': this.ready = true; this.post(); this.readStale(); return;
				case 'open':
					if (entry) {
						await vscode.commands.executeCommand('arkestra.github.openBoard', entry.workspace ? '' : entry.key);
					}
					return;
				case 'pin':
					if (entry) {
						await this.host.setPinned(entry.key, !entry.pinned);
					}
					return;
				case 'github': {
					const url = entry && this.host.snapshot(entry.key)?.url;
					if (url && /^https:\/\/github\.com\//.test(url)) {
						await vscode.env.openExternal(vscode.Uri.parse(url));
					}
					return;
				}
				case 'remove':
					if (entry && !entry.workspace) {
						await this.host.remove(entry.key);
					}
					return;
				case 'add':
					await this.host.add(key);
					void this.panel?.webview.postMessage({ type: 'added', key });
					return;
				case 'projects': {
					try {
						const choices = await this.host.projects();
						void this.panel?.webview.postMessage({ type: 'projects', choices });
					} catch (error) {
						void this.panel?.webview.postMessage({ type: 'projects', choices: [], error: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
			}
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (m?.type === 'add') {
				void this.panel?.webview.postMessage({ type: 'addError', text });
			} else {
				void vscode.window.showErrorMessage(text);
			}
		}
	}
}

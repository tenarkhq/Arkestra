/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Board and Table views (AR30) in an editor tab, so they tile with the rest of
 *  the workspace. A card dragged to a column changes its Status on GitHub too; the table edits
 *  the project's fields in place; a task with nothing open before it can start a room.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { boardModel, type RoomInfo } from './board';
import { boardHtml } from './boardHtml';
import type { FieldInput, ProjectSnapshot } from './project';
import type { JournalEntry, SyncStatus } from './sync';

export interface BoardSource {
	configured(): boolean;
	signedIn(): boolean;
	snapshot(): ProjectSnapshot | undefined;
	status(): SyncStatus;
	live(): boolean;
	journal(): readonly JournalEntry[];
	readonly onDidChange: vscode.Event<void>;
	setField(itemId: string, fieldId: string, value: FieldInput): Promise<void>;
	createIssue(repository: string, title: string, body?: string, fields?: Readonly<Record<string, FieldInput>>): Promise<string>;
	refresh(): Promise<void>;
}

interface RoomsApi {
	tasks(): Promise<RoomInfo[]>;
	readonly onDidChangeTasks: vscode.Event<void>;
}

const VIEW = 'arkestra.project';

export class ProjectBoard implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private rooms: RoomInfo[] = [];
	private roomsApi: RoomsApi | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly source: BoardSource) {
		this.disposables.push(
			vscode.commands.registerCommand('arkestra.github.openBoard', () => this.open()),
			vscode.window.registerWebviewPanelSerializer(VIEW, { deserializeWebviewPanel: async panel => this.adopt(panel) }),
			source.onDidChange(() => this.schedule()),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('arkestra.github.cardFields')) { this.schedule(); } }),
		);
		void this.connectRooms();
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private async connectRooms(): Promise<void> {
		try {
			const api = await vscode.extensions.getExtension<RoomsApi>('vscode.arkestra-rooms')?.activate();
			if (api?.tasks) {
				this.roomsApi = api;
				this.disposables.push(api.onDidChangeTasks(() => void this.loadRooms()));
				await this.loadRooms();
			}
		} catch {
			// without rooms the board has no room column
		}
	}

	private async loadRooms(): Promise<void> {
		if (!this.roomsApi || !this.panel) {
			return;
		}
		try {
			this.rooms = await this.roomsApi.tasks();
		} catch {
			this.rooms = [];
		}
		this.schedule();
	}

	open(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		this.adopt(vscode.window.createWebviewPanel(VIEW, vscode.l10n.t('Project'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
	}

	private adopt(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		panel.iconPath = new vscode.ThemeIcon('project');
		panel.webview.options = { enableScripts: true };
		panel.webview.html = boardHtml(randomBytes(16).toString('base64'), panel.webview.cspSource);
		panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
		panel.webview.onDidReceiveMessage(m => void this.receive(m), undefined, this.disposables);
		void this.loadRooms();
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.post(), 80);
	}

	private post(): void {
		const panel = this.panel;
		if (!panel) {
			return;
		}
		const snap = this.source.snapshot();
		const status = this.source.status();
		if (!this.source.configured()) {
			void panel.webview.postMessage({ type: 'screen', screen: { title: vscode.l10n.t('No GitHub Project for this workspace'), text: vscode.l10n.t('Pick the project this workspace follows; its Board and Table show here and stay in sync with GitHub both ways.'), actions: [{ label: vscode.l10n.t('Follow a project…'), command: 'setProject' }, { label: vscode.l10n.t('Sign in to GitHub'), command: 'signIn' }] } });
			return;
		}
		if (!snap) {
			const failed = status.kind === 'error';
			void panel.webview.postMessage({
				type: 'screen', screen: failed
					? { title: vscode.l10n.t('The project could not be read'), text: status.message, actions: [{ label: vscode.l10n.t('Sign in to GitHub'), command: 'signIn' }, { label: vscode.l10n.t('Try again'), command: 'refresh' }, { label: vscode.l10n.t('Follow another project…'), command: 'setProject' }] }
					: { title: vscode.l10n.t('Reading the project…'), text: '' },
			});
			return;
		}
		panel.title = snap.title;
		const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const model = boardModel({
			snapshot: snap,
			rooms: this.rooms,
			cardFields: vscode.workspace.getConfiguration('arkestra.github').get<string[]>('cardFields') ?? [],
			status,
			live: this.source.live(),
			journal: this.source.journal(),
			clock,
		});
		void panel.webview.postMessage({ type: 'model', model });
	}

	private async receive(m: any): Promise<void> {
		try {
			switch (m?.type) {
				case 'ready': this.post(); return;
				case 'open':
					if (typeof m.url === 'string' && /^https:\/\/github\.com\//.test(m.url)) {
						await vscode.env.openExternal(vscode.Uri.parse(m.url));
					}
					return;
				case 'openRoom': await vscode.commands.executeCommand('arkestra.rooms.openThread', String(m.roomId)); return;
				case 'refresh': await this.source.refresh(); return;
				case 'signIn': await vscode.commands.executeCommand('arkestra.github.signIn'); return;
				case 'setProject': await vscode.commands.executeCommand('arkestra.github.setProject'); return;
				case 'move': {
					const statusId = this.statusFieldId();
					if (statusId) {
						await this.source.setField(String(m.itemId), statusId, { optionId: String(m.optionId) });
					}
					return;
				}
				case 'setField': await this.source.setField(String(m.itemId), String(m.fieldId), m.value as FieldInput); return;
				case 'createIssue': {
					const statusId = this.statusFieldId();
					await this.source.createIssue(String(m.repository), String(m.title), '', statusId && m.optionId ? { [statusId]: { optionId: String(m.optionId) } } : undefined);
					return;
				}
				case 'startRoom': {
					const item = this.source.snapshot()?.items.find(i => i.id === m.itemId);
					if (item) {
						await vscode.commands.executeCommand('arkestra.rooms.newTemplateRoom', { type: 'coding', brief: item.url ?? (item.number ? `#${item.number}` : item.title) });
					}
					return;
				}
			}
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			this.post(); // the model already shows the value GitHub kept
		}
	}

	private statusFieldId(): string | undefined {
		return this.source.snapshot()?.fields.find(f => f.type === 'single_select' && f.name.toLowerCase() === 'status')?.id;
	}
}

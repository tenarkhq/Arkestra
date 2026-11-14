/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Board and Table views (AR30) in an editor tab, so they tile with the rest of
 *  the workspace. A card dragged to a column changes its Status on GitHub too; the table edits
 *  the project's fields in place; a task with nothing open before it can start a room.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { boardModel, type RoomInfo } from './board';
import { boardHtml } from './boardHtml';
import { readGitInfo } from './gitInfo';
import { planModel, type GitInfo } from './plan';
import { graphModel, wouldCycle, type GraphSaved } from './graph';
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
	addDependency(blockedItemId: string, blockingItemId: string): Promise<void>;
	removeDependency(blockedItemId: string, blockingItemId: string): Promise<void>;
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
	private git: GitInfo | undefined;
	private gitTimer: ReturnType<typeof setTimeout> | undefined;
	private gitTicker: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly source: BoardSource, private readonly memento: vscode.Memento) {
		this.disposables.push(
			vscode.commands.registerCommand('arkestra.github.openBoard', () => this.open()),
			vscode.window.registerWebviewPanelSerializer(VIEW, { deserializeWebviewPanel: async panel => this.adopt(panel) }),
			source.onDidChange(() => { this.schedule(); this.scheduleGit(); }),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('arkestra.github')) { this.schedule(); } }),
		);
		void this.connectRooms();
	}

	dispose(): void {
		clearTimeout(this.timer);
		clearTimeout(this.gitTimer);
		clearInterval(this.gitTicker);
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
		panel.onDidDispose(() => { this.panel = undefined; clearInterval(this.gitTicker); this.gitTicker = undefined; }, undefined, this.disposables);
		// The branch rails follow the local repository: read again when the project changes and every 30 s.
		this.gitTicker = setInterval(() => { if (panel.visible) { void this.loadGit(); } }, 30_000);
		void this.loadGit();
		panel.webview.onDidReceiveMessage(m => void this.receive(m), undefined, this.disposables);
		void this.loadRooms();
	}

	private scheduleGit(): void {
		clearTimeout(this.gitTimer);
		this.gitTimer = setTimeout(() => void this.loadGit(), 1500);
	}

	private async loadGit(): Promise<void> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd || !this.panel) {
			return;
		}
		const snap = this.source.snapshot();
		const wanted = new Set<string>();
		for (const item of snap?.items ?? []) {
			for (const pr of item.pullRequests) {
				if (pr.state === 'OPEN' && pr.headRef) {
					wanted.add(pr.headRef);
				}
			}
		}
		for (const room of this.rooms) {
			for (const b of room.branches ?? []) {
				wanted.add(b);
			}
		}
		try {
			this.git = await readGitInfo(cwd, [...wanted]);
		} catch {
			this.git = undefined;
		}
		this.schedule();
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
		const config = vscode.workspace.getConfiguration('arkestra.github');
		const plan = planModel({ snapshot: snap, rooms: this.rooms, ...(this.git ? { git: this.git } : {}), laneField: config.get<string>('laneField') || undefined, weightField: config.get<string>('weightField') || undefined });
		const model = boardModel({
			snapshot: snap,
			rooms: this.rooms,
			cardFields: vscode.workspace.getConfiguration('arkestra.github').get<string[]>('cardFields') ?? [],
			status,
			live: this.source.live(),
			journal: this.source.journal(),
			clock,
		});
		const graph = graphModel(snap, this.rooms, plan, this.saved(snap));
		void panel.webview.postMessage({ type: 'model', model: { ...model, plan, graph } });
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
				case 'addDependency': {
					const snap = this.source.snapshot();
					if (!snap) {
						return;
					}
					const blocking = String(m.blocking);
					const blocked = String(m.blocked);
					const plan = planModel({ snapshot: snap, rooms: this.rooms });
					if (wouldCycle(graphModel(snap, this.rooms, plan).edges, blocking, blocked)) {
						void vscode.window.showWarningMessage(vscode.l10n.t('That link would make the tasks wait for each other in a loop.'));
						return;
					}
					await this.source.addDependency(blocked, blocking);
					return;
				}
				case 'notice': void vscode.window.showInformationMessage(String(m.text)); return;
				case 'removeDependency': await this.source.removeDependency(String(m.blocked), String(m.blocking)); return;
				case 'addLoose': {
					const pair: [string, string] = [String(m.a), String(m.b)];
					if (pair[0] !== pair[1]) {
						await this.updateSaved(s => ({ ...s, loose: [...(s.loose ?? []).filter(([a, b]) => !(a === pair[0] && b === pair[1]) && !(a === pair[1] && b === pair[0])), pair] }));
					}
					return;
				}
				case 'removeLoose': await this.updateSaved(s => ({ ...s, loose: (s.loose ?? []).filter(([a, b]) => !((a === m.a && b === m.b) || (a === m.b && b === m.a))) })); return;
				case 'savePosition': {
					const x = Math.round(Number(m.x));
					const y = Math.round(Number(m.y));
					if (Number.isFinite(x) && Number.isFinite(y)) {
						await this.updateSaved(s => ({ ...s, positions: { ...(s.positions ?? {}), [String(m.id)]: [Math.max(0, x), Math.max(0, y)] as const } }));
					}
					return;
				}
				case 'autoLayout': await this.updateSaved(s => ({ ...s, positions: {} })); return;
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

	/** The Graph view's own state for this project: node places and loose links. */
	private key(snap: ProjectSnapshot): string {
		return `arkestra.github.graph:${snap.owner.toLowerCase()}/${snap.number}`;
	}

	private saved(snap: ProjectSnapshot): GraphSaved {
		return this.memento.get<GraphSaved>(this.key(snap)) ?? {};
	}

	private async updateSaved(change: (s: GraphSaved) => GraphSaved): Promise<void> {
		const snap = this.source.snapshot();
		if (snap) {
			await this.memento.update(this.key(snap), change(this.saved(snap)));
			this.schedule();
		}
	}

	private statusFieldId(): string | undefined {
		return this.source.snapshot()?.fields.find(f => f.type === 'single_select' && f.name.toLowerCase() === 'status')?.id;
	}
}

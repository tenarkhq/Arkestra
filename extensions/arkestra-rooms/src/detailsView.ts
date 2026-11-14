/*---------------------------------------------------------------------------------------------
 *  Arkestra. The right panel of a thread: its agents and their state, the background tasks,
 *  the files the turns changed, where it works, and how full the context is. It follows the
 *  thread panel used last.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { ActivityBoard } from './activity';
import type { AgentRegistry } from './agent';
import type { Change } from './checkpoints';
import type { Room } from './room';
import { ICONS, detailsPage, escapeHtml } from './threadHtml';
import { detailsModel, folderLabel, machineOf } from './threadModel';
import { tone } from './usage';
import { FONT_ROOT, pageFonts } from './webviewFonts';
import { TURN_TEXT } from './work';

export const DETAILS_VIEW_ID = 'arkestra.details';

export interface DetailsHost {
	readonly registry: AgentRegistry;
	readonly activity: ActivityBoard;
	readonly onDidChangeThread: vscode.Event<string>;
	readonly threads: { activeRoomId(): string | undefined; readonly onDidChangeActive: vscode.Event<string | undefined> };
	open(roomId: string): Promise<Room | undefined>;
	/** What the agents changed in the room since its accepted state. */
	changes(roomId: string): Promise<readonly Change[]>;
}

export class DetailsView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private tick: ReturnType<typeof setInterval> | undefined;
	/** The room's changes, read again at most every few seconds (a git call). */
	private changes: { roomId: string; at: number; list: readonly Change[] } | undefined;
	private shownChanges: readonly Change[] = [];

	constructor(private readonly host: DetailsHost) {
		this.disposables.push(
			vscode.window.registerWebviewViewProvider(DETAILS_VIEW_ID, this),
			host.threads.onDidChangeActive(() => this.schedule()),
			host.onDidChangeThread(roomId => { if (roomId === host.threads.activeRoomId()) { this.schedule(); } }),
		);
	}

	dispose(): void {
		clearTimeout(this.timer);
		clearInterval(this.tick);
		this.disposables.forEach(d => d.dispose());
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [FONT_ROOT] };
		view.webview.html = detailsPage(randomBytes(16).toString('base64'), pageFonts(view.webview));
		view.webview.onDidReceiveMessage(async (message: { type?: string; index?: unknown }) => {
			if (message.type === 'ready') {
				this.schedule(0);
			} else if (message.type === 'change' && typeof message.index === 'number') {
				const change = this.shownChanges[message.index];
				if (change) {
					await vscode.commands.executeCommand('arkestra.changes.open', change);
				}
			}
		});
		view.onDidChangeVisibility(() => { if (view.visible) { this.changes = undefined; this.schedule(0); } });
		view.onDidDispose(() => {
			this.view = undefined;
			clearInterval(this.tick);
			this.tick = undefined;
		});
		// Elapsed times of running tasks move on by themselves.
		this.tick = setInterval(() => { if (this.view?.visible) { this.schedule(); } }, 15_000);
	}

	private schedule(delay = 120): void {
		if (this.timer || !this.view) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.render();
		}, delay);
	}

	private async changesOf(roomId: string): Promise<readonly Change[]> {
		if (this.changes?.roomId === roomId && Date.now() - this.changes.at < 3000) {
			return this.changes.list;
		}
		const list = await this.host.changes(roomId).catch(() => []);
		this.changes = { roomId, at: Date.now(), list };
		return list;
	}

	private async render(): Promise<void> {
		const view = this.view;
		if (!view?.visible) {
			return;
		}
		const roomId = this.host.threads.activeRoomId();
		const room = roomId ? await this.host.open(roomId) : undefined;
		view.description = room?.state.title;
		if (!room) {
			this.shownChanges = [];
			void view.webview.postMessage({ type: 'render', html: `<div class="empty">${escapeHtml(vscode.l10n.t('Open a thread to see its agents, tasks and changes.'))}</div>` });
			return;
		}
		const roster = room.roster.map(id => ({ id, name: this.host.registry.get(id)?.name ?? id, activity: this.host.activity.get(room.id, id) }));
		const model = detailsModel(roster, Date.now());
		const changes = await this.changesOf(room.id);
		this.shownChanges = changes;
		const empty = (text: string) => `<div class="empty">${escapeHtml(text)}</div>`;
		const head = (text: string) => `<div class="rh">${escapeHtml(text)}</div>`;
		const parts: string[] = [];

		parts.push(head(vscode.l10n.t('Agents in this thread')));
		parts.push(model.agents.length
			? model.agents.map(a => `<div class="rr"><span class="dot ${a.turn}"></span><span class="n">${escapeHtml(a.name)}</span><span class="k">${escapeHtml(vscode.l10n.t(TURN_TEXT[a.turn]))}</span></div>`).join('')
			: empty(vscode.l10n.t('Nobody in this thread yet.')));

		parts.push('<div class="hr"></div>', head(vscode.l10n.t('Background tasks')));
		const tasks = model.running.map(t => `<div class="rr" title="${escapeHtml(t.detail ?? t.name)}">${t.kind === 'subagent' ? ICONS.agent : ICONS.terminal}<span class="n">${escapeHtml(t.detail ? `${t.name} · ${t.detail}` : t.name)}</span><span class="k">${escapeHtml(t.elapsed)}</span></div>`);
		if (model.finished) {
			tasks.push(`<div class="rr mut">${ICONS.done}<span class="n">${escapeHtml(vscode.l10n.t('{0} finished', model.finished))}</span></div>`);
		}
		parts.push(tasks.length ? tasks.join('') : empty(vscode.l10n.t('Nothing in the background.')));

		parts.push('<div class="hr"></div>', head(vscode.l10n.t('Changes')));
		parts.push(changes.length
			? changes.map((c, i) => {
				const dir = path.posix.dirname(c.path);
				return `<button class="rr" data-change="${i}" title="${escapeHtml(c.path)}">${ICONS.file}<span class="n">${escapeHtml(path.posix.basename(c.path))}</span>${dir !== '.' ? `<span class="k">${escapeHtml(dir)}</span>` : ''}<span class="st ${c.status}">${c.status}</span></button>`;
			}).join('')
			: empty(vscode.l10n.t('No changes since the last accepted state.')));

		parts.push('<div class="hr"></div>', head(vscode.l10n.t('Environment')));
		const machines = new Map<string, string>();
		for (const id of room.roster) {
			const machine = machineOf(id);
			const name = this.host.registry.get(id)?.name;
			if (machine) {
				machines.set(name?.split(' · ')[1] ?? machine, 'SSH');
			} else {
				machines.set(vscode.l10n.t('this machine'), vscode.l10n.t('local'));
			}
		}
		const adopted = Object.values(room.state.adopted ?? {}).find(a => a.cwd)?.cwd;
		const folder = folderLabel(adopted ?? room.state.project ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString(), homedir());
		const env = [
			...[...machines].map(([name, kind]) => `<div class="rr">${ICONS.machine}<span class="n">${escapeHtml(name)}</span><span class="k">${escapeHtml(kind)}</span></div>`),
			...(folder ? [`<div class="rr" title="${escapeHtml(folder)}">${ICONS.folder}<span class="n">${escapeHtml(folder)}</span></div>`] : []),
		];
		parts.push(env.length ? env.join('') : empty(vscode.l10n.t('No machine or folder yet.')));
		parts.push(model.context !== undefined
			? `<div class="rr"><span class="n">${escapeHtml(vscode.l10n.t('Context'))}</span><span class="k">${model.context}%</span><span class="bar ${tone(model.context)}"><b data-w="${model.context}"></b></span></div>`
			: `<div class="rr mut"><span class="n">${escapeHtml(vscode.l10n.t('Context'))}</span><span class="k">${escapeHtml(vscode.l10n.t('not reported yet'))}</span></div>`);
		void view.webview.postMessage({ type: 'render', html: parts.join('') });
	}
}

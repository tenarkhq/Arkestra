/*---------------------------------------------------------------------------------------------
 *  Arkestra. The right panel of a thread: its agents and their state, the background tasks,
 *  the files the turns changed, where it works, and how full the context is. It follows the
 *  thread panel used last, and the surface in the middle: on a board, the artifacts, the new
 *  chat or another page it shows nothing of a thread and the right bar closes (surface.ts).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { ActivityBoard } from './activity';
import type { AgentRegistry, Usage } from './agent';
import type { Change } from './checkpoints';
import type { Room } from './room';
import { ICONS, detailsPage, escapeHtml, type SharedStrings } from './threadHtml';
import { readForm } from './pageForm';
import { detailsModel, elapsed, folderLabel, machineOf, type DetailsTask } from './threadModel';
import { DetailsFollow, type Surface } from './surface';
import { agentMeter, formatTokens, quotaTone, tone } from './usage';
import { FONT_ROOT, pageFonts } from './webviewFonts';
import { TURN_TEXT } from './work';

export const DETAILS_VIEW_ID = 'arkestra.details';

export interface DetailsHost {
	readonly registry: AgentRegistry;
	readonly activity: ActivityBoard;
	readonly onDidChangeThread: vscode.Event<string>;
	readonly threads: {
		activeRoomId(): string | undefined;
		readonly onDidChangeActive: vscode.Event<string | undefined>;
		currentSurface(): Surface;
		readonly onDidChangeSurface: vscode.Event<Surface>;
	};
	open(roomId: string): Promise<Room | undefined>;
	/** What the agents changed in the room since its accepted state. */
	changes(roomId: string): Promise<readonly Change[]>;
	/** The agent's account quota as last read (read again in the background, at most every minute). */
	quota(agentId: string): Usage['limits'] | undefined;
	/** How full the context of the agent's session is, as the claude.ai account reports it (a session the Claude app runs). */
	cloudContext(room: Room, agentId: string): { readonly used: number; readonly max: number } | undefined;
	/** The agent's session in this room works on a turn now, as its file shows live (driven from its own app too). */
	liveRunning?(room: Room, agentId: string): boolean;
	/** What the folders of the room's adopted sessions changed in git (read again at most every 15 s); undefined: none to read. */
	worktreeChanges?(room: Room): Promise<readonly { readonly path: string; readonly added?: number; readonly removed?: number; readonly status: 'M' | '?' }[] | undefined>;
	/** The background tasks of the agent's session in this room as its file shows them (started from its own app too), and how many finished. */
	liveBackground?(room: Room, agentId: string): { readonly tasks: readonly { readonly id: string; readonly name: string; readonly since: string }[]; readonly done: number } | undefined;
}

export class DetailsView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private tick: ReturnType<typeof setInterval> | undefined;
	/** The room's changes, read again at most every few seconds (a git call). */
	private changes: { roomId: string; at: number; list: readonly Change[] } | undefined;
	private shownChanges: readonly Change[] = [];
	private readonly follow = new DetailsFollow();
	/** The palette's Remember asked for the form before the panel had loaded. */
	private rememberAsked = false;

	constructor(private readonly host: DetailsHost) {
		this.disposables.push(
			vscode.window.registerWebviewViewProvider(DETAILS_VIEW_ID, this),
			// The palette's "Remember for every agent": the panel's own field, not an input box at the top.
			vscode.commands.registerCommand('arkestra.details.remember', async () => {
				this.rememberAsked = true;
				await vscode.commands.executeCommand(`${DETAILS_VIEW_ID}.focus`);
				if (this.view) {
					void this.view.webview.postMessage({ type: 'rememberOpen' }).then(delivered => { if (delivered) { this.rememberAsked = false; } });
				}
			}),
			host.threads.onDidChangeActive(() => this.schedule()),
			host.threads.onDidChangeSurface(surface => this.surfaceChanged(surface)),
			host.onDidChangeThread(roomId => { if (roomId === host.threads.activeRoomId()) { this.schedule(); } }),
		);
	}

	/** A page in the middle closes the right bar; a thread opens it again, unless the user closed it on a thread. */
	private surfaceChanged(surface: Surface): void {
		const action = this.follow.changed(surface);
		if (action === 'close') {
			void vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
		} else if (action === 'open') {
			// Only opens (a toggle would close a bar that is already open but not reported yet); the composer keeps the focus.
			void Promise.resolve(vscode.commands.executeCommand(`${DETAILS_VIEW_ID}.focus`))
				.then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'), () => undefined);
		}
		this.schedule(0);
	}

	dispose(): void {
		clearTimeout(this.timer);
		clearInterval(this.tick);
		this.disposables.forEach(d => d.dispose());
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [FONT_ROOT] };
		const shared = sharedStrings();
		view.webview.html = detailsPage(randomBytes(16).toString('base64'), pageFonts(view.webview), shared);
		view.webview.onDidReceiveMessage(async (message: { type?: string; index?: unknown; file?: unknown; form?: unknown; values?: unknown }) => {
			if (message.type === 'ready') {
				this.schedule(0);
				if (this.rememberAsked) {
					this.rememberAsked = false;
					void view.webview.postMessage({ type: 'rememberOpen' });
				}
			} else if (message.type === 'shared' && typeof message.file === 'string') {
				const rules = ['projectRules', 'agentsMd', 'userRules'].includes(message.file);
				await vscode.commands.executeCommand(rules ? 'arkestra.shared.openRules' : 'arkestra.shared.openMemory', message.file);
			} else if (message.type === 'form' && message.form === shared.form.id) {
				const read = readForm(shared.form, message.values, vscode.l10n.t('Required'));
				if (!read.ok) {
					void view.webview.postMessage({ type: 'formError', form: shared.form.id, field: read.field, message: read.message });
					return;
				}
				const added = await vscode.commands.executeCommand<boolean>('arkestra.shared.remember', read.values.text);
				void view.webview.postMessage({ type: 'formDone', form: shared.form.id, note: added ? vscode.l10n.t('Added to the shared memory.') : vscode.l10n.t('The shared memory already has this.') });
			} else if (message.type === 'change' && typeof message.index === 'number') {
				const change = this.shownChanges[message.index];
				if (change) {
					await vscode.commands.executeCommand('arkestra.changes.open', change);
				}
			}
		});
		this.follow.changed(this.host.threads.currentSurface());
		this.follow.visibility(view.visible);
		view.onDidChangeVisibility(() => {
			this.follow.visibility(view.visible);
			if (view.visible) {
				this.changes = undefined;
				this.schedule(0);
			}
		});
		view.onDidDispose(() => {
			this.follow.visibility(false);
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
		// A board, the artifacts or the new chat have their own details in the page.
		const roomId = this.follow.showsThread() ? this.host.threads.activeRoomId() : undefined;
		const room = roomId ? await this.host.open(roomId) : undefined;
		view.description = room?.state.title;
		const project = !!vscode.workspace.workspaceFolders?.length;
		if (!room) {
			this.shownChanges = [];
			void view.webview.postMessage({ type: 'render', project, html: `<div class="empty">${escapeHtml(vscode.l10n.t('Open a thread to see its agents, tasks and changes.'))}</div>` });
			return;
		}
		const roster = room.roster.map(id => ({ id, name: this.host.registry.get(id)?.name ?? id, activity: this.host.activity.get(room.id, id) }));
		const model = detailsModel(roster, Date.now());
		// A turn driven from the agent's own app (the Codex app, a terminal) works here too.
		const agents = model.agents.map(a => (a.turn === 'idle' || a.turn === 'done') && this.host.liveRunning?.(room, a.id) ? { ...a, turn: 'working' as const } : a);
		const changes = await this.changesOf(room.id);
		this.shownChanges = changes;
		const empty = (text: string) => `<div class="empty">${escapeHtml(text)}</div>`;
		const head = (text: string) => `<div class="rh">${escapeHtml(text)}</div>`;
		const parts: string[] = [];

		parts.push(head(vscode.l10n.t('Agents in this thread')));
		parts.push(agents.length
			? agents.map(a => `<div class="rr"><span class="dot ${a.turn}"></span><span class="n">${escapeHtml(a.name)}</span><span class="k">${escapeHtml(vscode.l10n.t(TURN_TEXT[a.turn]))}</span></div>`).join('')
			: empty(vscode.l10n.t('Nobody in this thread yet.')));

		parts.push('<div class="hr"></div>', head(vscode.l10n.t('Background tasks')));
		// The adopted sessions' own background tasks (a command its app started) beside this room's.
		let finished = model.finished;
		const running: DetailsTask[] = [...model.running];
		for (const id of room.roster) {
			const own = this.host.liveBackground?.(room, id);
			if (!own) {
				continue;
			}
			finished += own.done;
			for (const t of own.tasks) {
				running.push({ name: t.name, kind: 'background', since: t.since, elapsed: t.since ? elapsed(Date.now() - Date.parse(t.since)) : '' });
			}
		}
		running.sort((a, b) => a.since.localeCompare(b.since));
		const tasks = running.map(t => `<div class="rr" title="${escapeHtml(t.detail ?? t.name)}">${t.kind === 'subagent' ? ICONS.agent : ICONS.terminal}<span class="n">${escapeHtml(t.detail ? `${t.name} · ${t.detail}` : t.name)}</span><span class="k">${escapeHtml(t.elapsed)}</span></div>`);
		if (finished) {
			tasks.push(`<div class="rr mut">${ICONS.done}<span class="n">${escapeHtml(vscode.l10n.t('{0} finished', finished))}</span></div>`);
		}
		parts.push(tasks.length ? tasks.join('') : empty(vscode.l10n.t('Nothing in the background.')));

		parts.push('<div class="hr"></div>', head(vscode.l10n.t('Changes')));
		// No checkpoint of its own: an adopted session's folder as its app counts it (git against the last commit).
		const tree = changes.length ? undefined : await this.host.worktreeChanges?.(room).catch(() => undefined);
		if (tree?.length) {
			const added = tree.reduce((n, c) => n + (c.added ?? 0), 0);
			const removed = tree.reduce((n, c) => n + (c.removed ?? 0), 0);
			parts.push(`<div class="rr mut"><span class="n">${escapeHtml(vscode.l10n.t(tree.length === 1 ? '{0} file changed' : '{0} files changed', tree.length))}</span><span class="k"><span class="add">+${added}</span> <span class="del">−${removed}</span></span></div>`);
			parts.push(tree.slice(0, 60).map(c => {
				const dir = path.posix.dirname(c.path);
				const counts = c.status === '?' ? '<span class="st A">new</span>' : `<span class="k"><span class="add">+${c.added ?? '·'}</span> <span class="del">−${c.removed ?? '·'}</span></span>`;
				return `<div class="rr" title="${escapeHtml(c.path)}">${ICONS.file}<span class="n">${escapeHtml(path.posix.basename(c.path))}</span>${dir !== '.' ? `<span class="k">${escapeHtml(dir)}</span>` : ''}${counts}</div>`;
			}).join(''));
		} else {
			parts.push(changes.length
				? changes.map((c, i) => {
					const dir = path.posix.dirname(c.path);
					return `<button class="rr" data-change="${i}" title="${escapeHtml(c.path)}">${ICONS.file}<span class="n">${escapeHtml(path.posix.basename(c.path))}</span>${dir !== '.' ? `<span class="k">${escapeHtml(dir)}</span>` : ''}<span class="st ${c.status}">${c.status}</span></button>`;
				}).join('')
				: empty(vscode.l10n.t('No changes since the last accepted state.')));
		}

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
		parts.push(this.meters(room, roster));
		void view.webview.postMessage({ type: 'render', project, html: parts.join('') });
	}

	/** Each agent's context fill and its account's quota windows; with more than one agent, each named. */
	private meters(room: Room, roster: readonly { id: string; name: string; activity: ReturnType<ActivityBoard['get']> }[]): string {
		const out: string[] = [];
		for (const a of roster) {
			const link = room.state.adopted?.[a.id];
			const quota = this.host.quota(a.id);
			const cloud = this.host.cloudContext(room, a.id);
			const m = agentMeter({
				...(a.activity.usage ? { usage: a.activity.usage } : {}),
				...(link ? { session: { ...(link.context ? { context: link.context } : {}), ...(link.window ? { window: link.window } : {}) } } : {}),
				...(cloud ? { cloud } : {}),
				...(quota ? { quota } : {}),
			});
			const who = roster.length > 1 ? ` · ${a.name.split(' · ')[0]}` : '';
			const c = m.context;
			if (c?.window) {
				const p = Math.min(100, Math.round((c.used / c.window) * 100));
				out.push(meterHtml(vscode.l10n.t('Context') + who, p, tone(p), vscode.l10n.t('{0} / {1} tokens', formatTokens(c.used), formatTokens(c.window))));
			} else if (c) {
				out.push(meterHtml(vscode.l10n.t('Context') + who, undefined, '', vscode.l10n.t('{0} tokens', formatTokens(c.used))));
			} else {
				out.push(`<div class="rr mut"><span class="n">${escapeHtml(vscode.l10n.t('Context') + who)}</span><span class="k">${escapeHtml(vscode.l10n.t('not reported yet'))}</span></div>`);
			}
			for (const l of m.limits) {
				out.push(meterHtml(`${vscode.l10n.t('Quota')}${who} · ${quotaLabel(l.label)}`, l.usedPercent, quotaTone(l.usedPercent), l.resetsAt ? resetText(l.resetsAt) : ''));
			}
		}
		return out.join('');
	}
}

/** A quota window's label as the panel says it: `week` → weekly, `5h` → 5-hour. */
function quotaLabel(label: string): string {
	const hours = /^(\d+)h$/.exec(label);
	return label === 'week' ? vscode.l10n.t('weekly')
		: label.startsWith('week · ') ? `${vscode.l10n.t('weekly')} · ${label.slice(7)}`
			: hours ? vscode.l10n.t('{0}-hour', hours[1]) : label;
}

/** When a quota window starts again, in the user's local time. */
function resetText(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? '' : vscode.l10n.t('Resets {0}', at.toLocaleString(vscode.env.language, { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }));
}

function meterHtml(name: string, percent: number | undefined, toneClass: string, sub: string): string {
	return `<div class="meter"><div class="top"><span class="n">${escapeHtml(name)}</span>${percent !== undefined ? `<b>${percent}%</b>` : ''}</div>`
		+ `${percent !== undefined ? `<span class="bar ${toneClass}"><b data-w="${percent}"></b></span>` : ''}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ''}</div>`;
}

function sharedStrings(): SharedStrings {
	return {
		heading: vscode.l10n.t('Rules and memory for every agent'),
		projectRules: vscode.l10n.t('Project rules (.arkestra/rules.md)'),
		agentsMd: vscode.l10n.t('Project rules (AGENTS.md)'),
		userRules: vscode.l10n.t('My rules (every project)'),
		projectMemory: vscode.l10n.t('Project memory'),
		userMemory: vscode.l10n.t('My memory (every project)'),
		remember: vscode.l10n.t('Remember for every agent…'),
		form: {
			id: 'remember',
			fields: [{ kind: 'textarea', id: 'text', label: vscode.l10n.t('A decision, convention or pitfall every agent should know in this project') }],
			submit: vscode.l10n.t('Remember'),
			cancel: vscode.l10n.t('Cancel'),
		},
	};
}

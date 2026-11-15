/*---------------------------------------------------------------------------------------------
 *  Arkestra. A thread in Arkestra's own panel: the room's messages, its running turns token by
 *  token, the composer; and the new-chat page where the agents are chosen. One panel per thread.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fs, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { ActivityBoard } from './activity';
import type { AgentChoices, AgentRegistry, InviteEntry } from './agent';
import { chipLabel, modelMenu, type Choice, type MenuItem } from './choice';
import { allowedImage, attachmentName, fileReference, imageSource, type ImageResolver } from './images';
import { FormRequests, formHtml, type FormSpec } from './pageForm';
import type { Room } from './room';
import { ICONS, escapeHtml, liveHtml, menuHtml, renderMarkdown, rowHtml, threadPage, type ThreadStrings } from './threadHtml';
import { FONT_ROOT, pageFonts } from './webviewFonts';
import { LabelCache, agentChip, agentTitle, composerRight, machineOf, parseSlash, providerOf, threadRows, type LiveTurns, type Row } from './threadModel';
import { projectName, titleFrom } from './threads';
import { surfaceOf, type Surface } from './surface';
import { turnState } from './work';

export const THREAD_VIEW_TYPE = 'arkestra.thread';
/** The room's slash commands; the panel hands them to the same path as the chat. */
export const SLASH_COMMANDS: readonly string[] = ['invite', 'agents', 'new', 'template', 'continue', 'approve', 'plan', 'execute', 'best', 'compare'];
/** Who worked in the last new thread (shared with the agent pick of the palette). */
const LAST_AGENTS = 'arkestra.rooms.lastAgents';

/** What the panel needs from the rooms. */
export interface ThreadHost {
	readonly registry: AgentRegistry;
	readonly activity: ActivityBoard;
	readonly live: LiveTurns;
	/** A message, an agent's state or work, a model choice changed. */
	readonly onDidChangeThread: vscode.Event<string>;
	open(roomId: string): Promise<Room | undefined>;
	/** Makes the room the current one (palette commands, Changes view). */
	use(room: Room): Promise<unknown>;
	/** A new room with these agents in a project (default: this window's). */
	createRoom(agentIds: readonly string[], title: string, project?: string): Promise<Room>;
	/** The chat's own path for one message: slash commands, template rooms, a plain round. */
	send(room: Room, request: { readonly prompt: string; readonly command?: string }, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void>;
	/** Stops what runs in the room (a round started elsewhere, a template room). */
	stop(roomId: string): Promise<void>;
	/** The agent's model and effort in this thread, as the composer's chip shows it (`Opus 5.5 · High`, `Default`). */
	modelLabel(room: Room, agentId: string): Promise<string>;
	/** The models and efforts the agent offers (cached; reading them can be slow over SSH). */
	agentChoices(agentId: string): Promise<AgentChoices | undefined>;
	/** Sets the agent's model and effort in this thread; empty: its own default. */
	setChoice(room: Room, agentId: string, choice: Choice): Promise<void>;
	/** Plan mode on or off for the thread (the mode menu; /plan and /execute do the same). */
	setMode(room: Room, mode: 'plan' | undefined): Promise<void>;
	/** The SSH agent whose machine has the session this thread's local agent continues (its CLI is not installed here). */
	sessionElsewhere?(room: Room, agentId: string): Promise<{ readonly id: string; readonly machine: string } | undefined>;
	/** Moves the thread from this computer's agent to that SSH agent and reads the session there. */
	continueOn?(room: Room, from: string, to: string): Promise<void>;
	/** Invites a ready agent into the room (it receives the thread from the beginning). */
	invite(room: Room, agentId: string): Promise<unknown>;
}

/** The popovers a command may open on a thread's page (the invite list, an agent's model, whose model). */
export type ThreadMenu = 'invite' | 'model' | 'models';

interface View {
	readonly panel: vscode.WebviewPanel;
	/** Undefined: the new-chat page. */
	roomId?: string;
	/** The new-chat page's project and preselected agents. */
	project?: string;
	preselect?: readonly string[];
	sending?: vscode.CancellationTokenSource;
	/** A turn started during this send: its output shows as rows, not as a notice. */
	roundSeen: boolean;
	notice: string;
	buttons: vscode.Command[];
	scroll: boolean;
	timer?: ReturnType<typeof setTimeout>;
	/** The message just sent, shown at once until the room has it (references and a checkpoint come first). */
	pending?: { readonly text: string; readonly after: number };
	/** The page's ticked agents follow `preselect` again (the page was asked for with other agents). */
	reset?: boolean;
	/** Text for the composer that waits until the page has loaded. */
	insert?: string;
	/** Files pasted or dropped into this page's composer (they may be taken out again). */
	readonly saved: Set<string>;
	/** The folders the page may load from, as last set. */
	roots?: string;
	/** The forms open in this page's popovers. */
	readonly forms: FormRequests;
	/** A popover a command asked for, sent again when the page loads. */
	openMenu?: { readonly anchor: string; readonly menu: string; readonly agentId?: string };
}

/** A real path (symlinks resolved), or undefined when it is not there. */
function real(p: string): string | undefined {
	try {
		return realpathSync.native(p);
	} catch {
		return undefined;
	}
}

/** The local folder of a project URI string, if it is one on this machine. */
function projectFolder(project: string | undefined): string | undefined {
	if (!project) {
		return undefined;
	}
	try {
		const uri = vscode.Uri.parse(project);
		return uri.scheme === 'file' ? uri.fsPath : undefined;
	} catch {
		return undefined;
	}
}

/** Where Claude Code and Codex keep their sessions (and the pictures Arkestra read from them). */
function agentHomes(): string[] {
	return [path.join(homedir(), '.claude'), process.env.CODEX_HOME ?? '', path.join(homedir(), '.codex')].filter(Boolean);
}

export class ThreadViews implements vscode.Disposable {
	private readonly views = new Set<View>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly rowCache = new Map<string, string>();
	/** Model labels per room, agent and choice; reading an agent's models can be slow (SSH), so never awaited in an update. */
	private readonly labels = new LabelCache();
	/** Per room and agent: the SSH machine that has the session, for an error row (read in the background, like the labels). */
	private readonly homes = new Map<string, { readonly id: string; readonly machine: string } | null | Promise<void>>();
	private active: View | undefined;
	private readonly activeChanged = new vscode.EventEmitter<string | undefined>();
	/** The thread of the panel used last; the right panel follows it. */
	readonly onDidChangeActive = this.activeChanged.event;
	private surface: Surface = 'editor';
	private readonly surfaceChanged = new vscode.EventEmitter<Surface>();
	/** The middle shows a thread, another page (a board, the artifacts, the new chat) or an editor. */
	readonly onDidChangeSurface = this.surfaceChanged.event;

	constructor(private readonly context: vscode.ExtensionContext, private readonly host: ThreadHost) {
		this.disposables.push(
			this.activeChanged,
			this.surfaceChanged,
			vscode.window.tabGroups.onDidChangeTabs(() => this.updateSurface()),
			vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateSurface()),
			vscode.window.registerWebviewPanelSerializer(THREAD_VIEW_TYPE, {
				deserializeWebviewPanel: async (panel, state: { roomId?: unknown } | undefined) => {
					this.adopt(panel, typeof state?.roomId === 'string' ? state.roomId : undefined);
				},
			}),
			// Puts text (an @-reference) into the composer of the thread used last, or of a new chat.
			vscode.commands.registerCommand('arkestra.rooms.insertInThread', (text: unknown) => {
				if (typeof text !== 'string' || !text) {
					return;
				}
				let view: View | undefined = this.active ?? [...this.views][0];
				if (!view) {
					this.openNew();
					view = [...this.views].find(v => !v.roomId);
				}
				if (view) {
					view.panel.reveal();
					view.insert = `${view.insert ? `${view.insert} ` : ''}${text}`;
					void view.panel.webview.postMessage({ type: 'insert', text: view.insert }).then(delivered => { if (delivered) { view!.insert = undefined; } });
				}
			}),
			vscode.commands.registerCommand('arkestra.rooms.newChat', (arg?: unknown) => {
				const opts = arg && typeof arg === 'object' ? arg as { project?: unknown; agents?: unknown; menu?: unknown } : {};
				this.openNew({
					...(typeof opts.project === 'string' ? { project: opts.project } : {}),
					...(Array.isArray(opts.agents) ? { agents: opts.agents.filter((a): a is string => typeof a === 'string') } : {}),
					// The palette's "Add an ACP agent": the page's own form above its card.
					...(opts.menu === 'acp' ? { menu: 'acp' as const } : {}),
				});
			}),
			host.onDidChangeThread(roomId => this.refreshRoom(roomId)),
			host.live.onDidChange(roomId => {
				for (const view of this.views) {
					if (view.roomId === roomId) {
						if (view.sending && host.live.parts(roomId).length) {
							view.roundSeen = true;
						}
						this.schedule(view);
					}
				}
			}),
			host.registry.onDidChange(() => { for (const view of this.views) { if (!view.roomId) { this.schedule(view); } } }),
		);
	}

	dispose(): void {
		for (const view of this.views) {
			clearTimeout(view.timer);
			view.panel.dispose();
		}
		this.disposables.forEach(d => d.dispose());
	}

	/** What the active tab in the middle shows. */
	currentSurface(): Surface {
		return this.surface;
	}

	private updateSurface(): void {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		const webview = input instanceof vscode.TabInputWebview ? input.viewType : undefined;
		const shown = [...this.views].find(v => v.panel.active);
		const surface = surfaceOf(webview !== undefined ? { webview } : undefined, THREAD_VIEW_TYPE, shown?.roomId);
		if (surface !== this.surface) {
			this.surface = surface;
			this.surfaceChanged.fire(surface);
		}
	}

	/** The thread of the active (or last active) thread panel. */
	activeRoomId(): string | undefined {
		return this.active?.roomId;
	}

	/** Opens the thread's panel, or shows it when it is open. */
	async open(roomId: string, column?: vscode.ViewColumn): Promise<void> {
		const existing = [...this.views].find(v => v.roomId === roomId);
		if (existing) {
			existing.panel.reveal(column ?? existing.panel.viewColumn);
			this.activate(existing);
			return;
		}
		this.activate(this.adopt(this.createPanel(column), roomId));
	}

	/** The new-chat page (one at a time): who works in the thread, then its first message; `menu`: with the new ACP agent's form open. */
	openNew(opts: { project?: string; agents?: readonly string[]; menu?: 'acp' } = {}): void {
		let view = [...this.views].find(v => !v.roomId);
		if (view) {
			view.project = opts.project;
			view.preselect = opts.agents;
			view.reset = !!opts.agents;
			view.panel.reveal();
			this.schedule(view);
		} else {
			view = this.adopt(this.createPanel(), undefined);
			view.project = opts.project;
			view.preselect = opts.agents;
		}
		if (opts.menu === 'acp') {
			const open = { anchor: 'card:+add', menu: 'acp' };
			const target = view;
			target.openMenu = open;
			void target.panel.webview.postMessage({ type: 'openMenu', ...open }).then(delivered => { if (delivered && target.openMenu === open) { target.openMenu = undefined; } }, () => undefined);
		}
	}

	/**
	 * Opens the thread and the popover a command asks for, where its chip is: the invite list
	 * at + agent, an agent's models at its chip (or at the model chip when it is the only one).
	 */
	async showMenu(roomId: string, menu: ThreadMenu, agentId?: string): Promise<void> {
		await this.open(roomId);
		const view = [...this.views].find(v => v.roomId === roomId);
		const room = await this.host.open(roomId);
		if (!view || !room) {
			return;
		}
		const choosers = room.roster.filter(id => this.host.registry.get(id)?.choices);
		const only = room.roster.length === 1 && choosers.length === 1 ? choosers[0] : undefined;
		const target = menu === 'model' && agentId && room.roster.includes(agentId) ? agentId : undefined;
		const open = menu === 'invite' ? { anchor: 'invite', menu: 'invite' }
			: target ? (target === only ? { anchor: 'model', menu: 'model', agentId: target } : { anchor: `agent:${target}`, menu: 'model', agentId: target })
				: only ? { anchor: 'model', menu: 'model', agentId: only } : { anchor: 'model', menu: 'models' };
		view.openMenu = open;
		void view.panel.webview.postMessage({ type: 'openMenu', ...open }).then(delivered => { if (delivered && view.openMenu === open) { view.openMenu = undefined; } }, () => undefined);
	}

	/** Closes the thread's panel (the thread was deleted). */
	close(roomId: string): void {
		for (const view of [...this.views]) {
			if (view.roomId === roomId) {
				view.panel.dispose();
			}
		}
	}

	private createPanel(column?: vscode.ViewColumn): vscode.WebviewPanel {
		return vscode.window.createWebviewPanel(THREAD_VIEW_TYPE, vscode.l10n.t('New chat'), column ?? vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true, localResourceRoots: this.resourceRoots() });
	}

	/** The rooms' file folders (pasted pictures, template files). */
	private filesRoot(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'room-files');
	}

	/** A room's own folder; a new chat's files wait in `_new` until its room exists. */
	private roomFolder(roomId: string | undefined): string {
		return path.join(this.filesRoot(), roomId && /^[\w.-]+$/.test(roomId) && !roomId.startsWith('.') ? roomId : '_new');
	}

	/** The folders a thread's pictures may come from: its room's folder, the workspace and project folders, the agents' session folders. */
	private imageRoots(room: Room | undefined): string[] {
		const list = [
			this.roomFolder(room?.id),
			...(vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
			projectFolder(room?.state.project) ?? '',
			...agentHomes(),
		].filter(Boolean);
		return [...new Set(list.flatMap(p => { const r = real(p); return r && r !== p ? [p, r] : [p]; }))];
	}

	/** What the webview may load at all (the page checks each picture against its own room's folders). */
	private resourceRoots(room?: Room): vscode.Uri[] {
		const roots = [this.filesRoot(), ...this.imageRoots(room).slice(1)];
		return [FONT_ROOT, ...[...new Set(roots)].map(p => vscode.Uri.file(p))];
	}

	/** Sets the page's resource folders when they changed (a room's project, a workspace folder). */
	private updateRoots(view: View, room: Room | undefined): void {
		const roots = this.resourceRoots(room);
		const key = roots.map(r => r.toString()).join('\n');
		if (view.roots !== key) {
			view.roots = key;
			view.panel.webview.options = { enableScripts: true, localResourceRoots: roots };
		}
	}

	/** A picture's address in the page: data: and https as they are; a file only under the room's allowed folders, its symlinks resolved. */
	private resolver(view: View, room: Room | undefined): ImageResolver {
		const roots = this.imageRoots(room);
		const base = projectFolder(room?.state.project) ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
		const home = homedir();
		return src => {
			const source = imageSource(src, { home, ...(base ? { base } : {}) });
			if (!source) {
				return undefined;
			}
			if (source.kind !== 'file') {
				return source.url;
			}
			const file = real(source.path);
			return file && allowedImage(file, roots) ? view.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString() : undefined;
		};
	}

	private adopt(panel: vscode.WebviewPanel, roomId: string | undefined): View {
		const view: View = {
			panel, ...(roomId ? { roomId } : {}), roundSeen: false, notice: '', buttons: [], scroll: true, saved: new Set(),
			forms: new FormRequests(message => this.post(view, message), vscode.l10n.t('Required')),
		};
		this.views.add(view);
		panel.iconPath = new vscode.ThemeIcon(roomId ? 'comment-discussion' : 'add');
		this.updateRoots(view, undefined);
		const nonce = randomBytes(16).toString('base64');
		panel.webview.html = threadPage({
			nonce,
			cspSource: panel.webview.cspSource,
			mode: roomId ? 'thread' : 'new',
			...(roomId ? { roomId } : {}),
			placeholder: roomId ? vscode.l10n.t('Write to the agents of this thread…') : vscode.l10n.t('What should they do?'),
			heading: vscode.l10n.t('Who do you work with?'),
			fonts: pageFonts(panel.webview),
			close: vscode.l10n.t('Close'),
			attach: vscode.l10n.t('Attach a file, the changes or a terminal command'),
		});
		panel.onDidDispose(() => {
			// A running round goes on; the thread shows it again when reopened.
			clearTimeout(view.timer);
			view.forms.cancelAll();
			this.views.delete(view);
			if (this.active === view) {
				this.active = undefined;
				this.activeChanged.fire(undefined);
			}
			this.updateSurface();
		});
		panel.onDidChangeViewState(e => { if (e.webviewPanel.active) { this.activate(view); } else { this.updateSurface(); } });
		panel.webview.onDidReceiveMessage(message => this.receive(view, message));
		if (panel.active) {
			this.activate(view);
		}
		return view;
	}

	private activate(view: View): void {
		const changed = this.active !== view;
		this.active = view;
		if (view.roomId) {
			void this.host.open(view.roomId).then(room => room && this.host.use(room));
		}
		if (changed) {
			this.activeChanged.fire(view.roomId);
		}
		this.updateSurface();
	}

	private refreshRoom(roomId: string): void {
		for (const view of this.views) {
			if (view.roomId === roomId) {
				this.schedule(view);
			}
		}
	}

	private post(view: View, message: object): void {
		if (this.views.has(view)) {
			view.panel.webview.postMessage(message).then(undefined, () => undefined);
		}
	}

	/** Coalesces updates: a stream of tokens becomes a few posts a second. */
	private schedule(view: View, delay = 40): void {
		if (view.timer) {
			return;
		}
		view.timer = setTimeout(() => {
			view.timer = undefined;
			if (this.views.has(view)) {
				void this.push(view);
			}
		}, delay);
	}

	private strings(): ThreadStrings {
		return {
			local: vscode.l10n.t('this machine'),
			attached: n => vscode.l10n.t('+{0} attached', n),
			tasksDone: n => n === 1 ? vscode.l10n.t('1 background task finished') : vscode.l10n.t('{0} background tasks finished', n),
			tasks: n => n === 1 ? vscode.l10n.t('1 background task') : vscode.l10n.t('{0} background tasks', n),
			other: n => n === 1 ? vscode.l10n.t('1 system message') : vscode.l10n.t('{0} system messages', n),
			working: vscode.l10n.t('working…'),
			copy: vscode.l10n.t('Copy'),
			runsOn: machine => vscode.l10n.t('This session runs on {0}: open it from there.', machine),
			continueOn: machine => vscode.l10n.t('Continue on {0}', machine),
		};
	}

	private clientStrings() {
		return { send: vscode.l10n.t('Send'), stop: vscode.l10n.t('Stop'), copy: vscode.l10n.t('Copy'), remove: vscode.l10n.t('Remove'), loading: vscode.l10n.t('Loading…'), noAgents: vscode.l10n.t('No agent is known yet. Add a machine or sign in to an agent first.') };
	}

	private async push(view: View): Promise<void> {
		if (view.roomId) {
			await this.pushThread(view, view.roomId);
		} else {
			await this.pushNew(view);
		}
	}

	private rowHtml(row: Row, s: ThreadStrings, image: ImageResolver, roomId: string): string {
		// Who wrote it is part of the key: a thread that moved to another machine's agent shows the new name on its old rows.
		const key = `${roomId}:${row.id}:${row.type === 'fold' ? `${row.items.length}:${JSON.stringify(row.items).length}` : row.text.length}${row.type === 'agent' || row.type === 'error' ? `:${row.agentId}:${row.name}` : ''}${row.type === 'error' ? `:${row.home?.id ?? ''}` : ''}`;
		let html = this.rowCache.get(key);
		if (html === undefined) {
			const time = row.type === 'agent' && row.at ? new Date(row.at).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' }) : '';
			html = rowHtml(row, s, renderMarkdown, time, image);
			if (this.rowCache.size > 4000) {
				this.rowCache.clear();
			}
			this.rowCache.set(key, html);
		}
		return html;
	}

	private async pushThread(view: View, roomId: string): Promise<void> {
		const room = await this.host.open(roomId);
		const s = this.strings();
		if (!room) {
			this.post(view, { type: 'thread', rows: [], live: [], notice: `<div class="notice">${escapeHtml(vscode.l10n.t('This thread no longer exists.'))}</div>`, chips: [], right: [], busy: false, strings: this.clientStrings() });
			return;
		}
		view.panel.title = room.state.title;
		view.panel.iconPath = new vscode.ThemeIcon('comment-discussion');
		this.updateRoots(view, room);
		const image = this.resolver(view, room);
		const rows = threadRows(room.messages).map(row => row.type === 'error' && row.missing ? { ...row, ...this.homeOf(view, room, row.agentId) } : row)
			.map(row => ({ key: row.id, html: this.rowHtml(row, s, image, room.id) }));
		if (view.pending && room.messages.slice(view.pending.after).some(m => m.author.kind === 'user')) {
			view.pending = undefined;
		}
		if (view.pending) {
			rows.push({ key: 'pending', html: rowHtml({ type: 'user', id: 'pending', at: '', text: view.pending.text, attached: 0 }, s, renderMarkdown, '', image) });
		}
		const parts = this.host.live.parts(room.id);
		const live = parts.map(p => ({ key: `live:${p.agentId}`, html: liveHtml(p, this.host.registry.get(p.agentId)?.name ?? p.agentId, s, image) }));
		const turns = room.roster.map(id => { const a = this.host.activity.get(room.id, id); return turnState(a.state, a.work, a.error, !!a.ran); });
		const busy = !!view.sending || parts.length > 0 || turns.some(t => t === 'working' || t === 'waiting' || t === 'queued');
		const chips: object[] = room.roster.map((id, i) => {
			const agent = this.host.registry.get(id);
			const turn = turns[i];
			return {
				key: `agent:${id}`,
				label: agentChip(agent?.name ?? id, id),
				dot: turn === 'working' || turn === 'queued' ? 'working' : turn === 'waiting' ? 'waiting' : agent ? '' : 'warn',
				title: agent ? `${agent.detail}` : vscode.l10n.t('not available now'),
				...(agent?.choices ? { menu: { menu: 'model', agentId: id } } : {}),
			};
		});
		chips.push({ key: 'invite', label: vscode.l10n.t('+ agent'), cls: 'add', title: vscode.l10n.t('Invite an agent into this thread'), menu: { menu: 'invite' } });
		const right = composerRight(room, id => !!this.host.registry.get(id)?.choices, id => this.modelLabel(view, room, id), {
			models: vscode.l10n.t('Models'), auto: vscode.l10n.t('Auto'), plan: vscode.l10n.t('Plan'),
			modelTitle: vscode.l10n.t('Model and effort'), modeTitle: vscode.l10n.t('Permission mode'),
		});
		const buttons = view.buttons.map((b, i) => `<button class="chip" data-button="${i}">${escapeHtml(b.title)}</button>`).join('');
		const notice = view.notice.trim() || buttons ? `<div class="notice">${view.notice.trim() ? `<div class="md">${renderMarkdown(view.notice.trim())}</div>` : ''}${buttons ? `<div class="nbtns">${buttons}</div>` : ''}</div>` : '';
		const scroll = view.scroll;
		view.scroll = false;
		this.post(view, {
			type: 'thread', roomId: room.id, rows, live, notice, chips, right, busy, scroll,
			placeholder: room.roster.length ? vscode.l10n.t('Write to the agents of this thread…') : vscode.l10n.t('Invite an agent with + agent first'),
			strings: this.clientStrings(),
		});
	}

	/**
	 * Where an error row's agent could go on: the SSH machine that has the thread's session, when
	 * the agent is this computer's and its CLI is not here. Read once in the background per session.
	 */
	private homeOf(view: View, room: Room, agentId: string): { home?: { readonly id: string; readonly machine: string } } {
		const session = room.state.adopted?.[agentId]?.session;
		if (!session || machineOf(agentId) || !this.host.sessionElsewhere) {
			return {};
		}
		const key = `${room.id}:${agentId}:${session}`;
		const known = this.homes.get(key);
		if (known === undefined) {
			this.homes.set(key, this.host.sessionElsewhere(room, agentId).then(home => { this.homes.set(key, home ?? null); }, () => { this.homes.set(key, null); }).finally(() => this.schedule(view)));
		}
		return known && !(known instanceof Promise) ? { home: known } : {};
	}

	/**
	 * The cached label; a missing one is read in the background (the plain one shows meanwhile) and
	 * the panel updated when it arrives. The session's own model and fill are in the key: a thread
	 * read again (healed, moved to its machine) shows its model without a reload.
	 */
	private modelLabel(view: View, room: Room, agentId: string): string {
		const choice = room.state.choices?.[agentId];
		const plain = chipLabel(choice, undefined, vscode.l10n.t('Default'));
		return this.labels.get(room.id, agentId, choice, room.state.adopted?.[agentId], () => this.host.modelLabel(room, agentId), () => this.schedule(view)) || plain;
	}

	/**
	 * A popover of the page: an agent's models and efforts, whose model to set, the thread's
	 * mode, who to invite, what to attach, what makes an agent ready (a key typed in its own
	 * field), or a new ACP agent's form. Forms answer through `view.forms`.
	 */
	private async menu(view: View, anchor: string, kind: string, agentId: string | undefined, index?: number): Promise<void> {
		const reply = (html: string) => this.post(view, { type: 'menu', anchor, html });
		const name = (id: string) => agentChip(this.host.registry.get(id)?.name ?? id, id);
		if (kind === 'attach') {
			reply(menuHtml([
				{ kind: 'header', label: vscode.l10n.t('Attach to the message') },
				{ label: vscode.l10n.t('File…'), detail: vscode.l10n.t('Pick files; they go in as @file references'), action: { type: 'attachRef', ref: 'file' } },
				{ label: vscode.l10n.t('Changes in the working tree'), detail: vscode.l10n.t('The uncommitted diff (@diff)'), action: { type: 'attachRef', ref: 'diff' } },
				{ label: vscode.l10n.t('Last terminal command'), detail: vscode.l10n.t('Its command and output (@terminal)'), action: { type: 'attachRef', ref: 'terminal' } },
			]));
			return;
		}
		if (kind === 'fix' || kind === 'secret') {
			const entry = agentId ? (await this.host.registry.inviteList([])).find(e => e.agent.id === agentId) : undefined;
			if (!entry || entry.readiness.ready) {
				reply(menuHtml([{ kind: 'header', label: entry ? vscode.l10n.t('{0} is ready.', agentTitle(entry.agent.name)) : vscode.l10n.t('This agent is no longer known.') }]));
				this.schedule(view);
				return;
			}
			const actions = entry.readiness.actions ?? [];
			const secret = kind === 'secret' && index !== undefined ? actions[index]?.secret : undefined;
			if (secret) {
				const spec: FormSpec = {
					id: `secret:${entry.agent.id}`,
					title: actions[index!].title,
					fields: [{ kind: 'password', id: 'key', label: secret.label, ...(secret.placeholder ? { placeholder: secret.placeholder } : {}), hint: vscode.l10n.t('Kept in the system\'s secret storage, never in a file or a log.') }],
					submit: vscode.l10n.t('Save'),
					cancel: vscode.l10n.t('Cancel'),
				};
				reply(formHtml(spec));
				if (await view.forms.open(spec, async values => { await secret.save(values.key); return undefined; })) {
					this.schedule(view);
				}
				return;
			}
			reply(menuHtml([
				{ kind: 'header', label: `${agentTitle(entry.agent.name)}: ${entry.readiness.reason ?? vscode.l10n.t('not ready')}` },
				...actions.map((a, i) => ({ label: a.title, ...(a.detail ? { detail: a.detail } : {}), action: a.secret ? { type: 'menu', menu: 'secret', agentId: entry.agent.id, index: i } : { type: 'fixRun', agentId: entry.agent.id, index: i } })),
				...(actions.length ? [] : [{ label: vscode.l10n.t('Nothing to do here; it may be ready later.'), action: {} }]),
			]));
			return;
		}
		if (kind === 'acp') {
			let spec: FormSpec | undefined;
			try {
				spec = await vscode.commands.executeCommand<FormSpec | undefined>('arkestra.acp.addForm');
			} catch {
				spec = undefined;
			}
			if (!spec?.fields?.length) {
				reply(menuHtml([{ kind: 'header', label: vscode.l10n.t('Other agents (ACP) are not available in this build.') }]));
				return;
			}
			reply(formHtml(spec));
			const added = await view.forms.open(spec, values => vscode.commands.executeCommand<{ field?: string; message: string } | undefined>('arkestra.acp.add', values));
			if (added) {
				this.schedule(view);
			}
			return;
		}
		const room = view.roomId ? await this.host.open(view.roomId) : undefined;
		if (!room) {
			return;
		}
		let items: MenuItem[] = [];
		if (kind === 'invite') {
			const entries = await this.host.registry.inviteList(room.roster);
			items = [
				{ kind: 'header', label: entries.length ? vscode.l10n.t('Invite into this thread · it reads the thread from the beginning') : vscode.l10n.t('No other agent is known yet.') },
				...entries.map(e => {
					// Two agents of one kind differ only by machine, so every row says where it runs.
					const machine = machineOf(e.agent.id) ?? e.agent.name.split(' · ')[1];
					const where = machine ? `${machine} · SSH` : vscode.l10n.t('this machine');
					return e.readiness.ready
						? { label: agentTitle(e.agent.name), detail: where, action: { type: 'inviteAgent', agentId: e.agent.id } }
						: { label: agentTitle(e.agent.name), detail: `${where} · ${e.readiness.reason ?? vscode.l10n.t('not ready')}${e.readiness.actions?.length ? ` · ${e.readiness.actions.map(a => a.title).join(' / ')}` : ''}`, action: { type: 'menu', menu: 'fix', agentId: e.agent.id } };
				}),
				{ kind: 'sep' },
				{ label: vscode.l10n.t('Add another agent (ACP)…'), detail: vscode.l10n.t('From the ACP Registry or a command of your own'), action: { type: 'menu', menu: 'acp' } },
			];
		} else if (kind === 'model' && agentId && room.roster.includes(agentId)) {
			const choices = await this.host.agentChoices(agentId);
			// With no model chosen here the thread runs what its session runs; the Default row names it.
			const sessionModel = !room.state.choices?.[agentId]?.model && room.state.adopted?.[agentId]?.model ? await this.host.modelLabel(room, agentId).then(l => l.split(' · ')[0], () => undefined) : undefined;
			items = choices?.models.length
				? modelMenu(agentId, room.state.choices?.[agentId], choices, {
					model: vscode.l10n.t('Model'), effort: vscode.l10n.t('Effort'), default: vscode.l10n.t('Default'),
					agentDefault: sessionModel ? vscode.l10n.t('{0}, the one the session runs', sessionModel) : vscode.l10n.t('the agent\'s own setting'), modelDefault: vscode.l10n.t('the model\'s own'),
				})
				: [{ kind: 'header', label: vscode.l10n.t('{0} offers no model choice.', name(agentId)) }];
		} else if (kind === 'models') {
			items = [
				{ kind: 'header', label: vscode.l10n.t('Whose model and effort?') },
				...room.roster.filter(id => this.host.registry.get(id)?.choices).map(id => ({ label: name(id), detail: this.modelLabel(view, room, id), action: { type: 'menu', menu: 'model', agentId: id } })),
			];
		} else if (kind === 'mode') {
			items = [
				{ kind: 'header', label: vscode.l10n.t('Permission mode') },
				{ label: vscode.l10n.t('Auto'), detail: vscode.l10n.t('The agents\' own permission settings'), checked: room.state.mode !== 'plan', action: { type: 'mode', mode: 'auto' } },
				{ label: vscode.l10n.t('Plan'), detail: vscode.l10n.t('Read and plan, change nothing'), checked: room.state.mode === 'plan', action: { type: 'mode', mode: 'plan' } },
			];
		}
		reply(menuHtml(items));
	}

	private cardHtml(entry: InviteEntry): string {
		const { agent, readiness } = entry;
		const machine = machineOf(agent.id);
		const where = machine ? `${agent.name.split(' · ')[1] ?? machine} · SSH` : vscode.l10n.t('this machine');
		const fix = readiness.actions?.[0]?.title;
		const state = readiness.ready
			? `<span class="g"></span><span>${escapeHtml(vscode.l10n.t('ready'))}</span>`
			: `<span class="w"></span><span>${escapeHtml(readiness.reason ?? vscode.l10n.t('not ready'))}${fix ? ` · <span class="fix" data-fix="1">${escapeHtml(fix)}</span>` : ''}</span>`;
		const title = agentTitle(agent.name);
		return `<div class="top"><i class="av ${providerOf(agent.id)}">${escapeHtml((title[0] ?? '?').toUpperCase())}</i>${escapeHtml(title)}<span class="chk">${ICONS.check}</span></div>`
			+ `<div class="sub2">${escapeHtml(where)}</div><div class="st">${state}</div>`;
	}

	private async pushNew(view: View): Promise<void> {
		view.panel.title = vscode.l10n.t('New chat');
		const entries = await this.host.registry.inviteList([]);
		const last = this.context.globalState.get<string[]>(LAST_AGENTS) ?? [];
		const project = view.project ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		const reset = view.reset;
		view.reset = false;
		const bold = (line: string, word: string) => escapeHtml(line).replace('\u0000', `<b>${escapeHtml(word)}</b>`);
		const hint = [
			bold(vscode.l10n.t('{0} = that agent only.', '\u0000'), vscode.l10n.t('One selected')),
			bold(vscode.l10n.t('{0} = a room for both.', '\u0000'), vscode.l10n.t('Two selected')),
			escapeHtml(vscode.l10n.t('The last choice is kept.')),
		].map(h => `<span>${h}</span>`).join('');
		this.post(view, {
			type: 'new',
			cards: entries.map(e => ({ id: e.agent.id, label: e.agent.name, ready: e.readiness.ready, html: this.cardHtml(e) })),
			addCard: { label: vscode.l10n.t('+ Another agent (ACP)'), detail: vscode.l10n.t('From the ACP Registry or a command of your own') },
			selected: view.preselect ?? last,
			reset: !!reset,
			right: project ? [{ label: projectName(project), cls: 'ghost', title: project }] : [],
			hint,
			placeholder: vscode.l10n.t('What should they do?'),
			strings: this.clientStrings(),
		});
	}

	private async receive(view: View, message: { type?: string; text?: unknown; agents?: unknown; agentId?: unknown; id?: unknown; index?: unknown; name?: unknown; mime?: unknown; data?: unknown; path?: unknown; uris?: unknown; anchor?: unknown; menu?: unknown; model?: unknown; effort?: unknown; mode?: unknown; ref?: unknown; form?: unknown; values?: unknown; to?: unknown }): Promise<void> {
		if (await view.forms.receive(message)) {
			return;
		}
		switch (message.type) {
			case 'menu':
				if (typeof message.anchor === 'string' && typeof message.menu === 'string') {
					await this.menu(view, message.anchor, message.menu, typeof message.agentId === 'string' ? message.agentId : undefined, typeof message.index === 'number' ? message.index : undefined);
				}
				break;
			case 'inviteAgent': {
				const room = view.roomId ? await this.host.open(view.roomId) : undefined;
				if (room && typeof message.agentId === 'string' && !room.roster.includes(message.agentId)) {
					await this.host.invite(room, message.agentId);
					this.schedule(view);
				}
				break;
			}
			case 'fixRun': {
				const entry = typeof message.agentId === 'string' ? (await this.host.registry.inviteList([])).find(e => e.agent.id === message.agentId) : undefined;
				const action = typeof message.index === 'number' ? entry?.readiness.actions?.[message.index] : undefined;
				if (action) {
					await action.run();
				}
				this.schedule(view);
				break;
			}
			case 'attachRef':
				if (message.ref === 'file' || message.ref === 'diff' || message.ref === 'terminal') {
					await this.attach(view, message.ref);
				}
				break;
			case 'choose': {
				const room = view.roomId ? await this.host.open(view.roomId) : undefined;
				if (room && typeof message.agentId === 'string' && room.roster.includes(message.agentId)) {
					await this.host.setChoice(room, message.agentId, { ...(typeof message.model === 'string' ? { model: message.model } : {}), ...(typeof message.effort === 'string' ? { effort: message.effort } : {}) });
					this.schedule(view);
				}
				break;
			}
			case 'mode': {
				const room = view.roomId ? await this.host.open(view.roomId) : undefined;
				if (room && (message.mode === 'plan' || message.mode === 'auto')) {
					await this.host.setMode(room, message.mode === 'plan' ? 'plan' : undefined);
					this.schedule(view);
				}
				break;
			}
			case 'attachFile':
				if (typeof message.id === 'string' && typeof message.data === 'string') {
					await this.keepFile(view, message.id, typeof message.name === 'string' ? message.name : '', typeof message.mime === 'string' ? message.mime : '', message.data);
				}
				break;
			case 'detach':
				if (typeof message.path === 'string' && view.saved.delete(message.path)) {
					await fs.unlink(message.path).catch(() => undefined);
				}
				break;
			case 'tooBig':
				void vscode.window.showWarningMessage(vscode.l10n.t('{0} is larger than 25 MB; attach it with + instead.', typeof message.name === 'string' ? message.name : ''));
				break;
			case 'dropUris':
				if (Array.isArray(message.uris)) {
					this.insertUris(view, message.uris.filter((u): u is string => typeof u === 'string'));
				}
				break;
			case 'copyText':
				if (typeof message.text === 'string') {
					await vscode.env.clipboard.writeText(message.text);
				}
				break;
			case 'ready':
				view.scroll = true;
				this.schedule(view, 0);
				if (view.insert) {
					void view.panel.webview.postMessage({ type: 'insert', text: view.insert });
					view.insert = undefined;
				}
				if (view.openMenu) {
					void view.panel.webview.postMessage({ type: 'openMenu', ...view.openMenu });
					view.openMenu = undefined;
				}
				break;
			case 'send':
				if (typeof message.text === 'string') {
					await this.send(view, message.text);
				}
				break;
			case 'start':
				if (typeof message.text === 'string' && Array.isArray(message.agents)) {
					await this.start(view, message.text, message.agents.filter((a): a is string => typeof a === 'string'));
				}
				break;
			case 'stop':
				view.sending?.cancel();
				if (view.roomId) {
					await this.host.stop(view.roomId);
				}
				break;
			case 'copy':
				if (view.roomId && typeof message.id === 'string') {
					const text = (await this.host.open(view.roomId))?.messages.find(m => m.id === message.id)?.text;
					if (text !== undefined) {
						await vscode.env.clipboard.writeText(text);
					}
				}
				break;
			case 'continueOn': {
				const room = view.roomId ? await this.host.open(view.roomId) : undefined;
				if (room && typeof message.agentId === 'string' && typeof message.to === 'string') {
					await this.host.continueOn?.(room, message.agentId, message.to);
				}
				this.schedule(view);
				break;
			}
			case 'button': {
				const button = typeof message.index === 'number' ? view.buttons[message.index] : undefined;
				if (button) {
					await vscode.commands.executeCommand(button.command, ...(button.arguments ?? []));
				}
				break;
			}
		}
	}

	/** The first message of a new chat: the room is made with the chosen agents, then the page becomes its thread. */
	private async start(view: View, text: string, agentIds: readonly string[]): Promise<void> {
		if (!agentIds.length || !text.trim()) {
			return;
		}
		try {
			const room = await this.host.createRoom(agentIds, titleFrom(parseSlash(text, SLASH_COMMANDS).prompt || text, vscode.l10n.t('Room')), view.project);
			text = await this.moveDrafts(view, room.id, text);
			view.roomId = room.id;
			view.preselect = undefined;
			view.scroll = true;
			this.activate(view);
			this.activeChanged.fire(room.id);
			await this.send(view, text);
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('The thread could not start: {0}', error instanceof Error ? error.message : String(error)));
		}
	}

	/** One message through the chat's own path; its replies arrive as the room's rows. */
	private async send(view: View, text: string): Promise<void> {
		const room = view.roomId ? await this.host.open(view.roomId) : undefined;
		if (!room || view.sending || !text.trim()) {
			return;
		}
		const { command, prompt } = parseSlash(text, SLASH_COMMANDS);
		if (command === 'new') {
			this.openNew(room.state.project ? { project: room.state.project } : {});
			return;
		}
		const cts = new vscode.CancellationTokenSource();
		view.sending = cts;
		view.roundSeen = false;
		view.notice = '';
		view.buttons = [];
		view.scroll = true;
		if (!command) {
			view.pending = { text, after: room.messages.length };
		}
		await this.host.use(room);
		this.schedule(view);
		try {
			await this.host.send(room, command ? { prompt, command } : { prompt: text }, this.stream(view), cts.token);
		} catch (error) {
			view.notice += `\n\n${vscode.l10n.t('Could not send: {0}', error instanceof Error ? error.message : String(error))}`;
		} finally {
			if (view.sending === cts) {
				view.sending = undefined;
			}
			view.pending = undefined;
			cts.dispose();
			this.schedule(view);
		}
	}

	/**
	 * The chat path writes to a response stream; here what it writes before any turn starts (a
	 * command's answer, the attached files) is a notice, and the turns themselves are rows.
	 */
	private stream(view: View): vscode.ChatResponseStream {
		const target = {
			markdown: (value: string | vscode.MarkdownString) => {
				if (!view.roundSeen) {
					view.notice += typeof value === 'string' ? value : value.value;
					this.schedule(view);
				}
			},
			button: (command: vscode.Command) => {
				if (!view.roundSeen && command.command !== 'arkestra.rooms.invite') {
					view.buttons.push(command);
					this.schedule(view);
				}
			},
		};
		const noop = () => undefined;
		return new Proxy(target, { get: (t, key) => Reflect.get(t, key) ?? noop }) as unknown as vscode.ChatResponseStream;
	}

	/** A file pasted or dropped into the composer: kept in the room's folder, its path back to the page. */
	private async keepFile(view: View, id: string, name: string, mime: string, data: string): Promise<void> {
		try {
			const bytes = Buffer.from(data, 'base64');
			if (!bytes.length || bytes.length > 25 * 1024 * 1024) {
				throw new Error(vscode.l10n.t('the file is empty or larger than 25 MB'));
			}
			const folder = this.roomFolder(view.roomId);
			await fs.mkdir(folder, { recursive: true });
			const file = path.join(folder, attachmentName(name, mime, candidate => existsSync(path.join(folder, candidate))));
			await fs.writeFile(file, bytes, { flag: 'wx' });
			view.saved.add(file);
			this.post(view, { type: 'attached', id, path: file, name: path.basename(file), url: view.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString() });
		} catch (error) {
			this.post(view, { type: 'attached', id });
			void vscode.window.showErrorMessage(vscode.l10n.t('The file could not be attached: {0}', error instanceof Error ? error.message : String(error)));
		}
	}

	/** A new chat's files go into its room's own folder once the room exists; the message names them there. */
	private async moveDrafts(view: View, roomId: string, text: string): Promise<string> {
		const drafts = this.roomFolder(undefined);
		const folder = this.roomFolder(roomId);
		for (const file of [...view.saved]) {
			if (path.dirname(file) !== drafts || !text.includes(file)) {
				continue;
			}
			try {
				await fs.mkdir(folder, { recursive: true });
				const target = path.join(folder, attachmentName(path.basename(file), '', candidate => existsSync(path.join(folder, candidate))));
				await fs.rename(file, target);
				view.saved.delete(file);
				text = text.split(fileReference(file)).join(fileReference(target));
			} catch {
				// It stays where it is; the reference still points at it.
			}
		}
		return text;
	}

	/** Files dragged in from the explorer or the editor tabs: @file references in the composer. */
	private insertUris(view: View, uris: readonly string[]): void {
		const refs: string[] = [];
		for (const value of uris.slice(0, 50)) {
			let uri: vscode.Uri;
			try {
				uri = vscode.Uri.parse(value, true);
			} catch {
				continue;
			}
			if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
				continue;
			}
			const inWorkspace = !!vscode.workspace.getWorkspaceFolder(uri);
			refs.push(fileReference(inWorkspace ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath));
		}
		if (refs.length) {
			void view.panel.webview.postMessage({ type: 'insert', text: refs.join(' ') });
		}
	}

	/** The + popover's choice: a file (the system's file dialog), the working tree's diff or the last terminal command as an @-reference. */
	private async attach(view: View, ref: 'file' | 'diff' | 'terminal'): Promise<void> {
		let text = `@${ref}`;
		if (ref === 'file') {
			const files = await vscode.window.showOpenDialog({ canSelectMany: true, ...(vscode.workspace.workspaceFolders?.[0] ? { defaultUri: vscode.workspace.workspaceFolders[0].uri } : {}) });
			if (!files?.length) {
				return;
			}
			text = files.map(f => {
				const rel = vscode.workspace.asRelativePath(f, false);
				return `@file:${/\s/.test(rel) ? `"${rel}"` : rel}`;
			}).join(' ');
		}
		void view.panel.webview.postMessage({ type: 'insert', text });
	}
}

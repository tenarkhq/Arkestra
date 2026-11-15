/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Machines page (the left bar's Machines): this machine and every SSH machine
 *  with its status, and under each the Claude Code and Codex sessions on it. Each machine is
 *  read when it is shown; a session opened here is continued, not copied (AR39).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { homedir, hostname, userInfo } from 'node:os';
import type { ExistingSession } from './agent';
import { machinesHtml, type MachinesMessage, type MachinesStrings } from './machinesHtml';
import { LOCAL, machineOf, machinesModel, readMachineEntries, sessionKey, type ConnectionEntry, type Listing, type ProbeLike } from './machinesModel';
import type { MachineSessions } from './sidebarView';
import { FONT_ROOT, pageFonts } from './webviewFonts';

export const MACHINES_VIEW_TYPE = 'arkestra.machines';
/** How often the machines are checked again while the page is visible. */
const RECHECK_MS = 30_000;

/** What the page lists, fed by the extension through the left bar's source. */
export interface MachinesSource {
	machineSessions(): readonly MachineSessions[];
	/** Clears the cached session lists. */
	refreshSessions(): void;
	/** By `<agentId>\n<sessionId>`: the room of the thread a session was continued in. */
	continuedSessions(): Promise<ReadonlyMap<string, string>>;
	/** Threads changed (a session continued here shows its thread then). */
	readonly onDidChange: vscode.Event<void>;
}

export class MachinesPage implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	/** By agent id, for the current page. */
	private readonly listings = new Map<string, Listing>();
	/** The sessions shown, by key, for the click. */
	private readonly shown = new Map<string, { agentId: string; session: ExistingSession }>();
	/** By machine id: the Connections extension's last check and whether one runs. */
	private readonly connections = new Map<string, ConnectionEntry>();
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Raised by Refresh: an answer of an older read is dropped. */
	private generation = 0;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly source: MachinesSource) {
		this.disposables.push(
			vscode.commands.registerCommand('arkestra.machines.open', () => this.show()),
			vscode.window.registerWebviewPanelSerializer(MACHINES_VIEW_TYPE, { deserializeWebviewPanel: async panel => this.adopt(panel) }),
			source.onDidChange(() => void this.post()),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('arkestra.connections.machines')) { this.checkAll(); void this.post(); } }),
		);
	}

	dispose(): void {
		clearInterval(this.timer);
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	show(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		this.adopt(vscode.window.createWebviewPanel(MACHINES_VIEW_TYPE, vscode.l10n.t('Machines'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [FONT_ROOT] }));
	}

	private adopt(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		this.listings.clear();
		panel.iconPath = new vscode.ThemeIcon('vm');
		panel.webview.options = { enableScripts: true, localResourceRoots: [FONT_ROOT] };
		panel.webview.html = machinesHtml(randomBytes(16).toString('base64'), strings(), pageFonts(panel.webview));
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
				clearInterval(this.timer);
				this.timer = undefined;
			}
		});
		panel.webview.onDidReceiveMessage((m: MachinesMessage) => this.receive(m));
		// Checked on open and every half minute while it shows; a check never overlaps its last one.
		clearInterval(this.timer);
		this.timer = setInterval(() => { if (this.panel?.visible) { this.checkAll(); } }, RECHECK_MS);
		panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) { this.checkAll(); } });
	}

	/** Checks every SSH machine (this machine is always connected). */
	private checkAll(): void {
		if (!this.panel) {
			return;
		}
		for (const m of readMachineEntries(vscode.workspace.getConfiguration('arkestra.connections').get('machines'))) {
			void this.check(m.id);
		}
	}

	/** The Connections extension's own check of one machine (its SSH probe); `forget` shows Connecting… meanwhile. */
	private async check(machineId: string, forget = false): Promise<void> {
		const last = this.connections.get(machineId);
		if (machineId === LOCAL || last?.checking) {
			return;
		}
		this.connections.set(machineId, { checking: true, ...(last?.result && !forget ? { result: last.result } : {}) });
		await this.post();
		let result: ProbeLike | 'unknown';
		try {
			await vscode.extensions.getExtension('vscode.arkestra-connections')?.activate();
			const probe = await vscode.commands.executeCommand<ProbeLike | undefined>('arkestra.connections.check', machineId);
			result = probe ? { reachable: !!probe.reachable, ...(probe.error ? { error: String(probe.error) } : {}), ...(probe.home ? { home: String(probe.home) } : {}) } : 'unknown';
		} catch {
			result = 'unknown'; // no Connections extension: the sessions are read anyway and say what failed
		}
		this.connections.set(machineId, { checking: false, result, at: Date.now() });
		await this.post();
	}

	private async receive(m: MachinesMessage): Promise<void> {
		switch (m?.type) {
			case 'ready':
				this.checkAll();
				return this.post();
			case 'load':
				return typeof m.machine === 'string' ? this.load(m.machine) : undefined;
			case 'refresh':
				this.source.refreshSessions();
				this.listings.clear();
				this.generation++;
				this.checkAll();
				return this.post(true);
			case 'reconnect':
				if (typeof m.machine === 'string') {
					for (const agent of this.source.machineSessions().filter(a => machineOf(a.id) === m.machine)) {
						this.listings.delete(agent.id);
					}
					await this.check(m.machine, true);
				}
				return;
			case 'connections':
				await vscode.commands.executeCommand('arkestra.connections.show');
				return;
			case 'openFolder':
				if (typeof m.machine === 'string') {
					await vscode.extensions.getExtension('vscode.arkestra-connections')?.activate();
					await vscode.commands.executeCommand('arkestra.connections.openFolder', m.machine);
				}
				return;
			case 'saveConnection': {
				// The page's own form (a new connection, or an edit in the machine's card); a changed connection is checked again through the setting's change event.
				if (typeof m.machine !== 'string' || m.machine === LOCAL) {
					return;
				}
				let problem: { field?: string; message: string } | undefined;
				try {
					await vscode.extensions.getExtension('vscode.arkestra-connections')?.activate();
					problem = await vscode.commands.executeCommand<{ field?: string; message: string } | undefined>('arkestra.connections.save', {
						...(m.machine ? { id: m.machine } : {}), host: String(m.host ?? ''), name: String(m.name ?? ''), folder: String(m.folder ?? ''),
					});
				} catch (error) {
					problem = { message: error instanceof Error ? error.message : String(error) };
				}
				void this.panel?.webview.postMessage({ type: 'saved', machine: m.machine, ...(problem ? { error: problem.message, field: problem.field ?? '' } : {}) });
				return;
			}
			case 'hosts': {
				const hosts = await Promise.resolve(vscode.commands.executeCommand<string[]>('arkestra.connections.sshHosts')).catch(() => []);
				void this.panel?.webview.postMessage({ type: 'hosts', hosts: Array.isArray(hosts) ? hosts : [] });
				return;
			}
			case 'browse': {
				if (typeof m.machine !== 'string' || m.machine === LOCAL) {
					return;
				}
				await vscode.extensions.getExtension('vscode.arkestra-connections')?.activate();
				const listed = await Promise.resolve(vscode.commands.executeCommand<{ dir: string; parent?: string; folders: string[]; error?: string } | undefined>('arkestra.connections.listFolders', m.machine, typeof m.dir === 'string' ? m.dir : ''))
					.catch(error => ({ dir: typeof m.dir === 'string' ? m.dir : '', folders: [] as string[], error: error instanceof Error ? error.message : String(error) }));
				void this.panel?.webview.postMessage({ type: 'folders', machine: m.machine, ...(listed ?? { dir: '', folders: [], error: vscode.l10n.t('This connection no longer exists.') }) });
				return;
			}
			case 'terminalAt':
				if (typeof m.machine === 'string' && m.machine !== LOCAL && typeof m.dir === 'string' && m.dir) {
					await vscode.commands.executeCommand('arkestra.connections.openTerminal', m.machine, m.dir);
				}
				return;
			case 'remove':
				// The page asked already (its inline confirm), so no second dialog.
				if (typeof m.machine === 'string' && m.machine !== LOCAL) {
					await vscode.commands.executeCommand('arkestra.connections.remove', m.machine);
					this.connections.delete(m.machine);
				}
				return;
			case 'open': {
				const picked = typeof m.key === 'string' ? this.shown.get(m.key) : undefined;
				if (picked) {
					await vscode.commands.executeCommand('arkestra.rooms.continueSession', picked.agentId, picked.session);
				}
				return;
			}
		}
	}

	/** Reads the sessions of every agent on one machine, each on its own; errors stay on the page. */
	private async load(machineId: string): Promise<void> {
		const generation = this.generation;
		const agents = this.source.machineSessions().filter(a => machineOf(a.id) === machineId && this.listings.get(a.id)?.state !== 'loading');
		for (const agent of agents) {
			this.listings.set(agent.id, { state: 'loading' });
		}
		await this.post();
		await Promise.all(agents.map(async agent => {
			let listing: Listing;
			try {
				listing = { state: 'ok', sessions: await agent.sessions() };
			} catch (error) {
				listing = { state: 'error', message: error instanceof Error ? error.message : String(error) };
			}
			if (generation === this.generation) {
				this.listings.set(agent.id, listing);
				await this.post();
			}
		}));
	}

	private async post(reset = false): Promise<void> {
		const panel = this.panel;
		if (!panel) {
			return;
		}
		const continued = await this.source.continuedSessions().catch(() => new Map<string, string>());
		// From here on synchronous: each message carries the state of the moment it is sent.
		const agents = this.source.machineSessions();
		this.shown.clear();
		for (const agent of agents) {
			const listing = this.listings.get(agent.id);
			if (listing?.state === 'ok') {
				for (const session of listing.sessions) {
					this.shown.set(sessionKey(agent.id, session.id), { agentId: agent.id, session });
				}
			}
		}
		const model = machinesModel({
			machines: readMachineEntries(vscode.workspace.getConfiguration('arkestra.connections').get('machines')),
			agents,
			listings: this.listings,
			continued,
			connections: this.connections,
			labels: { thisMachine: vscode.l10n.t('This machine'), local: localAddress() },
			localFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir(),
			now: Date.now(),
			language: vscode.env.language,
		});
		await panel.webview.postMessage({ type: 'model', model, ...(reset ? { reset: true } : {}) });
	}
}

/** user@host of this machine. */
function localAddress(): string {
	try {
		return `${userInfo().username}@${hostname()}`;
	} catch {
		return hostname();
	}
}

function strings(): MachinesStrings {
	return {
		title: vscode.l10n.t('Machines'),
		subtitle: vscode.l10n.t('The Claude Code and Codex sessions on this machine and over SSH. Open one and it continues here; it is not a copy.'),
		search: vscode.l10n.t('Search sessions by title or folder'),
		refresh: vscode.l10n.t('Refresh'),
		connections: vscode.l10n.t('Connections'),
		agent: vscode.l10n.t('Agent'),
		machine: vscode.l10n.t('Machine'),
		all: vscode.l10n.t('All'),
		claude: 'Claude',
		codex: 'Codex',
		openThread: vscode.l10n.t('open thread'),
		continueHere: vscode.l10n.t('continue here'),
		loading: vscode.l10n.t('Reading the sessions…'),
		noSessions: vscode.l10n.t('No sessions on this machine.'),
		noAgent: vscode.l10n.t('No agent on this machine can list its sessions yet.'),
		noMatch: vscode.l10n.t('Nothing matches the filters.'),
		couldNotRead: vscode.l10n.t('{0}: could not read the sessions: {1}'),
		connected: vscode.l10n.t('Connected'),
		connecting: vscode.l10n.t('Connecting…'),
		unreachable: vscode.l10n.t('Unreachable'),
		connectionError: vscode.l10n.t('Error'),
		unknown: vscode.l10n.t('Not checked'),
		localTip: vscode.l10n.t('This machine: always connected'),
		reconnect: vscode.l10n.t('Reconnect'),
		unreachableNote: vscode.l10n.t('Not connected. Its sessions are read once it answers.'),
		connectingNote: vscode.l10n.t('Connecting…'),
		checked: vscode.l10n.t('checked {0}'),
		folder: vscode.l10n.t('Default folder'),
		openFolder: vscode.l10n.t('Open a folder'),
		edit: vscode.l10n.t('Edit connection'),
		remove: vscode.l10n.t('Remove'),
		removeAsk: vscode.l10n.t('Remove the connection {0}? Its agents leave the invite list; its threads stay.'),
		removeYes: vscode.l10n.t('Yes, remove'),
		cancel: vscode.l10n.t('Cancel'),
		addConnection: vscode.l10n.t('New SSH connection'),
		host: vscode.l10n.t('SSH destination'),
		hostHint: vscode.l10n.t('An alias from ~/.ssh/config or user@host, a port after a colon if needed.'),
		name: vscode.l10n.t('Name'),
		nameHint: vscode.l10n.t('Shown next to its agents. Empty: the host\'s name.'),
		folderField: vscode.l10n.t('Project folder on the machine'),
		folderHint: vscode.l10n.t('Empty: the home folder.'),
		save: vscode.l10n.t('Save'),
		folderUp: vscode.l10n.t('One folder up'),
		terminalHere: vscode.l10n.t('Open a terminal here'),
		readingFolders: vscode.l10n.t('Reading the folders…'),
		noFolders: vscode.l10n.t('No folders here.'),
		couldNotReadFolder: vscode.l10n.t('The folder could not be read: {0}'),
	};
}

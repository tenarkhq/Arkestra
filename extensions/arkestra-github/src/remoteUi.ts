/*---------------------------------------------------------------------------------------------
 *  Arkestra. Remote Control in the IDE (AR36): on for every thread or for chosen ones, the
 *  pairing link for the phone, the relay it goes through; all on its own page (the Boards
 *  page's button, the status bar item, the palette's commands). Off when the IDE closes: the
 *  relay then shows the phones that the machine is offline.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { RemoteHost, newPairing, pairingLink, type Pairing, type RemoteRooms, type RemoteState } from './remote';
import { remotePage, remoteThreads, statusLine, type RemoteModel, type RemoteStrings } from './remotePage';
import { qrPath } from './qr';

const STATE = 'arkestra.remote';
const PAIRING = 'arkestra.remote.pairing';
const VIEW = 'arkestra.remote';
const FONT_ROOT = vscode.Uri.file(path.join(__dirname, '..', 'media', 'fonts'));

interface Saved {
	readonly on: boolean;
	readonly all: boolean;
	readonly threads: readonly string[];
}

type RoomsApi = RemoteRooms & { readonly onDidChangeThread: vscode.Event<string> };

/** The relay Remote Control goes through: read it, and save what the page's fields hold (the token kept when left empty). */
export interface RelayAccess {
	get(): Promise<{ url: string; token: string } | undefined>;
	url(): string;
	hasToken(): Promise<boolean>;
	/** What is wrong with the address or the token, or undefined when saved. */
	save(url: string, token: string): Promise<string | undefined>;
	clear(): Promise<void>;
}

export class RemoteControl implements vscode.Disposable {
	private host: RemoteHost | undefined;
	private readonly item = vscode.window.createStatusBarItem('arkestra.remote', vscode.StatusBarAlignment.Right, 97);
	private readonly disposables: vscode.Disposable[] = [this.item];
	private state: RemoteState = { kind: 'off' };
	private rooms: RoomsApi | undefined;
	private panel: vscode.WebviewPanel | undefined;
	/** A line under the page's status until the next change (the link was copied, the relay is needed). */
	private note: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly relay: RelayAccess, private readonly log: vscode.LogOutputChannel) {
		this.item.name = vscode.l10n.t('Remote Control');
		this.item.command = 'arkestra.remote.menu';
		this.disposables.push(
			// The palette's commands do what the page's buttons do and show the page.
			vscode.commands.registerCommand('arkestra.remote.start', async () => { this.show(); await this.start(); }),
			vscode.commands.registerCommand('arkestra.remote.stop', () => this.stop()),
			vscode.commands.registerCommand('arkestra.remote.pair', () => { this.show(); void this.panel?.webview.postMessage({ type: 'askNewLink' }); }),
			vscode.commands.registerCommand('arkestra.remote.copyLink', () => this.copyLink()),
			vscode.commands.registerCommand('arkestra.remote.toggleAll', () => this.save({ all: !this.saved.all })),
			vscode.commands.registerCommand('arkestra.remote.menu', () => this.show()),
			// The thread's own switch in the right panel (as the Claude app's Remote Control switch): this thread on the phone.
			vscode.commands.registerCommand('arkestra.remote.threadState', (id: unknown) => typeof id === 'string' ? { on: this.saved.on && this.allowed(id) } : undefined),
			vscode.commands.registerCommand('arkestra.remote.setThread', (id: unknown, on: unknown) => typeof id === 'string' ? this.setThread(id, on === true) : undefined),
			vscode.window.registerWebviewPanelSerializer(VIEW, { deserializeWebviewPanel: async panel => this.adopt(panel) }),
		);
		if (this.saved.on) {
			void this.start(); // it was on when the IDE closed
		}
		this.paint();
	}

	dispose(): void {
		this.host?.stop();
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	/** The page; `focusRelay`: its relay fields first (the palette's Connect to the relay). */
	show(focusRelay = false): void {
		if (this.panel) {
			this.panel.reveal();
		} else {
			this.adopt(vscode.window.createWebviewPanel(VIEW, vscode.l10n.t('Remote Control'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [FONT_ROOT] }));
		}
		if (focusRelay) {
			void this.panel?.webview.postMessage({ type: 'focusRelay' });
		}
	}

	private adopt(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		panel.iconPath = new vscode.ThemeIcon('radio-tower');
		panel.webview.options = { enableScripts: true, localResourceRoots: [FONT_ROOT] };
		panel.webview.html = remotePage(randomBytes(16).toString('base64'), panel.webview.cspSource, strings(), panel.webview.asWebviewUri(FONT_ROOT).toString());
		panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; } });
		panel.webview.onDidReceiveMessage(m => void this.receive(m));
	}

	private async receive(m: { type?: string; url?: unknown; token?: unknown; all?: unknown; id?: unknown; on?: unknown }): Promise<void> {
		switch (m?.type) {
			case 'ready': return this.render();
			case 'start': return this.start();
			case 'stop': return this.stop();
			case 'copy': return this.copyLink();
			case 'newLink': return this.repair();
			case 'scope': return this.save({ all: m.all === true });
			case 'thread':
				if (typeof m.id === 'string') {
					const s = this.saved;
					await this.save({ threads: m.on === true ? [...new Set([...s.threads, m.id])] : s.threads.filter(t => t !== m.id) });
				}
				return;
			case 'saveRelay': {
				const error = await this.relay.save(typeof m.url === 'string' ? m.url : '', typeof m.token === 'string' ? m.token : '');
				void this.panel?.webview.postMessage({ type: 'relaySaved', ...(error ? { error } : {}) });
				if (!error) {
					this.note = undefined;
					if (this.saved.on) {
						await this.start();
					}
				}
				return this.render();
			}
			case 'disconnect':
				await this.relay.clear();
				return this.render();
		}
	}

	/** Sends the page what it shows now. */
	private async render(): Promise<void> {
		const panel = this.panel;
		if (!panel) {
			return;
		}
		const s = this.saved;
		const rooms = await this.roomsApi();
		const list = rooms ? await rooms.threads().catch(() => []) : [];
		const relay = s.on ? await this.relay.get() : undefined;
		const model: RemoteModel = {
			relayUrl: this.relay.url(), hasToken: await this.relay.hasToken(), on: s.on, state: this.state, all: s.all,
			threads: remoteThreads(list, s.threads), ...(this.note ? { note: this.note } : {}),
			...(relay ? { qr: qrPath(pairingLink(relay.url, await this.pairing())) } : {}),
		};
		void panel.webview.postMessage({ type: 'model', model: { ...model, status: statusLine(model, strings()) } });
	}

	private get saved(): Saved {
		return this.context.globalState.get<Saved>(STATE) ?? { on: false, all: true, threads: [] };
	}

	private async save(change: Partial<Saved>): Promise<void> {
		await this.context.globalState.update(STATE, { ...this.saved, ...change });
		this.host?.allowedChanged();
		this.paint();
	}

	private allowed = (id: string): boolean => this.saved.all || this.saved.threads.includes(id);

	/** One thread on or off for the phone: on starts Remote Control if it was off; off with every thread shared keeps the others shared. */
	private async setThread(id: string, on: boolean): Promise<void> {
		const s = this.saved;
		if (on) {
			if (!s.all && !s.threads.includes(id)) {
				await this.save({ threads: [...s.threads, id] });
			}
			if (!s.on) {
				await this.start(); // without the relay it shows the page's relay fields
			}
			return;
		}
		if (s.all) {
			const rooms = await this.roomsApi();
			const others = rooms ? (await rooms.threads().catch(() => [])).map(t => t.id).filter(t => t !== id) : [];
			await this.save({ all: false, threads: others });
		} else {
			await this.save({ threads: s.threads.filter(t => t !== id) });
		}
	}

	private async pairing(fresh = false): Promise<Pairing> {
		const stored = fresh ? undefined : await this.context.secrets.get(PAIRING);
		if (stored) {
			try {
				return JSON.parse(stored) as Pairing;
			} catch {
				// a new pairing below
			}
		}
		const p = newPairing();
		await this.context.secrets.store(PAIRING, JSON.stringify(p));
		return p;
	}

	private async roomsApi(): Promise<RoomsApi | undefined> {
		if (!this.rooms) {
			const api = await vscode.extensions.getExtension<RoomsApi>('vscode.arkestra-rooms')?.activate();
			if (typeof api?.thread === 'function' && typeof api.say === 'function') { // an older rooms extension has neither
				this.rooms = api;
				this.disposables.push(api.onDidChangeThread(id => this.host?.changed(id)));
			}
		}
		return this.rooms;
	}

	/** Turns it on; without a relay the page says so above its relay fields. */
	private async start(): Promise<void> {
		const relay = await this.relay.get();
		if (!relay) {
			this.note = vscode.l10n.t('Remote Control goes through the GitHub relay on the edge server. Connect to it below first.');
			this.show(true);
			return this.render();
		}
		const rooms = await this.roomsApi();
		if (!rooms) {
			this.note = vscode.l10n.t('Remote Control needs the Arkestra rooms extension.');
			return this.render();
		}
		this.host?.stop();
		// The first time there is no phone yet: the page opens with the QR code to scan.
		const first = !await this.context.secrets.get(PAIRING);
		const pairing = await this.pairing();
		if (first) {
			this.show();
		}
		this.host = new RemoteHost({
			relayUrl: relay.url, token: relay.token, pairing, rooms, allowed: this.allowed,
			onState: s => {
				this.state = s;
				if (s.kind === 'error') {
					this.log.warn(`remote: ${s.message}`);
				}
				this.paint();
			},
			onCommand: (c, ok) => this.log.info(`phone → here ${c.t}${'id' in c ? ` ${c.id}` : ''}${ok ? '' : ' (refused)'}`),
		});
		this.host.start();
		this.note = undefined;
		await this.save({ on: true });
	}

	private async stop(): Promise<void> {
		this.host?.stop();
		this.host = undefined;
		this.state = { kind: 'off' };
		this.note = undefined;
		await this.save({ on: false });
	}

	private async copyLink(): Promise<void> {
		const relay = await this.relay.get();
		if (relay) {
			await vscode.env.clipboard.writeText(pairingLink(relay.url, await this.pairing()));
			this.note = vscode.l10n.t('The pairing link is on the clipboard. Open it on your phone, then add the page to the home screen.');
			void this.render();
		}
	}

	/** A new channel and key (the page confirmed it): the old link stops working at once. */
	private async repair(): Promise<void> {
		await this.pairing(true);
		if (this.saved.on) {
			await this.start();
		}
		await this.copyLink();
	}

	private paint(): void {
		void this.render();
		const s = this.saved;
		if (!s.on) {
			this.item.hide();
			return;
		}
		const scope = s.all ? vscode.l10n.t('every thread') : vscode.l10n.t('{0} threads', s.threads.length);
		switch (this.state.kind) {
			case 'on':
				this.item.text = `$(radio-tower) ${this.state.phones ? vscode.l10n.t('Remote · {0} phone(s)', this.state.phones) : vscode.l10n.t('Remote')}`;
				this.item.tooltip = vscode.l10n.t('Remote Control is on for {0}. {1} phone(s) connected.', scope, this.state.phones);
				this.item.backgroundColor = undefined;
				break;
			case 'error':
				this.item.text = `$(radio-tower) $(warning)`;
				this.item.tooltip = vscode.l10n.t('Remote Control: {0} · retrying', this.state.message);
				this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				break;
			default:
				this.item.text = `$(sync~spin) ${vscode.l10n.t('Remote')}`;
				this.item.tooltip = vscode.l10n.t('Remote Control is connecting…');
		}
		this.item.show();
	}
}

function strings(): RemoteStrings {
	return {
		title: vscode.l10n.t('Remote Control'),
		lead: vscode.l10n.t('Your threads on your phone: read them, write to them, stop a turn. Off when Arkestra closes.'),
		relay: vscode.l10n.t('GitHub relay'),
		relayLead: vscode.l10n.t('The relay on the edge server: live board updates and Remote Control go through it.'),
		relayUrl: vscode.l10n.t('The relay\'s address on the edge server'),
		relayToken: vscode.l10n.t('This client\'s token from the relay\'s clients file'),
		tokenKept: vscode.l10n.t('Saved; leave empty to keep it'),
		tokenHint: vscode.l10n.t('Kept in the system\'s secret storage, never in a file or a log.'),
		save: vscode.l10n.t('Save'),
		disconnect: vscode.l10n.t('Disconnect'),
		notConnected: vscode.l10n.t('Not connected to a relay.'),
		connectedTo: vscode.l10n.t('Connected to {0}'),
		phone: vscode.l10n.t('Phone'),
		off: vscode.l10n.t('Off'),
		connecting: vscode.l10n.t('Connecting…'),
		on: vscode.l10n.t('On · {0} phone(s) connected'),
		error: vscode.l10n.t('{0} · retrying'),
		turnOn: vscode.l10n.t('Turn Remote Control on'),
		turnOff: vscode.l10n.t('Turn it off'),
		copyLink: vscode.l10n.t('Copy the pairing link'),
		newLink: vscode.l10n.t('New pairing link'),
		newLinkAsk: vscode.l10n.t('Make a new pairing link? Phones with the old link lose access.'),
		newLinkYes: vscode.l10n.t('Yes, new link'),
		cancel: vscode.l10n.t('Cancel'),
		scan: vscode.l10n.t('Scan it with your phone\'s camera: your threads open on the phone. Add the page to the home screen to keep it.'),
		linkNote: vscode.l10n.t('Open the pairing link on your phone (send it to yourself, then add the page to the home screen). The link holds the key: whoever has it can read and write the threads shown.'),
		threads: vscode.l10n.t('Which threads the phone sees'),
		every: vscode.l10n.t('Every thread'),
		chosen: vscode.l10n.t('Only the ones ticked ({0})'),
		noThreads: vscode.l10n.t('No threads yet.'),
	};
}

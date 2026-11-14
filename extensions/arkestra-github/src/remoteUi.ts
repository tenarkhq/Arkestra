/*---------------------------------------------------------------------------------------------
 *  Arkestra. Remote Control in the IDE (AR36): on for every thread or for chosen ones, the
 *  pairing link for the phone, the status bar. Off when the IDE closes: the relay then shows
 *  the phones that the machine is offline.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RemoteHost, newPairing, pairingLink, type Pairing, type RemoteRooms, type RemoteState } from './remote';

const STATE = 'arkestra.remote';
const PAIRING = 'arkestra.remote.pairing';

interface Saved {
	readonly on: boolean;
	readonly all: boolean;
	readonly threads: readonly string[];
}

type RoomsApi = RemoteRooms & { readonly onDidChangeThread: vscode.Event<string> };

export class RemoteControl implements vscode.Disposable {
	private host: RemoteHost | undefined;
	private readonly item = vscode.window.createStatusBarItem('arkestra.remote', vscode.StatusBarAlignment.Right, 97);
	private readonly disposables: vscode.Disposable[] = [this.item];
	private state: RemoteState = { kind: 'off' };
	private rooms: RoomsApi | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly relay: () => Promise<{ url: string; token: string } | undefined>, private readonly log: vscode.LogOutputChannel) {
		this.item.name = vscode.l10n.t('Remote Control');
		this.item.command = 'arkestra.remote.menu';
		this.disposables.push(
			vscode.commands.registerCommand('arkestra.remote.start', () => this.start(true)),
			vscode.commands.registerCommand('arkestra.remote.stop', () => this.stop()),
			vscode.commands.registerCommand('arkestra.remote.pair', () => this.repair()),
			vscode.commands.registerCommand('arkestra.remote.copyLink', () => this.copyLink()),
			vscode.commands.registerCommand('arkestra.remote.toggleAll', () => this.toggleAll()),
			vscode.commands.registerCommand('arkestra.remote.toggleThread', (arg?: unknown) => this.toggleThread(arg)),
			vscode.commands.registerCommand('arkestra.remote.menu', () => this.menu()),
		);
		if (this.saved.on) {
			void this.start(false); // it was on when the IDE closed
		}
		this.paint();
	}

	dispose(): void {
		this.host?.stop();
		for (const d of this.disposables) {
			d.dispose();
		}
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

	private async start(showLink: boolean): Promise<void> {
		const relay = await this.relay();
		if (!relay) {
			const connect = vscode.l10n.t('Connect to the relay');
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Remote Control goes through the GitHub relay on the edge server. Connect to it first.'), connect) === connect) {
				await vscode.commands.executeCommand('arkestra.github.connect');
			}
			return;
		}
		const rooms = await this.roomsApi();
		if (!rooms) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Remote Control needs the Arkestra rooms extension.'));
			return;
		}
		this.host?.stop();
		const pairing = await this.pairing();
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
		await this.save({ on: true });
		if (showLink) {
			await this.showLink(relay.url, pairing);
		}
	}

	private async stop(): Promise<void> {
		this.host?.stop();
		this.host = undefined;
		await this.save({ on: false });
	}

	private async showLink(url: string, pairing: Pairing): Promise<void> {
		const link = pairingLink(url, pairing);
		const copy = vscode.l10n.t('Copy the link');
		const answer = await vscode.window.showInformationMessage(
			vscode.l10n.t('Remote Control is on. Open the pairing link on your phone (send it to yourself, then add the page to the home screen). The link holds the key: whoever has it can read and write the threads shown.'),
			{ modal: true }, copy);
		if (answer === copy) {
			await vscode.env.clipboard.writeText(link);
			void vscode.window.setStatusBarMessage(vscode.l10n.t('Pairing link copied'), 4000);
		}
	}

	private async copyLink(): Promise<void> {
		const relay = await this.relay();
		if (relay) {
			await vscode.env.clipboard.writeText(pairingLink(relay.url, await this.pairing()));
			void vscode.window.setStatusBarMessage(vscode.l10n.t('Pairing link copied'), 4000);
		}
	}

	/** A new channel and key: the old link stops working at once. */
	private async repair(): Promise<void> {
		const yes = vscode.l10n.t('New link');
		if (await vscode.window.showWarningMessage(vscode.l10n.t('Make a new pairing link? Phones with the old link lose access.'), { modal: true }, yes) !== yes) {
			return;
		}
		await this.pairing(true);
		if (this.saved.on) {
			await this.start(true);
		}
	}

	private async toggleAll(): Promise<void> {
		await this.save({ all: !this.saved.all });
		void vscode.window.setStatusBarMessage(this.saved.all ? vscode.l10n.t('Remote Control: every thread') : vscode.l10n.t('Remote Control: only the threads switched on'), 4000);
	}

	private async toggleThread(arg: unknown): Promise<void> {
		const id = typeof arg === 'string' ? arg : (arg as { thread?: { id: string } } | undefined)?.thread?.id;
		if (!id) {
			return;
		}
		const s = this.saved;
		const on = s.threads.includes(id);
		await this.save({ threads: on ? s.threads.filter(t => t !== id) : [...s.threads, id] });
		if (s.all) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Remote Control shows every thread now. Switch to “only chosen threads” for this choice to count.'));
		}
		if (!s.on && !on) {
			await this.start(true);
		}
	}

	private async menu(): Promise<void> {
		const s = this.saved;
		type Item = vscode.QuickPickItem & { run: () => Thenable<unknown> | Promise<unknown> };
		const items: Item[] = s.on
			? [
				{ label: `$(copy) ${vscode.l10n.t('Copy the pairing link')}`, run: () => this.copyLink() },
				{ label: s.all ? `$(list-filter) ${vscode.l10n.t('Show only chosen threads')}` : `$(list-flat) ${vscode.l10n.t('Show every thread')}`, description: s.all ? '' : vscode.l10n.t('{0} chosen', s.threads.length), run: () => this.toggleAll() },
				{ label: `$(key) ${vscode.l10n.t('New pairing link')}`, description: vscode.l10n.t('the old one stops working'), run: () => this.repair() },
				{ label: `$(debug-stop) ${vscode.l10n.t('Turn Remote Control off')}`, run: () => this.stop() },
			]
			: [{ label: `$(radio-tower) ${vscode.l10n.t('Turn Remote Control on')}`, run: () => this.start(true) }];
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Remote Control') });
		await pick?.run();
	}

	private paint(): void {
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

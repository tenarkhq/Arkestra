/*---------------------------------------------------------------------------------------------
 *  Arkestra. GitHub through the Arkestra GitHub App (AR28): the app's webhooks reach the IDE
 *  through the relay on the edge server. The status bar shows whether the connection is live
 *  and when the last event came; the log lists the events; other parts (the project board,
 *  the live sync) listen through the API.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RelayClient, describe, type RelayEvent, type RelayState } from './relayClient';

const TOKEN = 'arkestra.github.relayToken';

export interface ArkestraGitHubApi {
	readonly onEvent: vscode.Event<RelayEvent>;
	readonly onState: vscode.Event<RelayState>;
	state(): RelayState;
	/** When the last event arrived (ms), if any. */
	lastEventAt(): number | undefined;
}

export function activate(context: vscode.ExtensionContext): ArkestraGitHubApi {
	const events = new vscode.EventEmitter<RelayEvent>();
	const states = new vscode.EventEmitter<RelayState>();
	const log = vscode.window.createOutputChannel(vscode.l10n.t('Arkestra GitHub'), { log: true });
	const item = vscode.window.createStatusBarItem('arkestra.github', vscode.StatusBarAlignment.Right, 98);
	item.name = vscode.l10n.t('GitHub relay');
	item.command = 'arkestra.github.log';
	let state: RelayState = { kind: 'off' };
	let lastEventAt: number | undefined;
	let client: RelayClient | undefined;

	const ago = (ms: number) => {
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		return s < 60 ? vscode.l10n.t('{0} s', s) : s < 3600 ? vscode.l10n.t('{0} min', Math.round(s / 60)) : vscode.l10n.t('{0} h', Math.round(s / 3600));
	};
	const paint = () => {
		switch (state.kind) {
			case 'off':
				item.hide();
				return;
			case 'connecting':
				item.text = `$(sync~spin) GitHub`;
				item.tooltip = vscode.l10n.t('Connecting to the GitHub relay…');
				break;
			case 'live':
				item.text = lastEventAt ? `$(github) ${vscode.l10n.t('live · {0}', ago(lastEventAt))}` : `$(github) ${vscode.l10n.t('live')}`;
				item.tooltip = lastEventAt ? vscode.l10n.t('GitHub webhook connection is live · last event {0} ago', ago(lastEventAt)) : vscode.l10n.t('GitHub webhook connection is live · no event yet');
				break;
			case 'error':
				item.text = `$(github) $(warning)`;
				item.tooltip = vscode.l10n.t('GitHub relay: {0} · retrying in {1}', state.message, ago(2 * Date.now() - state.retryAt));
				break;
		}
		item.show();
	};
	const ticker = setInterval(() => { if (state.kind === 'live') { paint(); } }, 5000);

	const restart = async () => {
		client?.stop();
		client = undefined;
		const url = vscode.workspace.getConfiguration('arkestra.github').get<string>('relayUrl')?.trim();
		const token = await context.secrets.get(TOKEN);
		if (!url || !token) {
			state = { kind: 'off' };
			paint();
			return;
		}
		client = new RelayClient({
			url, token,
			onEvent: e => {
				lastEventAt = Date.now();
				log.info(`GitHub → ${describe(e)}`);
				events.fire(e);
				paint();
			},
			onState: s => {
				state = s;
				if (s.kind === 'error') {
					log.warn(`relay: ${s.message}`);
				} else if (s.kind === 'live') {
					log.info('relay: connected');
				}
				states.fire(s);
				paint();
			},
		});
		client.start();
	};

	context.subscriptions.push(
		events, states, log, item, { dispose: () => { clearInterval(ticker); client?.stop(); } },
		vscode.commands.registerCommand('arkestra.github.connect', async () => {
			const config = vscode.workspace.getConfiguration('arkestra.github');
			const url = (await vscode.window.showInputBox({ title: vscode.l10n.t('GitHub relay'), prompt: vscode.l10n.t('The relay\'s address on the edge server'), value: config.get<string>('relayUrl') ?? '', placeHolder: 'https://edge.example.com/arkestra', ignoreFocusOut: true }))?.trim();
			if (!url) {
				return;
			}
			const token = (await vscode.window.showInputBox({ title: vscode.l10n.t('GitHub relay'), prompt: vscode.l10n.t('This client\'s token from the relay\'s clients file'), password: true, ignoreFocusOut: true }))?.trim();
			if (!token) {
				return;
			}
			await context.secrets.store(TOKEN, token);
			await config.update('relayUrl', url, vscode.ConfigurationTarget.Global);
			await restart();
		}),
		vscode.commands.registerCommand('arkestra.github.disconnect', async () => {
			await context.secrets.delete(TOKEN);
			await restart();
		}),
		vscode.commands.registerCommand('arkestra.github.install', async () => {
			const slug = vscode.workspace.getConfiguration('arkestra.github').get<string>('appSlug')?.trim();
			if (!slug) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Set the Arkestra GitHub App\'s slug first (arkestra.github.appSlug).'));
				return;
			}
			await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`));
		}),
		vscode.commands.registerCommand('arkestra.github.log', () => log.show()),
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('arkestra.github.relayUrl')) { void restart(); } }),
		context.secrets.onDidChange(e => { if (e.key === TOKEN) { void restart(); } }),
	);
	void restart();

	return { onEvent: events.event, onState: states.event, state: () => state, lastEventAt: () => lastEventAt };
}

export function deactivate(): void { }

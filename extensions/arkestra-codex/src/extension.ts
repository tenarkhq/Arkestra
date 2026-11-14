/*---------------------------------------------------------------------------------------------
 *  Arkestra. Registers Codex (Codex CLI app-server) with the rooms.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodexAgent, type CodexOptions } from './codexAgent';
import type { ArkestraConnectionsApi } from './connections';
import type { ArkestraRoomsApi } from './rooms';

const KEY = 'arkestra.codex.apiKey';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const rooms = vscode.extensions.getExtension<ArkestraRoomsApi>('vscode.arkestra-rooms');
	if (!rooms) {
		return;
	}
	const api = await rooms.activate();
	const config = () => vscode.workspace.getConfiguration('arkestra.codex');

	const base: CodexOptions = {
		get command() { return config().get<string>('command') || 'codex'; },
		get model() { return config().get<string>('model') || undefined; },
		get sandbox() { return config().get<CodexOptions['sandbox']>('sandbox') || 'workspace-write'; },
		cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		auth: async () => {
			const auth = config().get<string>('auth') || 'auto';
			if (auth === 'subscription') {
				return { mode: 'subscription' };
			}
			const key = await context.secrets.get(KEY);
			return auth === 'apiKey' || key ? { mode: 'apiKey', key } : { mode: 'subscription' };
		},
		apiKeyHome: path.join(context.globalStorageUri.fsPath, 'codex-home'),
	};
	const agent = new CodexAgent(base);

	// One more Codex per SSH machine, running that machine's Codex CLI.
	const connections = await vscode.extensions.getExtension<ArkestraConnectionsApi>('vscode.arkestra-connections')?.activate();
	let remote: vscode.Disposable[] = [];
	const syncRemote = () => {
		remote.forEach(d => d.dispose());
		remote = (connections?.machines() ?? []).flatMap(machine => {
			const spawn = connections?.spawnFor(machine.id);
			if (!spawn) {
				return [];
			}
			const options: CodexOptions = Object.create(base, {
				spawn: { value: spawn },
				// The thread's folder is the machine's project folder (the SSH side cds there).
				cwd: { value: () => undefined },
				apiKeyHome: { value: '~/.arkestra/codex-home' },
				identity: { value: { id: `codex@${machine.id}`, name: `Codex · ${machine.name}`, where: machine.name } },
			});
			const remoteAgent = new CodexAgent(options);
			return [api.registerAgent(remoteAgent), { dispose: () => remoteAgent.dispose() }];
		});
	};
	syncRemote();
	if (connections) {
		context.subscriptions.push(connections.onDidChangeMachines(syncRemote), { dispose: () => remote.forEach(d => d.dispose()) });
	}

	context.subscriptions.push(
		api.registerAgent(agent),
		{ dispose: () => agent.dispose() },
		vscode.commands.registerCommand('arkestra.codex.setApiKey', async () => {
			const key = await vscode.window.showInputBox({ prompt: vscode.l10n.t('OpenAI API key for Codex'), password: true, ignoreFocusOut: true });
			if (key) {
				await context.secrets.store(KEY, key.trim());
			}
		}),
		vscode.commands.registerCommand('arkestra.codex.clearApiKey', () => context.secrets.delete(KEY)),
	);
}

export function deactivate(): void { }

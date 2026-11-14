/*---------------------------------------------------------------------------------------------
 *  Arkestra. Registers Codex (Codex CLI app-server) with the rooms.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodexAgent, type CodexOptions } from './codexAgent';
import type { ArkestraRoomsApi } from './rooms';

const KEY = 'arkestra.codex.apiKey';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const rooms = vscode.extensions.getExtension<ArkestraRoomsApi>('vscode.arkestra-rooms');
	if (!rooms) {
		return;
	}
	const api = await rooms.activate();
	const config = () => vscode.workspace.getConfiguration('arkestra.codex');

	const agent = new CodexAgent({
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
	});

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

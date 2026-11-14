/*---------------------------------------------------------------------------------------------
 *  Arkestra. Registers Claude (Claude Code CLI) with the rooms.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ClaudeCodeAgent } from './claudeCode';
import type { ArkestraRoomsApi } from './rooms';

const KEY = 'arkestra.claude.apiKey';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const rooms = vscode.extensions.getExtension<ArkestraRoomsApi>('vscode.arkestra-rooms');
	if (!rooms) {
		return;
	}
	const api = await rooms.activate();
	const config = () => vscode.workspace.getConfiguration('arkestra.claude');

	const agent = new ClaudeCodeAgent({
		get command() { return config().get<string>('command') || 'claude'; },
		get model() { return config().get<string>('model') || undefined; },
		get permissionMode() { return config().get<string>('permissionMode') || 'acceptEdits'; },
		cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		apiKey: async () => {
			const auth = config().get<string>('auth') || 'auto';
			if (auth === 'subscription') {
				return undefined;
			}
			return context.secrets.get(KEY);
		},
	});

	context.subscriptions.push(
		api.registerAgent(agent),
		vscode.commands.registerCommand('arkestra.claude.setApiKey', async () => {
			const key = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Anthropic API key for Claude'), password: true, ignoreFocusOut: true });
			if (key) {
				await context.secrets.store(KEY, key.trim());
			}
		}),
		vscode.commands.registerCommand('arkestra.claude.clearApiKey', () => context.secrets.delete(KEY)),
	);
}

export function deactivate(): void { }

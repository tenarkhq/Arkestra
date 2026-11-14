/*---------------------------------------------------------------------------------------------
 *  Arkestra. Registers GPT (OpenAI API, own key) with the rooms.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OpenAIAgent, type OpenAIOptions } from './openaiAgent';
import type { ArkestraRoomsApi } from './rooms';

const KEY = 'arkestra.openai.apiKey';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const rooms = vscode.extensions.getExtension<ArkestraRoomsApi>('vscode.arkestra-rooms');
	if (!rooms) {
		return;
	}
	const api = await rooms.activate();
	const config = () => vscode.workspace.getConfiguration('arkestra.openai');

	const agent = new OpenAIAgent({
		get model() { return config().get<string>('model') || 'gpt-6-astra'; },
		get baseUrl() { return config().get<string>('baseUrl') || 'https://api.openai.com/v1'; },
		get reasoningEffort() {
			const effort = config().get<string>('reasoningEffort');
			return effort && effort !== 'default' ? effort as OpenAIOptions['reasoningEffort'] : undefined;
		},
		apiKey: () => Promise.resolve(context.secrets.get(KEY)),
	});

	context.subscriptions.push(
		api.registerAgent(agent),
		vscode.commands.registerCommand('arkestra.openai.setApiKey', async () => {
			const key = await vscode.window.showInputBox({ prompt: vscode.l10n.t('OpenAI API key for GPT'), password: true, ignoreFocusOut: true });
			if (key) {
				await context.secrets.store(KEY, key.trim());
			}
		}),
		vscode.commands.registerCommand('arkestra.openai.clearApiKey', () => context.secrets.delete(KEY)),
	);
}

export function deactivate(): void { }

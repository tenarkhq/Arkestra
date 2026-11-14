/*---------------------------------------------------------------------------------------------
 *  Arkestra. Registers GPT (OpenAI API, own key) with the rooms.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OpenAIAgent, type OpenAIOptions } from './openaiAgent';
import type { Agent, ArkestraRoomsApi, Readiness } from './rooms';

const KEY = 'arkestra.openai.apiKey';

type Action = { readonly title: string; run(): Thenable<unknown> };

/** The agent with what fixes an unmet condition attached to its readiness. */
function withActions<T extends Agent>(agent: T, actionsFor: (readiness: Readiness) => Action[]): Agent {
	return {
		get id() { return agent.id; },
		get name() { return agent.name; },
		get detail() { return agent.detail; },
		readiness: async () => {
			const readiness = await agent.readiness();
			return readiness.ready ? readiness : { ...readiness, actions: actionsFor(readiness) };
		},
		turn: (input, onEvent, signal) => agent.turn(input, onEvent, signal),
	};
}


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
		api.registerAgent(withActions(agent, (readiness): Action[] => {
			switch (readiness.fix) {
				case 'signIn':
					return [{ title: vscode.l10n.t('Set API key'), run: () => vscode.commands.executeCommand('arkestra.openai.setApiKey') }];
				case 'quota':
					return [{ title: vscode.l10n.t('Usage and billing'), run: () => vscode.env.openExternal(vscode.Uri.parse('https://platform.openai.com/usage')) }];
				case 'retry':
					return [{ title: vscode.l10n.t('Change model'), run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'arkestra.openai.model') }];
				default:
					return [];
			}
		})),
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

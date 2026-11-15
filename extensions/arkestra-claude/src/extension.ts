/*---------------------------------------------------------------------------------------------
 *  Arkestra. Registers Claude (Claude Code CLI) with the rooms.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ClaudeCodeAgent, type ClaudeCodeOptions } from './claudeCode';
import type { ArkestraConnectionsApi } from './connections';
import type { Agent, ArkestraRoomsApi, Readiness } from './rooms';

const KEY = 'arkestra.claude.apiKey';
const INSTALL_GUIDE = 'https://docs.claude.com/en/docs/claude-code/setup';

type Action = { readonly title: string; run(): Thenable<unknown>; readonly secret?: { readonly label: string; readonly placeholder?: string; save(value: string): Thenable<unknown> } };

/** The readiness reasons of the Claude agent in the interface language; other text (CLI errors) as it came. */
function localizeReason(reason: string | undefined): string | undefined {
	switch (reason) {
		case 'Claude Code CLI not found': return vscode.l10n.t('Claude Code CLI not found');
		case 'Claude Code is not signed in': return vscode.l10n.t('Claude Code is not signed in');
		default: return reason;
	}
}

/** The agent with what fixes an unmet condition attached to its readiness. */
function withActions<T extends Agent>(agent: T, actionsFor: (readiness: Readiness) => Action[]): Agent {
	return {
		get id() { return agent.id; },
		get name() { return agent.name; },
		get detail() { return agent.detail; },
		readiness: async () => {
			const readiness = await agent.readiness();
			return readiness.ready ? readiness : { ...readiness, reason: localizeReason(readiness.reason), actions: actionsFor(readiness) };
		},
		turn: (input, onEvent, signal) => agent.turn(input, onEvent, signal),
		...(agent.choices ? { choices: () => agent.choices!() } : {}),
		...(agent.existingSessions ? { existingSessions: () => agent.existingSessions!() } : {}),
		...(agent.cloud ? { cloud: agent.cloud } : {}),
		...(agent.sessionHistory ? { sessionHistory: (id: string) => agent.sessionHistory!(id) } : {}),
		...(agent.historyVersion !== undefined ? { historyVersion: agent.historyVersion } : {}),
		...(agent.adoptSession ? { adoptSession: (roomId: string, session: { readonly id: string; readonly cwd?: string }, seen: readonly string[]) => agent.adoptSession!(roomId, session, seen) } : {}),
		...(agent.quota ? { quota: () => agent.quota!() } : {}),
		...(agent.watchStates ? { watchStates: (onState: Parameters<NonNullable<Agent['watchStates']>>[0]) => agent.watchStates!(onState) } : {}),
		...(agent.watchSession ? { watchSession: (id: string, onEntries: Parameters<NonNullable<Agent['watchSession']>>[1], cursor?: string) => agent.watchSession!(id, onEntries, cursor) } : {}),
	};
}


export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const rooms = vscode.extensions.getExtension<ArkestraRoomsApi>('vscode.arkestra-rooms');
	if (!rooms) {
		return;
	}
	const api = await rooms.activate();
	const config = () => vscode.workspace.getConfiguration('arkestra.claude');

	const base: ClaudeCodeOptions = {
		get command() { return config().get<string>('command') || 'claude'; },
		get model() { return config().get<string>('model') || undefined; },
		get permissionMode() { return config().get<string>('permissionMode') || 'acceptEdits'; },
		cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		permissionRules: () => api.permissions?.rules('local') ?? { allow: [], deny: [] },
		apiKey: async () => {
			const auth = config().get<string>('auth') || 'auto';
			if (auth === 'subscription') {
				return undefined;
			}
			return context.secrets.get(KEY);
		},
	};
	const agent = new ClaudeCodeAgent(base);
	const actions = (machineId: string) => (readiness: Readiness): Action[] => {
		switch (readiness.fix) {
			case 'install':
				return [{ title: vscode.l10n.t('Installation guide'), run: () => vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE)) }];
			case 'signIn':
				return [
					{ title: vscode.l10n.t('Sign in'), run: () => vscode.commands.executeCommand('arkestra.connections.runInTerminal', machineId, base.command, ['auth', 'login'], vscode.l10n.t('Claude sign-in')) },
					// The page asks for the key in its own password field; the palette's command asks at the top.
					{ title: vscode.l10n.t('Use an API key'), run: () => vscode.commands.executeCommand('arkestra.claude.setApiKey'), secret: { label: vscode.l10n.t('Anthropic API key for Claude'), placeholder: 'sk-ant-…', save: key => context.secrets.store(KEY, key.trim()) } },
				];
			default:
				return [];
		}
	};

	// One more Claude per SSH machine, running that machine's Claude Code CLI.
	const connections = await vscode.extensions.getExtension<ArkestraConnectionsApi>('vscode.arkestra-connections')?.activate();
	let remote: vscode.Disposable[] = [];
	const syncRemote = () => {
		remote.forEach(d => d.dispose());
		remote = (connections?.machines() ?? []).flatMap(machine => {
			const spawn = connections?.spawnFor(machine.id);
			if (!spawn) {
				return [];
			}
			const options: ClaudeCodeOptions = Object.create(base, {
				spawn: { value: spawn },
				cwd: { value: () => undefined },
				identity: { value: { id: `claude@${machine.id}`, name: `Claude · ${machine.name}`, where: machine.name } },
				permissionRules: { value: () => api.permissions?.rules(machine.id) ?? { allow: [], deny: [] } },
				// The machine's own Claude Code login, unless an API key is asked for outright.
				apiKey: { value: async () => config().get<string>('auth') === 'apiKey' ? context.secrets.get(KEY) : undefined },
			});
			return [api.registerAgent(withActions(new ClaudeCodeAgent(options), actions(machine.id)))];
		});
	};
	syncRemote();
	if (connections) {
		context.subscriptions.push(connections.onDidChangeMachines(syncRemote), { dispose: () => remote.forEach(d => d.dispose()) });
	}

	context.subscriptions.push(
		api.registerAgent(withActions(agent, actions('local'))),
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

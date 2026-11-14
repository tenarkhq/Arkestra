/*---------------------------------------------------------------------------------------------
 *  Arkestra. Registers Codex (Codex CLI app-server) with the rooms.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodexAgent, type CodexOptions } from './codexAgent';
import type { ArkestraConnectionsApi } from './connections';
import type { Agent, ArkestraRoomsApi, Readiness } from './rooms';

const KEY = 'arkestra.codex.apiKey';
const INSTALL_GUIDE = 'https://developers.openai.com/codex/cli';

type Action = { readonly title: string; run(): Thenable<unknown> };

/** The readiness reasons of the Codex agent in the interface language; other text (CLI errors) as it came. */
function localizeReason(reason: string | undefined): string | undefined {
	switch (reason) {
		case 'Codex CLI not found': return vscode.l10n.t('Codex CLI not found');
		case 'No Codex API key stored': return vscode.l10n.t('No Codex API key stored');
		case 'Codex is not signed in': return vscode.l10n.t('Codex is not signed in');
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
		...(agent.sessionHistory ? { sessionHistory: (id: string) => agent.sessionHistory!(id) } : {}),
		...(agent.adoptSession ? { adoptSession: (roomId: string, session: { readonly id: string; readonly cwd?: string }, seen: readonly string[]) => agent.adoptSession!(roomId, session, seen) } : {}),
	};
}


export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const rooms = vscode.extensions.getExtension<ArkestraRoomsApi>('vscode.arkestra-rooms');
	if (!rooms) {
		return;
	}
	const api = await rooms.activate();
	const config = () => vscode.workspace.getConfiguration('arkestra.codex');
	// The permission lists of the machine Codex runs on, joined with the project's (AR22).
	const permissionsFor = (machine: string, name: string): CodexOptions['permissions'] => {
		const permissions = api.permissions;
		return permissions && {
			active: () => { const r = permissions.rules(machine); return r.allow.length + r.deny.length > 0; },
			ask: (request, signal) => permissions.ask(name, machine, request, signal),
		};
	};

	const base: CodexOptions = {
		get command() { return config().get<string>('command') || 'codex'; },
		get model() { return config().get<string>('model') || undefined; },
		get sandbox() { return config().get<CodexOptions['sandbox']>('sandbox') || 'workspace-write'; },
		cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		permissions: permissionsFor('local', 'Codex'),
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
	const actions = (machineId: string) => (readiness: Readiness): Action[] => {
		switch (readiness.fix) {
			case 'install':
				return [{ title: vscode.l10n.t('Installation guide'), run: () => vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE)) }];
			case 'signIn':
				return [
					// A device code works on this machine and over SSH alike.
					{ title: vscode.l10n.t('Sign in'), run: () => vscode.commands.executeCommand('arkestra.connections.runInTerminal', machineId, base.command, machineId === 'local' ? ['login'] : ['login', '--device-auth'], vscode.l10n.t('Codex sign-in')) },
					{ title: vscode.l10n.t('Use an API key'), run: () => vscode.commands.executeCommand('arkestra.codex.setApiKey') },
				];
			default:
				return [];
		}
	};

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
				permissions: { value: permissionsFor(machine.id, `Codex · ${machine.name}`) },
				// The machine's own Codex login, unless an API key is asked for outright.
				auth: { value: async () => config().get<string>('auth') === 'apiKey' ? { mode: 'apiKey', key: await context.secrets.get(KEY) } : { mode: 'subscription' } },
			});
			const remoteAgent = new CodexAgent(options);
			return [api.registerAgent(withActions(remoteAgent, actions(machine.id))), { dispose: () => remoteAgent.dispose() }];
		});
	};
	syncRemote();
	if (connections) {
		context.subscriptions.push(connections.onDidChangeMachines(syncRemote), { dispose: () => remote.forEach(d => d.dispose()) });
	}

	context.subscriptions.push(
		api.registerAgent(withActions(agent, actions('local'))),
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

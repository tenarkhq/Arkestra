/*---------------------------------------------------------------------------------------------
 *  Arkestra. Registers the ACP agents of the `arkestra.acp.agents` setting with the rooms,
 *  on this machine or on an SSH machine, and adds new ones from the ACP Registry.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { AcpAgent, type AcpOptions, type PermissionOption } from './acpAgent';
import { addFormEntry, addFormSpec, type AddFormStrings } from './addForm';
import { readAgents, registryId, type AcpAgentConfig } from './config';
import type { ArkestraConnectionsApi } from './connections';
import { remoteFiles, type SpawnFn } from './host';
import { REGISTRY_URL, readRegistry, type RegistryAgent } from './registry';
import type { Agent, AgentEvent, ArkestraRoomsApi, Readiness } from './rooms';

const AGENTS_LIST = 'https://agentclientprotocol.com/get-started/agents';

/** Fixed English texts of the ACP adapter in the interface language; other text as it came. */
function localize(text: string | undefined): string | undefined {
	if (!text) {
		return text;
	}
	let m: RegExpExecArray | null;
	if ((m = /^(.+) not found$/.exec(text))) {
		return vscode.l10n.t('{0} not found', m[1]);
	}
	if ((m = /^(.+) is not signed in$/.exec(text))) {
		return vscode.l10n.t('{0} is not signed in', m[1]);
	}
	if ((m = /^(.+) refused this request$/.exec(text))) {
		return vscode.l10n.t('{0} refused this request', m[1]);
	}
	if ((m = /^(.+) stopped: max tokens$/.exec(text))) {
		return vscode.l10n.t('{0} stopped: it reached its token limit', m[1]);
	}
	if ((m = /^(.+) stopped: max turn requests$/.exec(text))) {
		return vscode.l10n.t('{0} stopped: it reached its request limit for one turn', m[1]);
	}
	if ((m = /^(.+) · failed$/.exec(text))) {
		return vscode.l10n.t('{0} · failed', m[1]);
	}
	return text;
}

/** Asks for a tool permission without blocking the window; dismissing or a stopped turn declines. */
async function askPermission(agentName: string, title: string, options: readonly PermissionOption[], signal: AbortSignal): Promise<string | undefined> {
	if (!options.length) {
		return undefined;
	}
	// Allow first, reject last, as the buttons read left to right.
	const order = { allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 };
	const sorted = [...options].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
	const stopped = new Promise<undefined>(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
	const pick = await Promise.race([vscode.window.showInformationMessage(vscode.l10n.t('{0} asks for permission: {1}', agentName, title), ...sorted.map(o => o.name)), stopped]);
	return sorted.find(o => o.name === pick)?.optionId;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const rooms = vscode.extensions.getExtension<ArkestraRoomsApi>('vscode.arkestra-rooms');
	if (!rooms) {
		return;
	}
	const api = await rooms.activate();
	const connections = await vscode.extensions.getExtension<ArkestraConnectionsApi>('vscode.arkestra-connections')?.activate();
	const config = () => vscode.workspace.getConfiguration('arkestra.acp');

	// The folder sessions work in: the workspace here, the machine's folder over SSH.
	const remoteCwd = new Map<string, Promise<string>>();
	const cwdFor = (machine: string, spawn: SpawnFn | undefined) => async (): Promise<string> => {
		if (!spawn) {
			return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
		}
		let cwd = remoteCwd.get(machine);
		if (!cwd) {
			cwd = new Promise<string>((resolve, reject) => {
				const child = spawn('pwd', [], { stdio: ['ignore', 'pipe', 'pipe'] });
				let out = '';
				child.stdout?.setEncoding('utf8');
				child.stdout?.on('data', (c: string) => { out += c; });
				child.on('error', reject);
				child.on('close', code => code === 0 && out.trim().startsWith('/') ? resolve(out.trim()) : reject(new Error(vscode.l10n.t('Cannot reach the machine'))));
			});
			cwd.catch(() => remoteCwd.delete(machine));
			remoteCwd.set(machine, cwd);
		}
		return cwd;
	};

	const machineName = (id: string) => id === 'local' ? vscode.l10n.t('local') : connections?.machines().find(m => m.id === id)?.name ?? id;

	const wrap = (agent: AcpAgent, entry: AcpAgentConfig): Agent => ({
		get id() { return agent.id; },
		get name() { return agent.name; },
		get detail() { return `ACP · ${machineName(entry.machine)}`; },
		readiness: async (): Promise<Readiness> => {
			const readiness = await agent.readiness();
			if (readiness.ready) {
				return readiness;
			}
			const editSettings = { title: vscode.l10n.t('Edit ACP agents'), run: () => vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'arkestra.acp.agents' } }) };
			const actions = readiness.fix === 'install'
				? [{ title: vscode.l10n.t('ACP agents'), run: () => vscode.env.openExternal(vscode.Uri.parse(AGENTS_LIST)) }, editSettings]
				: readiness.fix === 'signIn'
					? [
						...agent.signInMethods.map(m => ({ title: m.name, run: () => agent.authenticate(m.id).then(undefined, e => vscode.window.showErrorMessage(String(e instanceof Error ? e.message : e))) })),
						editSettings,
					]
					: [editSettings];
			return { ...readiness, reason: localize(readiness.reason), actions };
		},
		turn: (input, onEvent, signal) => agent.turn(input, (event: AgentEvent) => onEvent(event.kind === 'tool' || event.kind === 'error' ? { ...event, text: localize(event.text) ?? event.text } : event), signal)
			.catch(e => { throw e instanceof Error ? new Error(localize(e.message)) : e; }),
	});

	// The permission lists of the agent's machine and the project (AR22): they answer first, the user after.
	const permissionsFor = (machine: string): Pick<AcpOptions, 'askPermission' | 'refuses'> => {
		const permissions = api.permissions;
		if (!permissions) {
			return { askPermission };
		}
		return {
			askPermission: async (agentName, _title, options, signal, toolCall) => {
				const decision = await permissions.ask(agentName, machine, permissions.requestFromAcp(toolCall), signal);
				const kinds = decision === 'allow' ? ['allow_once', 'allow_always'] : decision === 'deny' ? ['reject_once', 'reject_always'] : [];
				return kinds.map(k => options.find(o => o.kind === k)).find(Boolean)?.optionId;
			},
			refuses: request => permissions.decide(machine, request) === 'deny',
		};
	};

	let registered: { agent: AcpAgent; registration: { dispose(): void } }[] = [];
	const sync = () => {
		for (const r of registered) {
			r.registration.dispose();
			r.agent.dispose();
		}
		registered = [];
		const machines = new Set(connections?.machines().map(m => m.id) ?? []);
		for (const entry of readAgents(config().get('agents'))) {
			const spawn = entry.machine === 'local' ? undefined : connections?.spawnFor(entry.machine);
			if (entry.machine !== 'local' && (!machines.has(entry.machine) || !spawn)) {
				continue; // a machine that is gone takes its agents with it
			}
			const agent = new AcpAgent({
				id: registryId(entry),
				name: entry.name,
				command: entry.command,
				args: entry.args,
				env: entry.env,
				where: machineName(entry.machine),
				cwd: cwdFor(entry.machine, spawn),
				...(spawn ? { spawn, remote: true, files: remoteFiles(spawn) } : {}),
				...permissionsFor(entry.machine),
			});
			try {
				registered.push({ agent, registration: api.registerAgent(wrap(agent, entry)) });
			} catch {
				agent.dispose(); // an id another adapter already uses
			}
		}
	};
	sync();

	// A new agent comes from a form in Arkestra's own page (the new-chat page's "Another agent"
	// card, the thread's invite list); this extension gives the form and saves what came back.
	const formStrings = (): AddFormStrings => ({
		title: vscode.l10n.t('Add another agent (ACP)'),
		intro: vscode.l10n.t('From the ACP Registry, or a command of your own.'),
		noRegistry: vscode.l10n.t('The ACP Registry could not be read; a command of your own still works.'),
		source: vscode.l10n.t('Agent'),
		custom: vscode.l10n.t('A command of my own'),
		needs: vscode.l10n.t('needs {0} installed'),
		command: vscode.l10n.t('Command that starts the agent in ACP mode'),
		commandHint: vscode.l10n.t('For example: gemini --acp'),
		name: vscode.l10n.t('Name shown in the rooms'),
		nameHint: vscode.l10n.t('Empty: the agent\'s own name.'),
		machine: vscode.l10n.t('Where it runs'),
		thisMachine: vscode.l10n.t('This machine'),
		add: vscode.l10n.t('Add the agent'),
		cancel: vscode.l10n.t('Cancel'),
		commandRequired: vscode.l10n.t('Type the command that starts it.'),
		unknownMachine: vscode.l10n.t('This machine is no longer connected.'),
		unknownAgent: vscode.l10n.t('Pick an agent from the list.'),
	});
	/** The ACP Registry, read once per form; empty when it cannot be read. */
	let registryList: { agents: RegistryAgent[]; read: boolean } | undefined;
	const readRegistryList = async () => {
		try {
			const res = await fetch(REGISTRY_URL);
			registryList = { agents: readRegistry(await res.json()), read: true };
		} catch {
			registryList = { agents: [], read: false };
		}
		return registryList;
	};
	const addForm = async () => {
		const list = await readRegistryList();
		return addFormSpec(list.agents, (connections?.machines() ?? []).map(m => ({ id: m.id, name: m.name })), formStrings(), list.read);
	};
	/** Saves the form's agent; the field that is wrong otherwise. Without values (the palette) the new-chat page opens with the form. */
	const addAgent = async (values?: unknown): Promise<{ field?: string; message: string } | undefined> => {
		if (!values || typeof values !== 'object') {
			await vscode.commands.executeCommand('arkestra.rooms.newChat', { menu: 'acp' });
			return undefined;
		}
		const t = formStrings();
		const result = addFormEntry(values as Record<string, unknown>, (registryList ?? await readRegistryList()).agents, connections?.machines() ?? [], config().get('agents'), t);
		if ('field' in result) {
			return result;
		}
		const raw = config().get<unknown[]>('agents') ?? [];
		await config().update('agents', [...raw, result.entry], vscode.ConfigurationTarget.Global);
		const website = result.agent?.needsInstall ? result.agent.website : undefined;
		if (website) {
			const open = vscode.l10n.t('Open its page');
			void Promise.resolve(vscode.window.showInformationMessage(vscode.l10n.t('{0} has to be installed on the machine it runs on.', result.entry.name), open)).then(answer => {
				if (answer === open) {
					void vscode.env.openExternal(vscode.Uri.parse(website));
				}
			});
		}
		return undefined;
	};

	context.subscriptions.push(
		{ dispose: () => registered.forEach(r => { r.registration.dispose(); r.agent.dispose(); }) },
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('arkestra.acp')) { sync(); } }),
		vscode.commands.registerCommand('arkestra.acp.add', addAgent),
		vscode.commands.registerCommand('arkestra.acp.addForm', addForm),
	);
	if (connections) {
		context.subscriptions.push(connections.onDidChangeMachines(() => { remoteCwd.clear(); sync(); }));
	}
}

export function deactivate(): void { }

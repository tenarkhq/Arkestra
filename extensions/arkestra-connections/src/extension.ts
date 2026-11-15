/*---------------------------------------------------------------------------------------------
 *  Arkestra. Connections: where agents run, this machine or others over SSH. Keeps the
 *  machine list, checks each machine's agent CLIs and shows them on the Connections page; the
 *  Machines page (arkestra-rooms) asks it for the checks, edits and removals.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { connectionFromForm, readMachines, sshConfigHosts, type ConnectionInput } from './machines';
import { connectionsPage, pageRows, type PageStrings } from './page';
import { probe, probeLocal, remoteSpawn, sshTerminalArgs, type Machine, type ProbeResult, type SpawnFn } from './ssh';
import { MachineTools } from './machineTools';

/** What the agent adapters receive. */
export interface ArkestraConnectionsApi {
	/** The SSH machines (this machine is not listed). */
	machines(): Machine[];
	readonly onDidChangeMachines: vscode.Event<void>;
	/** A spawn function that runs commands on the machine, or undefined if it is unknown. */
	spawnFor(machineId: string): SpawnFn | undefined;
}

const SETTING = 'arkestra.connections';

export function activate(context: vscode.ExtensionContext): ArkestraConnectionsApi {
	const changed = new vscode.EventEmitter<void>();
	const config = () => vscode.workspace.getConfiguration(SETTING);
	const machines = () => readMachines(config().get('machines'));
	const ssh = () => ({ ssh: config().get<string>('sshCommand') || 'ssh' });
	const status = new Map<string, ProbeResult | 'checking'>();
	let panel: vscode.WebviewPanel | undefined;

	const save = (list: Machine[]) => config().update('machines', list, vscode.ConfigurationTarget.Global);

	/** Checks a machine ('local' or an SSH machine's id); undefined: no such machine. */
	const check = async (id: string): Promise<ProbeResult | undefined> => {
		status.set(id, 'checking');
		void render();
		const machine = machines().find(m => m.id === id);
		const result = id === 'local'
			? (process.platform === 'win32' ? { reachable: true, clis: [] } : await probeLocal())
			: machine ? await probe(machine, ssh()) : undefined;
		if (result) {
			status.set(id, result);
		} else {
			status.delete(id);
		}
		void render();
		return result;
	};

	/** The aliases of ~/.ssh/config, offered while an SSH destination is typed. */
	const sshHosts = () => readFile(path.join(homedir(), '.ssh', 'config'), 'utf8').then(sshConfigHosts, () => [] as string[]);

	/**
	 * Saves a connection from a page's form (the Machines page, the Connections page): a new one
	 * with `id` left out, else that machine with its id kept. Returns the field that is wrong.
	 */
	const saveConnection = async (input: ConnectionInput & { readonly id?: unknown }): Promise<{ field?: string; message: string } | undefined> => {
		const id = typeof input.id === 'string' && input.id ? input.id : undefined;
		const list = machines();
		if (id && !list.some(m => m.id === id)) {
			return { message: vscode.l10n.t('This connection no longer exists.') };
		}
		const result = connectionFromForm(input, list, {
			hostRequired: vscode.l10n.t('Type the SSH destination, for example dev@server.example.com.'),
			hostInvalid: vscode.l10n.t('An SSH destination has no spaces and does not start with a hyphen.'),
			portInvalid: vscode.l10n.t('The port after the colon is a number from 1 to 65535.'),
			nameTaken: vscode.l10n.t('Another connection has this name.'),
		}, id);
		if ('field' in result) {
			return result;
		}
		await save(id ? list.map(m => m.id === id ? result.machine : m) : [...list, result.machine]);
		void check(result.machine.id);
		return undefined;
	};

	/** Removes a connection; its row (or the Machines page) asked first. */
	const remove = async (id: string) => {
		if (machines().some(m => m.id === id)) {
			status.delete(id);
			await save(machines().filter(m => m.id !== id));
		}
	};

	const strings = (): PageStrings => ({
		title: vscode.l10n.t('Connections'),
		lead: vscode.l10n.t('Where agents run: this machine or over SSH. Each machine shows the agent CLIs it has.'),
		machine: vscode.l10n.t('Machine'), access: vscode.l10n.t('Access'), clis: vscode.l10n.t('CLIs'), status: vscode.l10n.t('Status'),
		thisMachine: vscode.l10n.t('This machine'), local: vscode.l10n.t('local'),
		check: vscode.l10n.t('Check'), remove: vscode.l10n.t('Remove'),
		removeAsk: vscode.l10n.t('Remove the connection {0}? Its agents leave the invite list.'), removeYes: vscode.l10n.t('Yes, remove'), cancel: vscode.l10n.t('Cancel'),
		checking: vscode.l10n.t('checking…'), reachable: vscode.l10n.t('reachable'), unreachable: vscode.l10n.t('unreachable'), noCli: vscode.l10n.t('no agent CLI found'),
		add: vscode.l10n.t('New SSH connection'),
		host: vscode.l10n.t('SSH destination'), hostHint: vscode.l10n.t('An alias from ~/.ssh/config or user@host, a port after a colon if needed.'),
		name: vscode.l10n.t('Name'), nameHint: vscode.l10n.t('Shown next to its agents. Empty: the host\'s name.'),
		folder: vscode.l10n.t('Project folder on the machine'), folderHint: vscode.l10n.t('Empty: the home folder.'),
		save: vscode.l10n.t('Save'),
	});

	const render = async () => {
		const target = panel;
		if (target) {
			const t = strings();
			void target.webview.postMessage({ type: 'rows', rows: pageRows(machines(), status, t), hosts: await sshHosts() });
		}
	};

	/** The Connections page; `addForm`: with its New SSH connection form open (the palette's New SSH connection). */
	const show = (addForm = false) => {
		if (panel) {
			panel.reveal();
			if (addForm) {
				void panel.webview.postMessage({ type: 'addOpen' });
			}
			return;
		}
		const created = vscode.window.createWebviewPanel('arkestra.connections', vscode.l10n.t('Connections'), vscode.ViewColumn.Active, { enableScripts: true });
		panel = created;
		created.iconPath = new vscode.ThemeIcon('remote');
		created.onDidDispose(() => { if (panel === created) { panel = undefined; } });
		created.webview.onDidReceiveMessage(async (message: { type: string; id?: string } & ConnectionInput) => {
			if (message.type === 'ready') {
				void render();
				if (addForm) {
					void created.webview.postMessage({ type: 'addOpen' });
				}
			} else if (message.type === 'save') {
				const problem = await saveConnection({ host: message.host, name: message.name, folder: message.folder });
				void created.webview.postMessage({ type: 'saved', ...(problem ? { error: problem.message, field: problem.field ?? '' } : {}) });
			} else if (message.type === 'check' && message.id) {
				void check(message.id);
			} else if (message.type === 'remove' && message.id) {
				void remove(message.id);
			}
		});
		created.webview.html = connectionsPage(randomBytes(16).toString('base64'), strings());
		for (const id of ['local', ...machines().map(m => m.id)]) {
			if (!status.has(id)) {
				void check(id);
			}
		}
	};

	context.subscriptions.push(
		changed,
		// A folder of a machine in a terminal, uploads to it (AR27).
		new MachineTools(machines, ssh),
		vscode.commands.registerCommand('arkestra.connections.show', () => show()),
		// The palette's New SSH connection: the Connections page with its form open.
		vscode.commands.registerCommand('arkestra.connections.add', () => show(true)),
		// The Machines page's buttons and forms, by machine id (the page confirms a removal itself).
		vscode.commands.registerCommand('arkestra.connections.check', (id: unknown) => typeof id === 'string' ? check(id) : undefined),
		vscode.commands.registerCommand('arkestra.connections.save', (input: unknown) => saveConnection(input && typeof input === 'object' ? input as ConnectionInput : {})),
		vscode.commands.registerCommand('arkestra.connections.sshHosts', sshHosts),
		vscode.commands.registerCommand('arkestra.connections.remove', (id: unknown) => typeof id === 'string' ? remove(id) : undefined),
		// For sign-in flows: an interactive terminal running a command on a machine ('local' or an SSH machine).
		vscode.commands.registerCommand('arkestra.connections.runInTerminal', (machineId: string, command: string, args: string[] = [], title?: string) => {
			const machine = machines().find(m => m.id === machineId);
			if (machineId !== 'local' && !machine) {
				return;
			}
			const terminal = machine
				? vscode.window.createTerminal({ name: title ?? `${command} · ${machine.name}`, shellPath: ssh().ssh, shellArgs: sshTerminalArgs(machine, command, args) })
				: vscode.window.createTerminal({ name: title ?? command, shellPath: command, shellArgs: args, cwd: vscode.workspace.workspaceFolders?.[0]?.uri });
			terminal.show();
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${SETTING}.machines`)) {
				changed.fire();
				void render();
			}
		}),
	);

	return {
		machines,
		onDidChangeMachines: changed.event,
		spawnFor: id => {
			const machine = machines().find(m => m.id === id);
			return machine ? remoteSpawn(machine, ssh()) : undefined;
		},
	};
}

export function deactivate(): void { }

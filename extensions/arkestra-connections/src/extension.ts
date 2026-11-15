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
import { newMachineId, readMachines, sshConfigHosts } from './machines';
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
		render();
		const machine = machines().find(m => m.id === id);
		const result = id === 'local'
			? (process.platform === 'win32' ? { reachable: true, clis: [] } : await probeLocal())
			: machine ? await probe(machine, ssh()) : undefined;
		if (result) {
			status.set(id, result);
		} else {
			status.delete(id);
		}
		render();
		return result;
	};

	const add = async () => {
		const configured = await readFile(path.join(homedir(), '.ssh', 'config'), 'utf8').then(sshConfigHosts, () => []);
		const other = vscode.l10n.t('Another host (user@host)…');
		const picked = configured.length
			? await vscode.window.showQuickPick([...configured, other], { title: vscode.l10n.t('New SSH connection'), placeHolder: vscode.l10n.t('Host from ~/.ssh/config') })
			: other;
		if (!picked) {
			return;
		}
		const host = picked === other
			? (await vscode.window.showInputBox({ title: vscode.l10n.t('New SSH connection'), prompt: vscode.l10n.t('SSH destination, for example dev@server.example.com'), ignoreFocusOut: true }))?.trim()
			: picked;
		if (!host) {
			return;
		}
		const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('New SSH connection'), prompt: vscode.l10n.t('Name shown next to its agents'), value: host.replace(/^.*@/, ''), ignoreFocusOut: true }))?.trim();
		if (!name) {
			return;
		}
		const folder = await vscode.window.showInputBox({ title: vscode.l10n.t('New SSH connection'), prompt: vscode.l10n.t('Project folder on the machine (empty: home folder)'), placeHolder: '~/projects/app', ignoreFocusOut: true });
		if (folder === undefined) {
			return;
		}
		const list = machines();
		const machine: Machine = { id: newMachineId(name, list), name, host, ...(folder.trim() ? { folder: folder.trim() } : {}) };
		await save([...list, machine]);
		void check(machine.id);
	};

	/** Removes a connection; `confirmed`: the Machines page asked already (its inline confirm). */
	const remove = async (id: string, confirmed = false) => {
		const machine = machines().find(m => m.id === id);
		if (!machine) {
			return;
		}
		const yes = vscode.l10n.t('Remove');
		const answer = confirmed ? yes : await vscode.window.showWarningMessage(vscode.l10n.t('Remove the connection {0}? Its agents leave the invite list.', machine.name), { modal: true }, yes);
		if (answer === yes) {
			status.delete(id);
			await save(machines().filter(m => m.id !== id));
		}
	};

	/** Edits a connection's name, SSH destination and project folder; the id stays (its threads keep their agents). */
	const edit = async (id: string) => {
		const machine = machines().find(m => m.id === id);
		if (!machine) {
			return;
		}
		const title = vscode.l10n.t('Edit the connection {0}', machine.name);
		const host = (await vscode.window.showInputBox({ title, prompt: vscode.l10n.t('SSH destination, for example dev@server.example.com'), value: machine.host + (machine.port ? `:${machine.port}` : ''), ignoreFocusOut: true }))?.trim();
		if (!host) {
			return;
		}
		const name = (await vscode.window.showInputBox({ title, prompt: vscode.l10n.t('Name shown next to its agents'), value: machine.name, ignoreFocusOut: true }))?.trim();
		if (!name) {
			return;
		}
		const folder = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t('Project folder on the machine (empty: home folder)'), value: machine.folder ?? '', placeHolder: '~/projects/app', ignoreFocusOut: true });
		if (folder === undefined) {
			return;
		}
		const port = /^(.+):(\d+)$/.exec(host);
		const changed: Machine = { id, name, host: port ? port[1] : host, ...(port ? { port: Number(port[2]) } : {}), ...(folder.trim() ? { folder: folder.trim() } : {}) };
		await save(machines().map(m => m.id === id ? changed : m));
		void check(id);
	};

	const render = () => {
		if (panel) {
			panel.webview.html = page(machines(), status);
		}
	};

	const show = () => {
		if (panel) {
			panel.reveal();
			return;
		}
		panel = vscode.window.createWebviewPanel('arkestra.connections', vscode.l10n.t('Connections'), vscode.ViewColumn.Active, { enableScripts: true });
		panel.iconPath = new vscode.ThemeIcon('remote');
		panel.onDidDispose(() => { panel = undefined; });
		panel.webview.onDidReceiveMessage((message: { type: string; id?: string }) => {
			if (message.type === 'add') {
				void add();
			} else if (message.type === 'check' && message.id) {
				void check(message.id);
			} else if (message.type === 'remove' && message.id) {
				void remove(message.id);
			}
		});
		render();
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
		vscode.commands.registerCommand('arkestra.connections.show', show),
		vscode.commands.registerCommand('arkestra.connections.add', add),
		// The Machines page's buttons, by machine id.
		vscode.commands.registerCommand('arkestra.connections.check', (id: unknown) => typeof id === 'string' ? check(id) : undefined),
		vscode.commands.registerCommand('arkestra.connections.edit', (id: unknown) => typeof id === 'string' ? edit(id) : undefined),
		vscode.commands.registerCommand('arkestra.connections.remove', (id: unknown, confirmed?: unknown) => typeof id === 'string' ? remove(id, confirmed === true) : undefined),
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
				render();
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

function escape(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

function page(machines: readonly Machine[], status: ReadonlyMap<string, ProbeResult | 'checking'>): string {
	const nonce = randomBytes(16).toString('base64');
	const state = (id: string) => {
		const s = status.get(id);
		if (s === undefined) {
			return { clis: '', text: '', cls: '' };
		}
		if (s === 'checking') {
			return { clis: '', text: vscode.l10n.t('checking…'), cls: 'mut' };
		}
		return s.reachable
			? { clis: s.clis.map(c => `<span class="cli">${escape(c)}</span>`).join(' ') || `<span class="mut">${escape(vscode.l10n.t('no agent CLI found'))}</span>`, text: vscode.l10n.t('reachable'), cls: 'ok' }
			: { clis: '', text: s.error ?? vscode.l10n.t('unreachable'), cls: 'bad' };
	};
	const row = (id: string, name: string, access: string, removable: boolean) => {
		const s = state(id);
		return `<tr>
			<td><b>${escape(name)}</b></td>
			<td class="mut">${escape(access)}</td>
			<td>${s.clis}</td>
			<td class="${s.cls}">${escape(s.text)}</td>
			<td class="act"><button data-type="check" data-id="${id}">${escape(vscode.l10n.t('Check'))}</button>${removable ? `<button class="sec" data-type="remove" data-id="${id}">${escape(vscode.l10n.t('Remove'))}</button>` : ''}</td>
		</tr>`;
	};
	const access = (m: Machine) => `ssh · ${m.host}${m.port ? ':' + m.port : ''}${m.folder ? ' · ' + m.folder : ''}`;
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px 24px; max-width: 980px; }
	h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 4px; }
	p.lead { color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
	table { width: 100%; border-collapse: collapse; }
	th { text-align: left; font-weight: 600; font-size: .85em; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
	td { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
	.mut { color: var(--vscode-descriptionForeground); }
	.ok { color: var(--vscode-testing-iconPassed); }
	.bad { color: var(--vscode-errorForeground); }
	.cli { font-family: var(--vscode-editor-font-family); font-size: .9em; padding: 1px 7px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.act { text-align: right; white-space: nowrap; }
	button { font: inherit; padding: 4px 12px; margin-left: 6px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	.add { margin: 16px 0 0; margin-left: 0; }
</style></head>
<body>
	<h1>${escape(vscode.l10n.t('Connections'))}</h1>
	<p class="lead">${escape(vscode.l10n.t('Where agents run: this machine or over SSH. Each machine shows the agent CLIs it has.'))}</p>
	<table>
		<thead><tr><th>${escape(vscode.l10n.t('Machine'))}</th><th>${escape(vscode.l10n.t('Access'))}</th><th>${escape(vscode.l10n.t('CLIs'))}</th><th>${escape(vscode.l10n.t('Status'))}</th><th></th></tr></thead>
		<tbody>
			${row('local', vscode.l10n.t('This machine'), vscode.l10n.t('local'), false)}
			${machines.map(m => row(m.id, m.name, access(m), true)).join('')}
		</tbody>
	</table>
	<button class="add" data-type="add">+ ${escape(vscode.l10n.t('New SSH connection'))}</button>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.addEventListener('click', e => {
			const b = e.target.closest('button[data-type]');
			if (b) { vscode.postMessage({ type: b.dataset.type, id: b.dataset.id }); }
		});
	</script>
</body></html>`;
}

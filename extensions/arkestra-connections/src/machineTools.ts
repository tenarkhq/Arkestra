/*---------------------------------------------------------------------------------------------
 *  Arkestra. What the Machines page does on a machine besides its sessions: a folder on it
 *  opened in a terminal, and uploads. Local files and folders dropped into such a terminal are
 *  uploaded into its folder (after asking) and the remote paths are typed instead.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Machine } from './ssh';
import { droppedPaths, joinRemote, listRemote, readRemote, remoteFolder, remoteParent, shellArgs, upload, uploadedPaths } from './transfer';

/** A folder on an SSH machine. */
interface Place {
	readonly machine: Machine;
	readonly path: string;
}

export class MachineTools implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly machines: () => Machine[], private readonly ssh: () => { ssh: string }) {
		this.disposables.push(
			// The Machines page's "Open a folder": this computer through the folder dialog; an SSH machine's folders are walked in the page itself.
			vscode.commands.registerCommand('arkestra.connections.openFolder', (machineId?: string) => this.openFolder(machineId)),
			vscode.commands.registerCommand('arkestra.connections.listFolders', (machineId?: unknown, dir?: unknown) => this.listFolders(machineId, dir)),
			// A text file an agent wrote on an SSH machine, for the Artifacts page.
			vscode.commands.registerCommand('arkestra.connections.readFile', (machineId?: unknown, file?: unknown) => this.readFile(machineId, file)),
			// With a folder: the page's "Open a terminal here"; without: the palette's, in the machine's default folder.
			vscode.commands.registerCommand('arkestra.connections.openTerminal', (machineId?: string, dir?: unknown) => this.openTerminal(machineId, typeof dir === 'string' && dir ? dir : undefined)),
			vscode.commands.registerCommand('arkestra.connections.upload', (machineId?: string) => this.pickAndUpload(machineId)),
			// Files attached in a thread, for an agent on an SSH machine: its absolute folder there, or the error.
			vscode.commands.registerCommand('arkestra.connections.uploadFiles', (machineId?: unknown, files?: unknown, dir?: unknown) => this.uploadFiles(machineId, files, dir)),
		);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private home(machine: Machine): Place {
		return { machine, path: machine.folder || '~' };
	}

	/** The machine of an id, or the one the user picks (the only one without asking). */
	private async machine(machineId?: string): Promise<Machine | undefined> {
		const list = this.machines();
		if (machineId) {
			return list.find(m => m.id === machineId);
		}
		return list.length === 1 ? list[0] : (await vscode.window.showQuickPick(list.map(m => ({ label: m.name, description: `SSH · ${m.host}`, m })), { title: vscode.l10n.t('Which machine?') }))?.m;
	}

	/**
	 * Opens a folder of a machine in a terminal: this computer through the folder dialog. An SSH
	 * machine's folders are walked on the Machines page (listFolders); the palette goes there.
	 */
	private async openFolder(machineId?: string): Promise<void> {
		if (machineId === 'local') {
			const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, title: vscode.l10n.t('Open a folder on this computer in a terminal'), openLabel: vscode.l10n.t('Open in a terminal') });
			if (picked?.[0]) {
				vscode.window.createTerminal({ name: path.basename(picked[0].fsPath), cwd: picked[0] }).show();
			}
			return;
		}
		await vscode.commands.executeCommand('arkestra.machines.open');
	}

	/** The subfolders of a folder on an SSH machine (default: its default folder), for the Machines page's folder list. */
	private async listFolders(machineId: unknown, dir: unknown): Promise<{ dir: string; parent?: string; folders: string[]; error?: string } | undefined> {
		const machine = typeof machineId === 'string' ? this.machines().find(m => m.id === machineId) : undefined;
		if (!machine) {
			return undefined;
		}
		const at = typeof dir === 'string' && dir.trim() ? dir.trim() : this.home(machine).path;
		const parent = remoteParent(at);
		try {
			const folders = (await listRemote(machine, at, this.ssh())).filter(e => e.folder).map(e => joinRemote(at, e.name));
			return { dir: at, ...(parent ? { parent } : {}), folders };
		} catch (error) {
			return { dir: at, ...(parent ? { parent } : {}), folders: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** A text file on an SSH machine (its first 512 KB), or why it could not be read. */
	private async readFile(machineId: unknown, file: unknown): Promise<{ text?: string; error?: string } | undefined> {
		const machine = typeof machineId === 'string' ? this.machines().find(m => m.id === machineId) : undefined;
		if (!machine || typeof file !== 'string' || !file) {
			return undefined;
		}
		try {
			return { text: await readRemote(machine, file, this.ssh()) };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async uploadFiles(machineId: unknown, files: unknown, dir: unknown): Promise<{ dir?: string; error?: string } | undefined> {
		const machine = typeof machineId === 'string' ? this.machines().find(m => m.id === machineId) : undefined;
		const paths = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f)) : [];
		if (!machine || !paths.length || typeof dir !== 'string' || !dir) {
			return undefined;
		}
		try {
			const folder = await remoteFolder(machine, dir, this.ssh());
			await upload(machine, paths, folder, this.ssh());
			return { dir: folder };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async uploadTo(dir: Place, paths: readonly string[]): Promise<boolean> {
		const where = `${dir.machine.name}:${dir.path}`;
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Uploading {0} to {1}…', paths.length === 1 ? path.basename(paths[0]) : vscode.l10n.t('{0} items', paths.length), where) },
				() => upload(dir.machine, paths, dir.path, this.ssh()));
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('The upload to {0} failed: {1}', where, error instanceof Error ? error.message : String(error)));
			return false;
		}
		void vscode.window.setStatusBarMessage(vscode.l10n.t('Uploaded to {0}', where), 4000);
		return true;
	}

	private async pickAndUpload(machineId?: string): Promise<void> {
		const machine = await this.machine(machineId);
		if (!machine) {
			return;
		}
		const dir = this.home(machine);
		const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, title: vscode.l10n.t('Upload to {0}:{1}', dir.machine.name, dir.path) });
		if (picked?.length) {
			await this.uploadTo(dir, picked.map(u => u.fsPath));
		}
	}

	private async openTerminal(machineId?: string, dir?: string): Promise<void> {
		const machine = await this.machine(machineId);
		if (machine) {
			this.terminal(dir ? { machine, path: dir } : this.home(machine));
		}
	}

	/**
	 * A shell on the machine, in that folder. What is dropped into it (local paths)
	 * is uploaded into that folder after asking, and the remote paths are typed instead.
	 */
	private terminal(node: Place): void {
		const write = new vscode.EventEmitter<string>();
		const close = new vscode.EventEmitter<number | void>();
		let child: ReturnType<typeof spawn> | undefined;
		const pty: vscode.Pseudoterminal = {
			onDidWrite: write.event,
			onDidClose: close.event,
			open: dims => {
				child = spawn(this.ssh().ssh, shellArgs(node.machine, node.path, dims ? { columns: dims.columns, rows: dims.rows } : undefined), { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
				child.stdout?.setEncoding('utf8');
				child.stdout?.on('data', (d: string) => write.fire(d));
				child.stderr?.setEncoding('utf8');
				child.stderr?.on('data', (d: string) => write.fire(d.replace(/\r?\n/g, '\r\n')));
				child.stdin?.on('error', () => { });
				child.on('error', e => { write.fire(`\r\n${e.message}\r\n`); close.fire(1); });
				child.on('close', code => close.fire(code ?? 0));
			},
			close: () => child?.kill(),
			handleInput: data => {
				const paths = droppedPaths(data, existsSync);
				if (!paths) {
					child?.stdin?.write(data);
					return;
				}
				void (async () => {
					const up = vscode.l10n.t('Upload to {0}', node.path);
					const paste = vscode.l10n.t('Just type the path');
					const answer = await vscode.window.showInformationMessage(vscode.l10n.t('Upload {0} to {1}:{2}?', paths.length === 1 ? path.basename(paths[0]) : vscode.l10n.t('{0} items', paths.length), node.machine.name, node.path), up, paste);
					if (answer === up && await this.uploadTo(node, paths)) {
						child?.stdin?.write(uploadedPaths(paths, node.path) + ' ');
					} else if (answer === paste) {
						child?.stdin?.write(data);
					}
				})();
			},
		};
		const terminal = vscode.window.createTerminal({ name: `${node.machine.name} · ${node.path}`, pty, iconPath: new vscode.ThemeIcon('remote') });
		terminal.show();
	}
}

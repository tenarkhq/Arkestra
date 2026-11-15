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
import { droppedPaths, joinRemote, listRemote, shellArgs, upload, uploadedPaths } from './transfer';

/** A folder on an SSH machine. */
interface Place {
	readonly machine: Machine;
	readonly path: string;
}

export class MachineTools implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly machines: () => Machine[], private readonly ssh: () => { ssh: string }) {
		this.disposables.push(
			// The Machines page's "Open a folder": 'local' or an SSH machine's id.
			vscode.commands.registerCommand('arkestra.connections.openFolder', (machineId?: string) => this.openFolder(machineId)),
			vscode.commands.registerCommand('arkestra.connections.openTerminal', (machineId?: string) => this.openTerminal(machineId)),
			vscode.commands.registerCommand('arkestra.connections.upload', (machineId?: string) => this.pickAndUpload(machineId)),
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
	 * Picks a folder on the machine and opens a terminal in it: this computer through the
	 * folder dialog, an SSH machine by walking its folders from its default folder.
	 */
	private async openFolder(machineId?: string): Promise<void> {
		if (machineId === 'local') {
			const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, title: vscode.l10n.t('Open a folder on this computer in a terminal'), openLabel: vscode.l10n.t('Open in a terminal') });
			if (picked?.[0]) {
				vscode.window.createTerminal({ name: path.basename(picked[0].fsPath), cwd: picked[0] }).show();
			}
			return;
		}
		const machine = await this.machine(machineId);
		if (!machine) {
			return;
		}
		type Item = vscode.QuickPickItem & { go?: string; here?: boolean };
		const named = (dir: string) => dir === '~' ? vscode.l10n.t('the home folder') : dir;
		let dir = this.home(machine).path;
		const qp = vscode.window.createQuickPick<Item>();
		qp.title = vscode.l10n.t('Open a folder on {0} in a terminal', machine.name);
		const show = async () => {
			qp.placeholder = vscode.l10n.t('Now in {0}. Pick a folder to go into it, or open a terminal here.', named(dir));
			const here: Item = { label: vscode.l10n.t('Open a terminal in this folder'), description: named(dir), here: true };
			qp.busy = true;
			qp.items = [here];
			try {
				const folders = (await listRemote(machine, dir, this.ssh())).filter(e => e.folder);
				qp.items = [
					here,
					...(dir !== '/' ? [{ label: '..', description: vscode.l10n.t('one folder up'), go: dir === '~' || dir.startsWith('~/') ? joinRemote(dir, '..') : path.posix.dirname(dir) }] : []),
					...folders.map(f => ({ label: f.name, go: joinRemote(dir, f.name) })),
				];
			} catch (error) {
				qp.items = [here, { label: vscode.l10n.t('The folder could not be read: {0}', error instanceof Error ? error.message : String(error)) }];
			} finally {
				qp.busy = false;
			}
		};
		const picked = await new Promise<string | undefined>(resolve => {
			qp.onDidAccept(() => {
				const item = qp.selectedItems[0];
				if (item?.here) {
					resolve(dir);
					qp.hide();
				} else if (item?.go) {
					dir = item.go;
					qp.value = '';
					void show();
				}
			});
			qp.onDidHide(() => resolve(undefined));
			qp.show();
			void show();
		});
		qp.dispose();
		if (picked) {
			this.terminal({ machine, path: picked });
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

	private async openTerminal(machineId?: string): Promise<void> {
		const machine = await this.machine(machineId);
		if (machine) {
			this.terminal(this.home(machine));
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

/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Machines view (AR27): every SSH machine with its folders. Local files and
 *  folders dropped on a remote folder are uploaded there; a terminal on a machine or folder
 *  uploads what is dropped into it (after asking) and types the remote paths instead.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Machine } from './ssh';
import { droppedPaths, joinRemote, listRemote, shellArgs, upload, uploadedPaths, type RemoteEntry } from './transfer';

interface Node {
	readonly machine: Machine;
	/** The remote folder or file; a machine's node is its project folder. */
	readonly path: string;
	readonly kind: 'machine' | 'folder' | 'file';
}

export class MachinesView implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	readonly dropMimeTypes = ['text/uri-list', 'files'];
	readonly dragMimeTypes: string[] = [];
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private readonly tree: vscode.TreeView<Node>;

	constructor(private readonly machines: () => Machine[], private readonly ssh: () => { ssh: string }, onMachinesChanged: vscode.Event<void>) {
		this.tree = vscode.window.createTreeView('arkestra.machines', { treeDataProvider: this, dragAndDropController: this, canSelectMany: false });
		this.disposables.push(
			this.tree,
			onMachinesChanged(() => this.changed.fire(undefined)),
			vscode.commands.registerCommand('arkestra.connections.refreshMachines', (node?: Node) => this.changed.fire(node)),
			vscode.commands.registerCommand('arkestra.connections.openTerminal', (node?: Node | string) => this.openTerminal(node)),
			vscode.commands.registerCommand('arkestra.connections.upload', (node?: Node) => this.pickAndUpload(node)),
		);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const label = node.kind === 'machine' ? node.machine.name : path.posix.basename(node.path);
		const item = new vscode.TreeItem(label, node.kind === 'file' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
		item.contextValue = node.kind;
		item.tooltip = `${node.machine.host}:${node.path}`;
		if (node.kind === 'machine') {
			item.description = `${node.machine.host} · ${node.path}`;
			item.iconPath = new vscode.ThemeIcon('remote');
		} else {
			item.iconPath = node.kind === 'folder' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
			item.resourceUri = vscode.Uri.from({ scheme: 'arkestra-remote', authority: node.machine.id, path: `/${label}` }); // the file icon theme picks the icon by name
		}
		return item;
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!node) {
			return this.machines().map(machine => ({ machine, path: machine.folder || '~', kind: 'machine' }));
		}
		if (node.kind === 'file') {
			return [];
		}
		try {
			const entries: RemoteEntry[] = await listRemote(node.machine, node.path, this.ssh());
			return entries.map(e => ({ machine: node.machine, path: joinRemote(node.path, e.name), kind: e.folder ? 'folder' : 'file' }));
		} catch (error) {
			void vscode.window.showWarningMessage(vscode.l10n.t('{0}: the folder {1} could not be read: {2}', node.machine.name, node.path, error instanceof Error ? error.message : String(error)));
			return [];
		}
	}

	/** The folder a drop or upload goes into: a folder itself, a file's folder, a machine's project folder. */
	private target(node: Node): Node {
		return node.kind === 'file' ? { machine: node.machine, path: path.posix.dirname(node.path), kind: 'folder' } : node;
	}

	async handleDrop(node: Node | undefined, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
		if (!node) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Drop files on a machine or one of its folders.'));
			return;
		}
		const list = await data.get('text/uri-list')?.asString();
		const paths = (list ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
			.map(l => { try { return vscode.Uri.parse(l); } catch { return undefined; } })
			.filter((u): u is vscode.Uri => !!u && u.scheme === 'file')
			.map(u => u.fsPath);
		if (!paths.length || token.isCancellationRequested) {
			return;
		}
		await this.uploadTo(this.target(node), paths);
	}

	private async uploadTo(dir: Node, paths: readonly string[]): Promise<boolean> {
		const where = `${dir.machine.name}:${dir.path}`;
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Uploading {0} to {1}…', paths.length === 1 ? path.basename(paths[0]) : vscode.l10n.t('{0} items', paths.length), where) },
				() => upload(dir.machine, paths, dir.path, this.ssh()));
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('The upload to {0} failed: {1}', where, error instanceof Error ? error.message : String(error)));
			return false;
		}
		void vscode.window.setStatusBarMessage(vscode.l10n.t('Uploaded to {0}', where), 4000);
		this.changed.fire(dir.kind === 'machine' ? undefined : dir);
		return true;
	}

	private async pickAndUpload(node?: Node): Promise<void> {
		const dir = node ? this.target(node) : await this.pickMachineNode();
		if (!dir) {
			return;
		}
		const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, title: vscode.l10n.t('Upload to {0}:{1}', dir.machine.name, dir.path) });
		if (picked?.length) {
			await this.uploadTo(dir, picked.map(u => u.fsPath));
		}
	}

	private async pickMachineNode(): Promise<Node | undefined> {
		const list = this.machines();
		const pick = list.length === 1 ? list[0] : (await vscode.window.showQuickPick(list.map(m => ({ label: m.name, description: m.host, m })), { title: vscode.l10n.t('Machine') }))?.m;
		return pick ? { machine: pick, path: pick.folder || '~', kind: 'machine' } : undefined;
	}

	/**
	 * A shell on the machine, in the node's folder. What is dropped into it (local paths)
	 * is uploaded into that folder after asking, and the remote paths are typed instead.
	 */
	private async openTerminal(arg?: Node | string): Promise<void> {
		const node = typeof arg === 'string'
			? (() => { const m = this.machines().find(x => x.id === arg); return m ? { machine: m, path: m.folder || '~', kind: 'machine' as const } : undefined; })()
			: arg ? this.target(arg) : await this.pickMachineNode();
		if (!node) {
			return;
		}
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

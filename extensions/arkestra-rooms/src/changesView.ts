/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Changes and Checkpoints views of the current room: what the agents changed
 *  since the accepted state (keep or discard per file, diff on click), and the room's
 *  checkpoints (restore, or see what one changed).
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Checkpoints, type Change, type Checkpoint } from './checkpoints';

const SCHEME = 'arkestra-cp';

/** A file's content at a shadow ref, for the diff editor. */
function refUri(ref: string, file: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${file}`, query: JSON.stringify({ ref }) });
}

/** A file a checkpoint changed, under the checkpoint in its view; a click shows the diff. */
interface CheckpointFile {
	readonly kind: 'file';
	readonly cp: Checkpoint;
	readonly previous: Checkpoint;
	readonly change: Change;
}

/** A line under a checkpoint that has no file to show (the first checkpoint, nothing changed). */
interface CheckpointNote {
	readonly kind: 'note';
	readonly text: string;
}

type CheckpointNode = Checkpoint | CheckpointFile | CheckpointNote;

export class ChangesUi implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	private store: Checkpoints | undefined;
	private storeFor: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly storageDir: string, private readonly roomId: () => Promise<string | undefined>) {
		const changesTree: vscode.TreeDataProvider<Change> = {
			onDidChangeTreeData: this.changed.event,
			getChildren: async element => {
				const room = await this.roomId();
				const store = this.checkpoints();
				return element || !room || !store ? [] : store.changes(room).catch(() => []);
			},
			getTreeItem: change => {
				const item = new vscode.TreeItem(path.basename(change.path), vscode.TreeItemCollapsibleState.None);
				item.description = `${path.dirname(change.path) === '.' ? '' : path.dirname(change.path)} · ${change.status === 'A' ? vscode.l10n.t('added') : change.status === 'D' ? vscode.l10n.t('deleted') : vscode.l10n.t('modified')}`;
				item.resourceUri = this.fileUri(change.path);
				item.contextValue = 'change';
				item.command = { command: 'arkestra.changes.open', title: vscode.l10n.t('Open'), arguments: [change] };
				return item;
			},
		};
		// A checkpoint opens in place to the files it changed (no list at the top of the window); a file shows its diff.
		const checkpointsTree: vscode.TreeDataProvider<CheckpointNode> = {
			onDidChangeTreeData: this.changed.event,
			getChildren: async element => {
				const room = await this.roomId();
				const store = this.checkpoints();
				if (!room || !store) {
					return [];
				}
				if (!element) {
					return store.list(room).catch(() => []);
				}
				return 'kind' in element ? [] : this.filesOf(room, element);
			},
			getTreeItem: node => {
				if ('kind' in node) {
					if (node.kind === 'note') {
						const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
						item.contextValue = 'checkpointNote';
						return item;
					}
					const item = new vscode.TreeItem(path.basename(node.change.path), vscode.TreeItemCollapsibleState.None);
					const dir = path.dirname(node.change.path);
					item.description = `${dir === '.' ? '' : `${dir} · `}${node.change.status === 'A' ? vscode.l10n.t('added') : node.change.status === 'D' ? vscode.l10n.t('deleted') : vscode.l10n.t('modified')}`;
					item.resourceUri = this.fileUri(node.change.path);
					item.contextValue = 'checkpointFile';
					item.command = { command: 'arkestra.checkpoints.show', title: vscode.l10n.t('Show the change'), arguments: [node] };
					return item;
				}
				const item = new vscode.TreeItem(`${node.n} · ${node.label}`, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = node.at ? new Date(node.at).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' }) : undefined;
				item.iconPath = new vscode.ThemeIcon('history');
				item.contextValue = 'checkpoint';
				item.tooltip = vscode.l10n.t('Open it to see what checkpoint {0} changed', node.n);
				return item;
			},
		};

		this.disposables.push(
			this.changed,
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
				provideTextDocumentContent: async uri => {
					const { ref } = JSON.parse(uri.query) as { ref: string };
					return (await this.checkpoints()?.contentAt(ref, uri.path.slice(1))) ?? '';
				},
			}),
			vscode.window.createTreeView('arkestra.changes', { treeDataProvider: changesTree }),
			vscode.window.createTreeView('arkestra.checkpoints', { treeDataProvider: checkpointsTree }),
			vscode.commands.registerCommand('arkestra.changes.open', (change: Change) => this.open(change)),
			vscode.commands.registerCommand('arkestra.changes.keep', (change?: Change) => this.act('keep', change)),
			vscode.commands.registerCommand('arkestra.changes.discard', (change?: Change) => this.act('discard', change)),
			vscode.commands.registerCommand('arkestra.changes.keepAll', () => this.act('keep')),
			vscode.commands.registerCommand('arkestra.changes.discardAll', () => this.act('discard')),
			vscode.commands.registerCommand('arkestra.checkpoints.restore', (cp: Checkpoint) => this.restore(cp)),
			vscode.commands.registerCommand('arkestra.checkpoints.show', (file: CheckpointFile) => this.show(file)),
			vscode.commands.registerCommand('arkestra.checkpoints.refresh', () => this.refresh()),
		);
		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		this.disposables.push(watcher, watcher.onDidChange(() => this.refreshSoon()), watcher.onDidCreate(() => this.refreshSoon()), watcher.onDidDelete(() => this.refreshSoon()));
	}

	/** The shadow repository of the current workspace folder. */
	checkpoints(): Checkpoints | undefined {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!folder || folder.scheme !== 'file') {
			return undefined;
		}
		if (this.storeFor !== folder.fsPath) {
			const id = createHash('sha1').update(folder.fsPath).digest('hex').slice(0, 16);
			this.store = new Checkpoints(path.join(this.storageDir, 'checkpoints', `${id}.git`), folder.fsPath);
			this.storeFor = folder.fsPath;
		}
		return this.store;
	}

	/** Takes a checkpoint of the room (skipped when nothing changed); errors never stop a turn. */
	async take(roomId: string, label: string): Promise<void> {
		await this.checkpoints()?.take(roomId, label).catch(() => undefined);
		this.refresh();
	}

	refresh(): void {
		this.changed.fire();
	}

	private refreshSoon(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.refresh(), 1000);
	}

	private fileUri(file: string): vscode.Uri {
		return vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, file);
	}

	private async open(change: Change): Promise<void> {
		const room = await this.roomId();
		if (!room) {
			return;
		}
		const accepted = refUri(`refs/arkestra/${room.replace(/[^A-Za-z0-9-]/g, '')}/accepted`, change.path);
		if (change.status === 'D') {
			await vscode.commands.executeCommand('vscode.open', accepted);
			return;
		}
		await vscode.commands.executeCommand('vscode.diff', accepted, this.fileUri(change.path), vscode.l10n.t('{0} (agent changes)', path.basename(change.path)));
	}

	private async act(what: 'keep' | 'discard', change?: Change): Promise<void> {
		const room = await this.roomId();
		const store = this.checkpoints();
		if (!room || !store) {
			return;
		}
		const files = change ? [change.path] : (await store.changes(room)).map(c => c.path);
		if (!files.length) {
			return;
		}
		if (what === 'discard' && !change) {
			const yes = vscode.l10n.t('Discard all');
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Discard the agents\' changes in {0} files?', files.length), { modal: true }, yes) !== yes) {
				return;
			}
		}
		await (what === 'keep' ? store.keep(room, files) : store.discard(room, files));
		this.refresh();
	}

	private async restore(cp: Checkpoint): Promise<void> {
		const room = await this.roomId();
		const store = this.checkpoints();
		if (!room || !store) {
			return;
		}
		const yes = vscode.l10n.t('Restore');
		if (await vscode.window.showWarningMessage(vscode.l10n.t('Restore the workspace to checkpoint {0} · {1}? A checkpoint of the current state is taken first.', cp.n, cp.label), { modal: true }, yes) !== yes) {
			return;
		}
		await store.restore(room, cp, vscode.l10n.t('Before restoring {0}', cp.n));
		this.refresh();
	}

	/** The files a checkpoint changed compared with the one before it, or why there are none. */
	private async filesOf(room: string, cp: Checkpoint): Promise<CheckpointNode[]> {
		const store = this.checkpoints();
		const previous = store ? (await store.list(room).catch(() => [])).find(c => c.n < cp.n) : undefined;
		if (!store || !previous) {
			return [{ kind: 'note', text: vscode.l10n.t('The first checkpoint of this room') }];
		}
		const files = await store.changedBetween(previous.commit, cp.commit).catch(() => []);
		return files.length ? files.map(change => ({ kind: 'file' as const, cp, previous, change })) : [{ kind: 'note', text: vscode.l10n.t('No file changed') }];
	}

	/** One file's change in a checkpoint, as a diff with the checkpoint before it. */
	private async show(file: CheckpointFile): Promise<void> {
		if (file?.kind !== 'file') {
			return;
		}
		const { previous, cp, change } = file;
		await vscode.commands.executeCommand('vscode.diff', refUri(previous.commit, change.path), refUri(cp.commit, change.path), `${path.basename(change.path)} (${previous.n} → ${cp.n})`);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.disposables.forEach(d => d.dispose());
	}
}

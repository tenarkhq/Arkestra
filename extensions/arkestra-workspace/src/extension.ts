/*---------------------------------------------------------------------------------------------
 *  Arkestra. Mozaik workspace: every part (room, agents, code, terminal) is a tile in the
 *  editor grid, so each can be dragged, split and maximised like an editor. The default
 *  Mozaik opens on first start; layouts can be saved by name and brought back.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { capture, mosaic, readLayout, type EditorLayout, type SavedLayout, type TabDescriptor, type Tile } from './layout';

const LAYOUTS = 'arkestra.workspace.layouts';
const INITIALIZED = 'arkestra.workspace.initialized';
const FOCUS_GROUP = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map(n => `workbench.action.focus${n}EditorGroup`);

export function activate(context: vscode.ExtensionContext): void {
	const saved = (): SavedLayout[] => (context.globalState.get<unknown[]>(LAYOUTS) ?? []).map(readLayout).filter((l): l is SavedLayout => !!l);

	const describe = (tab: vscode.Tab): TabDescriptor => {
		const input = tab.input;
		const chatTab = (vscode as { TabInputChat?: new () => unknown }).TabInputChat;
		if (chatTab && input instanceof chatTab) {
			return { type: 'chat' };
		}
		if (input instanceof vscode.TabInputWebview) {
			return { type: 'webview', viewType: input.viewType };
		}
		if (input instanceof vscode.TabInputTerminal) {
			return { type: 'terminal' };
		}
		if (input instanceof vscode.TabInputText) {
			return { type: 'text', uri: input.uri.toString() };
		}
		if (input instanceof vscode.TabInputTextDiff) {
			return { type: 'diff', original: input.original.toString(), modified: input.modified.toString() };
		}
		return { type: 'other' };
	};

	const groupsByColumn = () => [...vscode.window.tabGroups.all].sort((a, b) => a.viewColumn - b.viewColumn);
	const has = (column: number, type: TabDescriptor['type']) =>
		groupsByColumn().find(g => g.viewColumn === column)?.tabs.some(t => describe(t).type === type) ?? false;

	const openTile = async (tile: Tile, column: number) => {
		switch (tile.kind) {
			case 'room':
				if (!has(column, 'chat') && FOCUS_GROUP[column - 1]) {
					await vscode.commands.executeCommand(FOCUS_GROUP[column - 1]);
					await vscode.commands.executeCommand('workbench.action.openChat');
				}
				break;
			case 'agents':
				await vscode.commands.executeCommand('arkestra.rooms.showAgents', column);
				break;
			case 'terminal':
				if (!has(column, 'terminal')) {
					vscode.window.createTerminal({ location: { viewColumn: column } });
				}
				break;
			case 'file':
				await vscode.window.showTextDocument(vscode.Uri.parse(tile.uri), { viewColumn: column, preview: false, preserveFocus: true }).then(undefined, () => undefined);
				break;
			case 'diff':
				await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(tile.original), vscode.Uri.parse(tile.modified), undefined, { viewColumn: column, preserveFocus: true }).then(undefined, () => undefined);
				break;
		}
	};

	const apply = async (layout: SavedLayout) => {
		// Editors already open stay; the grid takes the new shape and the tiles are filled in.
		await vscode.commands.executeCommand('vscode.setEditorLayout', layout.layout);
		for (let i = 0; i < layout.tiles.length; i++) {
			for (const tile of layout.tiles[i]) {
				await openTile(tile, i + 1);
			}
		}
		await context.workspaceState.update('arkestra.workspace.current', layout.name);
	};

	const save = async () => {
		const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('Save layout'), prompt: vscode.l10n.t('Name of this layout'), value: context.workspaceState.get<string>('arkestra.workspace.current') ?? '' }))?.trim();
		if (!name) {
			return;
		}
		const grid = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
		const layout = capture(name, grid, groupsByColumn().map(g => g.tabs.map(describe)));
		await context.globalState.update(LAYOUTS, [...saved().filter(l => l.name !== name), layout]);
		await context.workspaceState.update('arkestra.workspace.current', name);
		void vscode.window.showInformationMessage(vscode.l10n.t('Layout “{0}” saved.', name));
	};

	const choose = async () => {
		const builtin = mosaic(vscode.l10n.t('Mozaik (default)'));
		const items = [builtin, ...saved()].map(layout => ({ label: layout.name, description: vscode.l10n.t('{0} tiles', layout.tiles.length), layout }));
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Layout') });
		if (pick) {
			await apply(pick.layout);
		}
	};

	const remove = async () => {
		const pick = await vscode.window.showQuickPick(saved().map(layout => ({ label: layout.name, layout })), { title: vscode.l10n.t('Delete a saved layout') });
		if (pick) {
			await context.globalState.update(LAYOUTS, saved().filter(l => l.name !== pick.layout.name));
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('arkestra.workspace.mosaic', () => apply(mosaic(vscode.l10n.t('Mozaik (default)')))),
		vscode.commands.registerCommand('arkestra.workspace.layout', choose),
		vscode.commands.registerCommand('arkestra.workspace.saveLayout', save),
		vscode.commands.registerCommand('arkestra.workspace.deleteLayout', remove),
	);

	// Mozaik is the default: the first start opens it; afterwards VS Code restores the grid itself.
	if (!context.globalState.get<boolean>(INITIALIZED)) {
		void context.globalState.update(INITIALIZED, true).then(() => apply(mosaic(vscode.l10n.t('Mozaik (default)'))));
	}
}

export function deactivate(): void { }

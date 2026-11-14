/*---------------------------------------------------------------------------------------------
 *  Arkestra. Mozaik and Pult workspaces: every part (room, agents, lanes, code, terminal) is
 *  a tile in the editor grid, so each can be dragged, split and maximised like an editor.
 *  The default layout (Mozaik unless set to Pult) opens on first start; layouts can be saved
 *  by name and brought back, and the status bar switcher shows and changes the current one.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { capture, mosaic, pult, readLayout, type EditorLayout, type SavedLayout, type TabDescriptor, type Tile } from './layout';

const LAYOUTS = 'arkestra.workspace.layouts';
const INITIALIZED = 'arkestra.workspace.initialized';
const CURRENT = 'arkestra.workspace.current';
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
			case 'lane':
				await vscode.commands.executeCommand('arkestra.rooms.showLane', tile.slot, column);
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

	const mosaicLayout = () => mosaic(vscode.l10n.t('Mozaik'));
	const pultLayout = async () => pult((await vscode.commands.executeCommand<string[] | undefined>('arkestra.rooms.roster'))?.length ?? 0, vscode.l10n.t('Pult · per agent'));

	// The switcher: the current layout's name in the status bar; a click offers the others.
	const switcher = vscode.window.createStatusBarItem('arkestra.workspace.layout', vscode.StatusBarAlignment.Right, 100);
	switcher.name = vscode.l10n.t('Layout');
	switcher.command = 'arkestra.workspace.layout';
	switcher.tooltip = vscode.l10n.t('Layout: click to switch');
	const showCurrent = () => {
		switcher.text = `$(layout) ${context.workspaceState.get<string>(CURRENT) ?? vscode.l10n.t('Layout')}`;
		switcher.show();
	};

	const apply = async (layout: SavedLayout) => {
		// Arkestra tiles the new layout does not have are closed, not squeezed into its groups;
		// lanes are reopened in their new places. Other editors already open stay.
		const kinds = new Set(layout.tiles.flat().map(t => t.kind));
		const stale = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(tab => {
			const d = describe(tab);
			return d.type === 'webview' && (/(^|-)arkestra\.lane$/.test(d.viewType) || (!kinds.has('agents') && /(^|-)arkestra\.agents$/.test(d.viewType)));
		});
		if (stale.length) {
			await vscode.window.tabGroups.close(stale, true);
		}
		await vscode.commands.executeCommand('vscode.setEditorLayout', layout.layout);
		for (let i = 0; i < layout.tiles.length; i++) {
			for (const tile of layout.tiles[i]) {
				await openTile(tile, i + 1);
			}
		}
		await context.workspaceState.update(CURRENT, layout.name);
		showCurrent();
	};

	const save = async () => {
		const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('Save layout'), prompt: vscode.l10n.t('Name of this layout'), value: context.workspaceState.get<string>(CURRENT) ?? '' }))?.trim();
		if (!name) {
			return;
		}
		const grid = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
		const layout = capture(name, grid, groupsByColumn().map(g => g.tabs.map(describe)));
		await context.globalState.update(LAYOUTS, [...saved().filter(l => l.name !== name), layout]);
		await context.workspaceState.update(CURRENT, name);
		showCurrent();
		void vscode.window.showInformationMessage(vscode.l10n.t('Layout “{0}” saved.', name));
	};

	const choose = async () => {
		const current = context.workspaceState.get<string>(CURRENT);
		const builtins = [
			{ layout: mosaicLayout(), detail: vscode.l10n.t('The room beside the agents, the code and a terminal') },
			{ layout: await pultLayout(), detail: vscode.l10n.t('One lane per agent on top; the room, the code and a terminal below') },
		];
		const items: (vscode.QuickPickItem & { layout?: SavedLayout })[] = [
			...builtins.map(b => ({ label: b.layout.name, detail: b.detail, description: b.layout.name === current ? vscode.l10n.t('current') : undefined, layout: b.layout })),
			...(saved().length ? [{ label: vscode.l10n.t('Saved'), kind: vscode.QuickPickItemKind.Separator }] : []),
			...saved().map(layout => ({ label: layout.name, description: [vscode.l10n.t('{0} tiles', layout.tiles.length), layout.name === current ? vscode.l10n.t('current') : ''].filter(Boolean).join(' · '), layout })),
		];
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Layout') });
		if (pick?.layout) {
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
		switcher,
		vscode.commands.registerCommand('arkestra.workspace.mosaic', () => apply(mosaicLayout())),
		vscode.commands.registerCommand('arkestra.workspace.pult', async () => apply(await pultLayout())),
		vscode.commands.registerCommand('arkestra.workspace.layout', choose),
		vscode.commands.registerCommand('arkestra.workspace.saveLayout', save),
		vscode.commands.registerCommand('arkestra.workspace.deleteLayout', remove),
	);

	// The first start opens the default layout (Mozaik unless set to Pult); afterwards VS Code
	// restores the grid itself and the switcher shows the name last applied.
	showCurrent();
	if (!context.globalState.get<boolean>(INITIALIZED)) {
		const first = vscode.workspace.getConfiguration('arkestra.workspace').get<string>('defaultLayout') === 'pult' ? pultLayout() : Promise.resolve(mosaicLayout());
		void context.globalState.update(INITIALIZED, true).then(() => first).then(apply);
	}
}

export function deactivate(): void { }

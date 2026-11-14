/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Activity view and status bar item (AR37): every thread's agents with their
 *  turn state, task list, sub-agents, background commands and chapters, and the totals.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ActivityBoard, AgentActivity } from './activity';
import { TURN_TEXT, totalsText, turnState, workTotals, type WorkItem } from './work';

type Node =
	| { kind: 'room'; roomId: string }
	| { kind: 'agent'; roomId: string; agentId: string }
	| { kind: 'group'; roomId: string; agentId: string; group: 'todos' | 'subagents' | 'background' | 'chapters' }
	| { kind: 'leaf'; label: string; description?: string; tooltip?: string; icon: string; color?: string };

const ICON: Record<string, [string, string?]> = {
	working: ['sync~spin', 'progressBar.background'], waiting: ['debug-pause', 'editorWarning.foreground'], queued: ['clock'],
	done: ['pass', 'testing.iconPassed'], error: ['error', 'errorForeground'], idle: ['circle-outline'],
};

export class ActivityView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private readonly tree: vscode.TreeView<Node>;
	private readonly item = vscode.window.createStatusBarItem('arkestra.activity', vscode.StatusBarAlignment.Right, 100);
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly board: ActivityBoard, private readonly roomTitle: (id: string) => string, private readonly agentName: (id: string) => string) {
		this.tree = vscode.window.createTreeView('arkestra.activity', { treeDataProvider: this });
		this.item.name = vscode.l10n.t('Agent activity');
		this.item.command = 'arkestra.activity.focus';
		this.disposables.push(this.tree, this.item, board.onDidChange(() => this.refresh()));
		this.refresh();
	}

	dispose(): void {
		clearTimeout(this.timer);
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private refresh(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.changed.fire(undefined);
			const totals = workTotals(this.board.all().map(a => ({ state: this.turn(a.activity), work: a.activity.work })));
			const text = totalsText(totals);
			this.tree.description = text;
			if (totals.working || totals.waiting || totals.background || totals.subagents) {
				this.item.text = `${totals.waiting ? '$(debug-pause)' : '$(sync~spin)'} ${text}`;
				this.item.tooltip = vscode.l10n.t('Agent activity in every thread: {0}', text);
				this.item.backgroundColor = totals.waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
				this.item.show();
			} else {
				this.item.hide();
			}
		}, 150);
	}

	private turn(a: AgentActivity) {
		return turnState(a.state, a.work, a.error, !!a.ran);
	}

	/** Rooms with activity in this session; the busiest first. */
	private rooms(): string[] {
		const score = new Map<string, number>();
		for (const { roomId, activity } of this.board.all()) {
			const t = this.turn(activity);
			const s = t === 'waiting' ? 3 : t === 'working' ? 2 : activity.work?.background.some(b => b.status === 'running') || activity.work?.subagents.some(b => b.status === 'running') ? 1 : 0;
			if (activity.ran || activity.work) {
				score.set(roomId, Math.max(score.get(roomId) ?? 0, s));
			}
		}
		return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			return this.rooms().map(roomId => ({ kind: 'room', roomId }));
		}
		if (node.kind === 'room') {
			return this.board.all().filter(a => a.roomId === node.roomId && (a.activity.ran || a.activity.work)).map(a => ({ kind: 'agent', roomId: node.roomId, agentId: a.agentId }));
		}
		if (node.kind === 'agent') {
			const w = this.board.get(node.roomId, node.agentId).work;
			const groups: Node[] = [];
			for (const group of ['todos', 'subagents', 'background', 'chapters'] as const) {
				if (w?.[group].length) {
					groups.push({ kind: 'group', roomId: node.roomId, agentId: node.agentId, group });
				}
			}
			return groups;
		}
		if (node.kind === 'group') {
			const w = this.board.get(node.roomId, node.agentId).work;
			if (!w) {
				return [];
			}
			const leaf = (i: WorkItem): Node => ({
				kind: 'leaf', label: i.name, ...(i.detail ? { description: i.detail } : {}), ...(i.result ? { tooltip: i.result } : {}),
				icon: i.status === 'running' ? 'sync~spin' : i.status === 'done' ? 'pass' : 'error', ...(i.status === 'error' ? { color: 'errorForeground' } : i.status === 'done' ? { color: 'testing.iconPassed' } : {}),
			});
			switch (node.group) {
				case 'todos': return w.todos.map(t => ({ kind: 'leaf', label: t.text, icon: t.status === 'completed' ? 'pass' : t.status === 'in_progress' ? 'arrow-right' : 'circle-outline', ...(t.status === 'completed' ? { color: 'descriptionForeground' } : {}) }));
				case 'subagents': return [...w.subagents].reverse().map(leaf);
				case 'background': return [...w.background].reverse().map(leaf);
				case 'chapters': return w.chapters.map((c, i) => ({ kind: 'leaf', label: `${i + 1}. ${c.title}`, ...(c.summary ? { tooltip: c.summary } : {}), icon: 'bookmark', description: new Date(c.at).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' }) }));
			}
		}
		return [];
	}

	getTreeItem(node: Node): vscode.TreeItem {
		switch (node.kind) {
			case 'room': {
				const agents = this.board.all().filter(a => a.roomId === node.roomId);
				const t = workTotals(agents.map(a => ({ state: this.turn(a.activity), work: a.activity.work })));
				const item = new vscode.TreeItem(this.roomTitle(node.roomId), vscode.TreeItemCollapsibleState.Expanded);
				item.description = totalsText(t);
				item.iconPath = new vscode.ThemeIcon(t.waiting ? 'debug-pause' : t.working ? 'sync~spin' : t.errors ? 'error' : 'comment-discussion');
				item.command = { command: 'arkestra.rooms.openThread', title: vscode.l10n.t('Open'), arguments: [node.roomId] };
				item.contextValue = 'activity.room';
				return item;
			}
			case 'agent': {
				const a = this.board.get(node.roomId, node.agentId);
				const turn = this.turn(a);
				const w = a.work;
				const item = new vscode.TreeItem(this.agentName(node.agentId), w && (w.todos.length || w.subagents.length || w.background.length || w.chapters.length) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
				const doing = w?.todos.find(t => t.status === 'in_progress')?.text;
				item.description = [vscode.l10n.t(TURN_TEXT[turn]), w?.waiting, doing, turn === 'working' ? a.tool : undefined].filter(Boolean).join(' · ');
				item.tooltip = a.error ? `${vscode.l10n.t(TURN_TEXT[turn])}: ${a.error}` : item.description;
				const [icon, color] = ICON[turn];
				item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
				return item;
			}
			case 'group': {
				const w = this.board.get(node.roomId, node.agentId).work!;
				const running = (list: readonly WorkItem[]) => list.filter(i => i.status === 'running').length;
				const [label, description, icon] = node.group === 'todos'
					? [vscode.l10n.t('Tasks'), `${w.todos.filter(t => t.status === 'completed').length}/${w.todos.length}`, 'checklist']
					: node.group === 'subagents'
						? [vscode.l10n.t('Sub-agents'), running(w.subagents) ? vscode.l10n.t('{0} running', running(w.subagents)) : vscode.l10n.t('all finished'), 'organization']
						: node.group === 'background'
							? [vscode.l10n.t('Background'), running(w.background) ? vscode.l10n.t('{0} running', running(w.background)) : vscode.l10n.t('all finished'), 'terminal']
							: [vscode.l10n.t('Chapters'), String(w.chapters.length), 'list-tree'];
				const open = node.group === 'todos' ? w.todos.some(t => t.status !== 'completed') : node.group === 'chapters' ? false : running(w[node.group]) > 0;
				const item = new vscode.TreeItem(label, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
				item.description = description;
				item.iconPath = new vscode.ThemeIcon(icon);
				return item;
			}
			case 'leaf': {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				if (node.description) {
					item.description = node.description;
				}
				if (node.tooltip) {
					item.tooltip = node.tooltip;
				}
				item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
				return item;
			}
		}
	}
}

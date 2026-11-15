/*---------------------------------------------------------------------------------------------
 *  Arkestra. Shared rules and memory on disk: the user's (Arkestra's storage) and the
 *  project's (AGENTS.md, CLAUDE.md, .arkestra/rules.md, .arkestra/memory.md). Commands open
 *  them; agents' [EMLÉK] lines are added to the project memory (the user's without a project).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { memoryEntry, newEntries, sharedBlock, type SharedSource } from './shared';
import { excludeArkestraFolder } from './templates/gitio';

export class SharedContext implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly storageDir: string) {
		this.disposables.push(
			// The right panel's rows pass the file; the palette picks it.
			vscode.commands.registerCommand('arkestra.shared.openRules', (file?: unknown) => this.open('rules', typeof file === 'string' ? file : undefined)),
			vscode.commands.registerCommand('arkestra.shared.openMemory', (file?: unknown) => this.open('memory', typeof file === 'string' ? file : undefined)),
			// The right panel's field passes the line (true: it was new); the palette opens that field.
			vscode.commands.registerCommand('arkestra.shared.remember', async (text?: unknown) => {
				if (typeof text !== 'string') {
					await vscode.commands.executeCommand('arkestra.details.remember');
					return undefined;
				}
				return text.trim() ? (await this.remember([text.trim()], vscode.l10n.t('You'))).length > 0 : false;
			}),
		);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private project(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private files() {
		const project = this.project();
		return {
			userRules: path.join(this.storageDir, 'shared', 'rules.md'),
			userMemory: path.join(this.storageDir, 'shared', 'memory.md'),
			...(project ? {
				agentsMd: path.join(project, 'AGENTS.md'),
				claudeMd: path.join(project, 'CLAUDE.md'),
				projectRules: path.join(project, '.arkestra', 'rules.md'),
				projectMemory: path.join(project, '.arkestra', 'memory.md'),
			} : {}),
		};
	}

	/** The block every agent gets, or undefined when there is nothing shared at all. */
	async block(): Promise<{ text: string; version: string }> {
		const f = this.files();
		const read = (file?: string) => file ? readFile(file, 'utf8').catch(() => '') : Promise.resolve('');
		const [userRules, agentsMd, claudeMd, projectRules, projectMemory, userMemory] = await Promise.all([read(f.userRules), read(f.agentsMd), read(f.claudeMd), read(f.projectRules), read(f.projectMemory), read(f.userMemory)]);
		const sources: SharedSource[] = [
			{ kind: 'rules', label: 'Szabályok · felhasználó', text: userRules },
			{ kind: 'rules', label: 'Szabályok · projekt (AGENTS.md)', text: agentsMd },
			// CLAUDE.md often only points at AGENTS.md; the same text is not sent twice.
			{ kind: 'rules', label: 'Szabályok · projekt (CLAUDE.md)', text: claudeMd.trim() === agentsMd.trim() ? '' : claudeMd },
			{ kind: 'rules', label: 'Szabályok · projekt (.arkestra/rules.md)', text: projectRules },
			{ kind: 'memory', label: 'Memória · felhasználó', text: userMemory },
			{ kind: 'memory', label: 'Memória · projekt', text: projectMemory },
		];
		return sharedBlock(sources);
	}

	/** Adds entries to the project memory (the user's without a project); returns the new ones. */
	async remember(texts: readonly string[], author: string): Promise<string[]> {
		const f = this.files();
		const file = f.projectMemory ?? f.userMemory;
		const current = await readFile(file, 'utf8').catch(() => '');
		const fresh = newEntries(current, texts);
		if (!fresh.length) {
			return [];
		}
		await this.prepare(file);
		const header = current ? '' : '# Közös memória\n\nMinden agent megkapja. Szerkeszthető; egy sor egy megjegyzés.\n\n';
		const lines = fresh.map(t => memoryEntry(t, author, new Date())).join('\n');
		await appendFile(file, `${header}${current && !current.endsWith('\n') ? '\n' : ''}${lines}\n`);
		return fresh;
	}

	/** The folder exists; a project's .arkestra stays out of git. */
	private async prepare(file: string): Promise<void> {
		await mkdir(path.dirname(file), { recursive: true });
		const project = this.project();
		if (project && file.startsWith(path.join(project, '.arkestra') + path.sep)) {
			await excludeArkestraFolder(project).catch(() => undefined);
		}
	}

	/** Opens a rules or memory file: the one named (the right panel's rows), else the palette's pick. */
	private async open(kind: 'rules' | 'memory', key?: string): Promise<void> {
		const f = this.files();
		const items = kind === 'rules'
			? [
				...(f.projectRules ? [{ key: 'projectRules', label: vscode.l10n.t('Project rules (.arkestra/rules.md)'), detail: vscode.l10n.t('Only on this machine'), file: f.projectRules }] : []),
				...(f.agentsMd ? [{ key: 'agentsMd', label: vscode.l10n.t('Project rules (AGENTS.md)'), detail: vscode.l10n.t('In the repository, shared with the team'), file: f.agentsMd }] : []),
				{ key: 'userRules', label: vscode.l10n.t('My rules'), detail: vscode.l10n.t('Every project'), file: f.userRules },
			]
			: [
				...(f.projectMemory ? [{ key: 'projectMemory', label: vscode.l10n.t('Project memory'), detail: f.projectMemory, file: f.projectMemory }] : []),
				{ key: 'userMemory', label: vscode.l10n.t('My memory'), detail: vscode.l10n.t('Every project'), file: f.userMemory },
			];
		const pick = key !== undefined
			? items.find(i => i.key === key)
			: items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: kind === 'rules' ? vscode.l10n.t('Shared rules') : vscode.l10n.t('Shared memory') });
		if (!pick) {
			return;
		}
		if (!(await stat(pick.file).then(() => true, () => false))) {
			await this.prepare(pick.file);
			await writeFile(pick.file, kind === 'rules' ? '# Szabályok minden agentnek\n\n' : '# Közös memória\n\n');
		}
		await vscode.window.showTextDocument(vscode.Uri.file(pick.file));
	}
}

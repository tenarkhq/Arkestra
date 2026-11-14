/*---------------------------------------------------------------------------------------------
 *  Arkestra. The new-room form of the 2ARK templates: type, the two agents, and what each
 *  type asks for, with 2ARK's defaults.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentRegistry } from './agent';
import { git, repoRoot } from './templates/gitio';
import type { Role } from './templates/signals';
import { DEFAULT_MAX, type AuditState, type Member, type TemplateType } from './templates/types';

export interface TemplateRequest {
	readonly type: TemplateType;
	readonly members: Record<Role, Member>;
	readonly title: string;
	readonly max: number;
	readonly review?: { reviewer: Role; prompt: string; source?: string; strict: 'all' | 'major' | 'critical' };
	readonly code?: { repo: string; base: string; coordinator: Role; prompt: string; issue?: string; plan: 'approve' | 'none'; test?: string; verify: boolean };
	readonly audit?: Pick<AuditState, 'auditors' | 'lead' | 'since' | 'focus' | 'goal' | 'fix' | 'levels'>;
}

/** A brief that is a reference the agents read themselves: an issue or PR link, #123, or a task number. */
export function briefReference(text: string): { issue?: string; prompt: string } {
	const [first, ...rest] = text.trim().split('\n');
	const ref = first.trim();
	if (/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+|#\d+|T\d+(·\d+)?)$/.test(ref)) {
		return { issue: ref, prompt: rest.join('\n').trim() };
	}
	return { prompt: text.trim() };
}

type Choice<T> = vscode.QuickPickItem & { value: T };

async function pick<T>(title: string, items: Choice<T>[], placeHolder?: string): Promise<T | undefined> {
	return (await vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true }))?.value;
}

async function text(title: string, prompt: string, value = '', optional = false): Promise<string | undefined> {
	const v = await vscode.window.showInputBox({ title, prompt, value, ignoreFocusOut: true, validateInput: s => optional || s.trim() ? undefined : vscode.l10n.t('Required') });
	return v === undefined ? undefined : v.trim();
}

export async function templateForm(registry: AgentRegistry, preset?: readonly string[]): Promise<TemplateRequest | undefined> {
	const type = await pick<TemplateType>(vscode.l10n.t('New room from a 2ARK template'), [
		{ label: vscode.l10n.t('Coding'), detail: vscode.l10n.t('The coordinator splits the brief into slices; both agents work in parallel on their own branches, and the coordinator merges.'), value: 'coding' },
		{ label: vscode.l10n.t('Code audit'), detail: vscode.l10n.t('A complete audit of the repository with evidence, by one agent or by both independently and merged; fixes optional.'), value: 'audit' },
		{ label: vscode.l10n.t('Brief check'), detail: vscode.l10n.t('One agent reviews a document (a brief), the other fixes it, round after round, until the reviewer says PASS.'), value: 'review' },
	]);
	if (!type) {
		return undefined;
	}
	const entries = (await registry.inviteList()).filter(e => e.readiness.ready);
	if (entries.length < 2) {
		void vscode.window.showWarningMessage(vscode.l10n.t('A template room needs two ready agents. Connect another agent first.'));
		return undefined;
	}
	const agentItems = (exclude?: string) => entries.filter(e => e.agent.id !== exclude).map(e => ({ label: e.agent.name, description: e.agent.detail, value: { id: e.agent.id, name: e.agent.name } as Member, picked: false }));
	const first = preset?.[0] && entries.some(e => e.agent.id === preset[0]) ? agentItems().find(i => i.value.id === preset[0])!.value : await pick(vscode.l10n.t('First agent'), agentItems());
	if (!first) {
		return undefined;
	}
	const second = preset?.[1] && preset[1] !== first.id && entries.some(e => e.agent.id === preset[1]) ? agentItems().find(i => i.value.id === preset[1])!.value : await pick(vscode.l10n.t('Second agent'), agentItems(first.id));
	if (!second) {
		return undefined;
	}
	const members: Record<Role, Member> = { A: first, B: second };
	const whoItems = (label: (name: string) => string): Choice<Role>[] => (['A', 'B'] as Role[]).map(r => ({ label: label(members[r].name), value: r }));

	if (type === 'review') {
		const prompt = await text(vscode.l10n.t('Brief check'), vscode.l10n.t('What should be checked, and against what?'));
		if (!prompt) {
			return undefined;
		}
		const source = await text(vscode.l10n.t('Brief check'), vscode.l10n.t('The document: a file path, or a GitHub file, issue or PR link. Empty: the task names it, or the fixer writes it.'), '', true);
		if (source === undefined) {
			return undefined;
		}
		const reviewer = await pick(vscode.l10n.t('Who reviews?'), whoItems(n => vscode.l10n.t('{0} reviews, the other fixes', n)));
		const strict = reviewer && await pick<'all' | 'major' | 'critical'>(vscode.l10n.t('What blocks a PASS?'), [
			{ label: vscode.l10n.t('Every open finding'), value: 'all' },
			{ label: vscode.l10n.t('Only P0 and P1 findings'), value: 'major' },
			{ label: vscode.l10n.t('Only P0 findings'), value: 'critical' },
		]);
		if (!reviewer || !strict) {
			return undefined;
		}
		return { type, members, title: vscode.l10n.t('Brief check · {0}', prompt.split('\n')[0].slice(0, 50)), max: DEFAULT_MAX.review, review: { reviewer, prompt, ...(source ? { source } : {}), strict } };
	}

	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const repo = folder && await repoRoot(folder);
	if (!repo) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Coding and audit rooms work in a git repository: open one as the workspace first.'));
		return undefined;
	}
	const current = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || 'main';
	const base = await text(type === 'coding' ? vscode.l10n.t('Coding') : vscode.l10n.t('Code audit'), vscode.l10n.t('Base branch'), current);
	if (!base) {
		return undefined;
	}

	if (type === 'coding') {
		const brief = await text(vscode.l10n.t('Coding'), vscode.l10n.t('The brief: text, or an issue or PR link, #123 or a task number on the first line (the agents read it themselves).'));
		const coordinator = brief && await pick(vscode.l10n.t('Who coordinates?'), whoItems(n => vscode.l10n.t('{0} coordinates', n)));
		const plan = coordinator && await pick<'approve' | 'none'>(vscode.l10n.t('Slice plan'), [
			{ label: vscode.l10n.t('Start at once'), value: 'none' },
			{ label: vscode.l10n.t('The slice plan waits for my approval'), value: 'approve' },
		]);
		const test = plan && await text(vscode.l10n.t('Coding'), vscode.l10n.t('Test command run after [KÉSZ] (empty: none)'), '', true);
		const verify = test !== undefined && plan ? await pick<boolean>(vscode.l10n.t('At the end'), [
			{ label: vscode.l10n.t('The other agent verifies the whole change'), value: true },
			{ label: vscode.l10n.t('No verification'), value: false },
		]) : undefined;
		if (!brief || !coordinator || !plan || test === undefined || verify === undefined) {
			return undefined;
		}
		const ref = briefReference(brief);
		return { type, members, title: vscode.l10n.t('Coding · {0}', brief.split('\n')[0].slice(0, 50)), max: DEFAULT_MAX.coding, code: { repo, base, coordinator, prompt: ref.prompt, ...(ref.issue ? { issue: ref.issue } : {}), plan, ...(test ? { test } : {}), verify } };
	}

	const auditors = await pick<'both' | Role>(vscode.l10n.t('Who audits?'), [
		{ label: vscode.l10n.t('Both, independently, then merged'), value: 'both' },
		...whoItems(n => vscode.l10n.t('Only {0}', n)),
	]);
	const lead = auditors === 'both' ? await pick(vscode.l10n.t('Who leads (merges, then fixes)?'), whoItems(n => n)) : auditors;
	const since = lead && await text(vscode.l10n.t('Code audit'), vscode.l10n.t('Scope: changes since a branch, tag or commit (empty: the whole repository)'), '', true);
	const focus = since !== undefined && lead ? await text(vscode.l10n.t('Code audit'), vscode.l10n.t('Focus (optional)'), '', true) : undefined;
	type Goal = { goal: 'doc' } | { goal: 'fix'; fix: 'approve' } | { goal: 'fix'; fix: 'auto'; levels: 'P0' | 'P1' | 'P2' | 'P3' };
	const goal = focus !== undefined ? await pick<Goal>(vscode.l10n.t('After the audit'), [
		{ label: vscode.l10n.t('Audit document only'), value: { goal: 'doc' } },
		{ label: vscode.l10n.t('Fixes after my approval'), value: { goal: 'fix', fix: 'approve' } },
		{ label: vscode.l10n.t('Fix P0 at once'), value: { goal: 'fix', fix: 'auto', levels: 'P0' } },
		{ label: vscode.l10n.t('Fix P0–P1 at once'), value: { goal: 'fix', fix: 'auto', levels: 'P1' } },
		{ label: vscode.l10n.t('Fix P0–P2 at once'), value: { goal: 'fix', fix: 'auto', levels: 'P2' } },
		{ label: vscode.l10n.t('Fix everything at once'), value: { goal: 'fix', fix: 'auto', levels: 'P3' } },
	]) : undefined;
	const test = goal?.goal === 'fix' ? await text(vscode.l10n.t('Code audit'), vscode.l10n.t('Test command run at the end of the fix (empty: none)'), '', true) : '';
	if (!auditors || !lead || since === undefined || focus === undefined || !goal || test === undefined) {
		return undefined;
	}
	return {
		type, members, title: vscode.l10n.t('Code audit · {0}', since ? vscode.l10n.t('since {0}', since) : base), max: DEFAULT_MAX.audit,
		code: { repo, base, coordinator: lead, prompt: '', plan: 'none', verify: true, ...(test ? { test } : {}) },
		audit: { auditors, lead, ...(since ? { since } : {}), ...(focus ? { focus } : {}), ...goal },
	};
}

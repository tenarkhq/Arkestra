/*---------------------------------------------------------------------------------------------
 *  Arkestra. The new-room form of the 2ARK templates as a page of its own (the left bar's
 *  template button, /template, a board's "coding room"): type, the two agents, and what each
 *  type asks for, with 2ARK's defaults. Start builds the room; a problem shows on the form.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { AgentRegistry } from './agent';
import { FormRequests, formPage } from './pageForm';
import { git, repoRoot } from './templates/gitio';
import type { TemplateType } from './templates/types';
import { templateFormSpec, templateRequest, type TemplateContext, type TemplateFormStrings, type TemplateRequest } from './templateSpec';
import { FONT_ROOT, pageFonts } from './webviewFonts';

export type { TemplateRequest } from './templateSpec';

const VIEW_TYPE = 'arkestra.templateRoom';

function strings(): TemplateFormStrings {
	return {
		formTitle: vscode.l10n.t('New room from a 2ARK template'),
		intro: vscode.l10n.t('Two agents work on one task together; the room hands the work between them until it is done.'),
		start: vscode.l10n.t('Start the room'),
		cancel: vscode.l10n.t('Cancel'),
		type: vscode.l10n.t('What kind of room'),
		coding: vscode.l10n.t('Coding'), codingDetail: vscode.l10n.t('The coordinator splits the brief into slices; both agents work in parallel on their own branches, and the coordinator merges.'),
		audit: vscode.l10n.t('Code audit'), auditDetail: vscode.l10n.t('A complete audit of the repository with evidence, by one agent or by both independently and merged; fixes optional.'),
		review: vscode.l10n.t('Brief check'), reviewDetail: vscode.l10n.t('One agent reviews a document (a brief), the other fixes it, round after round, until the reviewer says PASS.'),
		first: vscode.l10n.t('First agent'), second: vscode.l10n.t('Second agent'),
		sameAgent: vscode.l10n.t('Pick two different agents.'),
		reviewPrompt: vscode.l10n.t('What should be checked, and against what?'),
		reviewSource: vscode.l10n.t('The document'),
		reviewSourceHint: vscode.l10n.t('A file path, or a GitHub file, issue or PR link. Empty: the task names it, or the fixer writes it.'),
		reviewer: vscode.l10n.t('Who reviews?'), firstReviews: vscode.l10n.t('{@first} reviews, {@second} fixes'), secondReviews: vscode.l10n.t('{@second} reviews, {@first} fixes'),
		strict: vscode.l10n.t('What blocks a PASS?'), strictAll: vscode.l10n.t('Every open finding'), strictMajor: vscode.l10n.t('Only P0 and P1 findings'), strictCritical: vscode.l10n.t('Only P0 findings'),
		base: vscode.l10n.t('Base branch'),
		noRepo: vscode.l10n.t('Coding and audit rooms work in a git repository: open one as the workspace first.'),
		brief: vscode.l10n.t('The brief'),
		briefHint: vscode.l10n.t('Text, or an issue or PR link, #123 or a task number on the first line (the agents read it themselves).'),
		coordinator: vscode.l10n.t('Who coordinates?'), firstCoordinates: vscode.l10n.t('The first agent coordinates'), secondCoordinates: vscode.l10n.t('The second agent coordinates'),
		plan: vscode.l10n.t('Slice plan'), planNone: vscode.l10n.t('Start at once'), planApprove: vscode.l10n.t('The slice plan waits for my approval'),
		codeTest: vscode.l10n.t('Test command run after [KÉSZ]'), testHint: vscode.l10n.t('Empty: none.'),
		verify: vscode.l10n.t('At the end'), verifyYes: vscode.l10n.t('The other agent verifies the whole change'), verifyNo: vscode.l10n.t('No verification'),
		auditors: vscode.l10n.t('Who audits?'), auditorsBoth: vscode.l10n.t('Both ({@first} and {@second}), independently, then merged'), auditorsFirst: vscode.l10n.t('Only {@first}'), auditorsSecond: vscode.l10n.t('Only {@second}'),
		lead: vscode.l10n.t('Who leads (merges, then fixes)?'), leadFirst: vscode.l10n.t('The first agent'), leadSecond: vscode.l10n.t('The second agent'),
		since: vscode.l10n.t('Scope: changes since a branch, tag or commit'), sinceHint: vscode.l10n.t('Empty: the whole repository.'),
		focus: vscode.l10n.t('Focus (optional)'),
		goal: vscode.l10n.t('After the audit'), goalDoc: vscode.l10n.t('Audit document only'), goalApprove: vscode.l10n.t('Fixes after my approval'),
		goalP0: vscode.l10n.t('Fix P0 at once'), goalP1: vscode.l10n.t('Fix P0–P1 at once'), goalP2: vscode.l10n.t('Fix P0–P2 at once'), goalP3: vscode.l10n.t('Fix everything at once'),
		auditTest: vscode.l10n.t('Test command run at the end of the fix'),
		reviewTitle: vscode.l10n.t('Brief check · {0}'), codingTitle: vscode.l10n.t('Coding · {0}'), auditTitle: vscode.l10n.t('Code audit · {0}'), sinceTitle: vscode.l10n.t('since {0}'),
	};
}

/** The template page: one at a time; opening it again shows it with the new preset. */
export class TemplateFormPage implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private forms: FormRequests | undefined;

	constructor(private readonly registry: AgentRegistry, private readonly start: (req: TemplateRequest) => Promise<void>) { }

	dispose(): void {
		this.panel?.dispose();
	}

	async open(preset?: readonly string[], task?: { type?: TemplateType; brief?: string }): Promise<void> {
		const ctx = await this.context(preset, task);
		const t = strings();
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, vscode.l10n.t('New template room'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [FONT_ROOT] });
			this.panel.iconPath = new vscode.ThemeIcon('organization');
			const panel = this.panel;
			const forms = new FormRequests(message => void panel.webview.postMessage(message), vscode.l10n.t('Required'));
			this.forms = forms;
			panel.webview.onDidReceiveMessage(message => void forms.receive(message));
			panel.onDidDispose(() => {
				forms.cancelAll();
				if (this.panel === panel) {
					this.panel = undefined;
					this.forms = undefined;
				}
			});
		} else {
			this.panel.reveal();
		}
		const panel = this.panel;
		const spec = templateFormSpec(ctx, t);
		panel.webview.html = formPage({
			nonce: randomBytes(16).toString('base64'),
			fonts: pageFonts(panel.webview),
			spec,
			...(ctx.agents.length < 2 ? { empty: vscode.l10n.t('A template room needs two ready agents. Connect another agent first.') } : {}),
		});
		if (ctx.agents.length < 2) {
			return;
		}
		const values = await this.forms!.open(spec, async v => {
			const req = templateRequest(v, ctx, t);
			if ('message' in req) {
				return req;
			}
			try {
				await this.start(req);
				return undefined;
			} catch (error) {
				return { message: vscode.l10n.t('The template room could not start: {0}', error instanceof Error ? error.message : String(error)) };
			}
		});
		// Started (the thread opened) or cancelled: the page has done its work.
		if (this.panel === panel && (values || !this.forms?.has(spec.id))) {
			panel.dispose();
		}
	}

	private async context(preset?: readonly string[], task?: { type?: TemplateType; brief?: string }): Promise<TemplateContext> {
		const agents = (await this.registry.inviteList()).filter(e => e.readiness.ready).map(e => ({ id: e.agent.id, name: e.agent.name }));
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const repo = folder ? await repoRoot(folder).catch(() => undefined) : undefined;
		const branch = repo ? (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ out: '' }))).out.trim() : '';
		return { agents, ...(preset ? { preset } : {}), ...(task ? { task } : {}), ...(repo ? { repo } : {}), ...(branch ? { branch } : {}) };
	}
}

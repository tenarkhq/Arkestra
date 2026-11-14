/*---------------------------------------------------------------------------------------------
 *  Arkestra. ⌘K ⌘K edit in place with any agent: the selection (or the cursor) and an
 *  instruction go to the chosen agent; its code replaces the lines right in the editor,
 *  marked as a proposal with Accept, Reject, Follow-up and Diff until decided.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentRegistry } from './agent';
import { CONTEXT_LINES, extractCode, fitReplacement, inlineTranscript, shiftSpan, type InlineRequest, type LineSpan } from './inlineEdit';

const LAST_AGENT = 'arkestra.inline.agent';
const PENDING_KEY = 'arkestra.inlineEditPending';
const SCHEME = 'arkestra-inline';

interface Pending {
	readonly id: string;
	readonly uri: vscode.Uri;
	/** The whole document before the edit, for Show diff. */
	readonly before: string;
	/** The replaced lines' text (empty for an insertion) and where the proposal is now. */
	readonly original: string;
	/** The proposal went in as new lines after the cursor's line (Reject removes them whole). */
	readonly insertAfter: boolean;
	span: LineSpan;
	readonly agentId: string;
	readonly request: InlineRequest;
	readonly proposal: string;
}

export class InlineEdits implements vscode.Disposable, vscode.CodeLensProvider {
	private readonly pending = new Map<string, Pending>();
	private readonly lensChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.lensChanged.event;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly decoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	/** Edits Arkestra makes itself do not move a proposal. */
	private applying = false;

	constructor(private readonly context: vscode.ExtensionContext, private readonly registry: AgentRegistry) {
		this.disposables.push(
			this.decoration,
			this.lensChanged,
			vscode.languages.registerCodeLensProvider({ scheme: '*' }, this),
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: uri => [...this.pending.values()].find(p => p.id === uri.query)?.before ?? '' }),
			vscode.commands.registerCommand('arkestra.inline.edit', () => this.start()),
			vscode.commands.registerCommand('arkestra.inline.accept', (key?: string) => this.accept(key)),
			vscode.commands.registerCommand('arkestra.inline.reject', (key?: string) => this.reject(key)),
			vscode.commands.registerCommand('arkestra.inline.followUp', (key?: string) => this.followUp(key)),
			vscode.commands.registerCommand('arkestra.inline.diff', (key?: string) => this.diff(key)),
			vscode.commands.registerCommand('arkestra.inline.agent', () => this.chooseAgent()),
			vscode.workspace.onDidChangeTextDocument(e => this.moved(e)),
			vscode.workspace.onDidCloseTextDocument(doc => this.drop(doc.uri.toString())),
			vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
		);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	// ---- starting an edit -------------------------------------------------------------

	private async start(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const key = editor.document.uri.toString();
		if (this.pending.has(key)) {
			this.accept(key); // a new edit settles the open proposal first
		}
		const agentId = await this.agentFor();
		if (!agentId) {
			return;
		}
		const instruction = await this.ask(agentId, vscode.l10n.t('Edit in place'));
		if (!instruction) {
			return;
		}
		const { request, range, indentAt, insertAfter } = this.request(editor, instruction);
		await this.run(editor, agentId, request, range, indentAt, insertAfter);
	}

	/** The selection widened to whole lines, or the cursor's line for an insertion. */
	private request(editor: vscode.TextEditor, instruction: string) {
		const doc = editor.document;
		const sel = editor.selection;
		const file = vscode.workspace.asRelativePath(doc.uri);
		let first = sel.start.line;
		let last = sel.end.line;
		if (!sel.isEmpty && sel.end.character === 0 && last > first) {
			last -= 1; // a selection ending at a line start does not take that line
		}
		let range: vscode.Range;
		let selected = '';
		let indentAt = '';
		let insertAfter = false;
		if (!sel.isEmpty) {
			range = new vscode.Range(first, 0, last + 1 < doc.lineCount ? last + 1 : last, last + 1 < doc.lineCount ? 0 : doc.lineAt(last).text.length);
			selected = doc.getText(range);
		} else {
			const line = doc.lineAt(first);
			if (line.isEmptyOrWhitespace) {
				range = line.range; // a blank line is replaced
				for (let i = first - 1; i >= 0; i--) {
					if (!doc.lineAt(i).isEmptyOrWhitespace) {
						indentAt = /^[ \t]*/.exec(doc.lineAt(i).text)![0];
						break;
					}
				}
			} else {
				range = new vscode.Range(line.range.end, line.range.end); // new lines after the cursor's line
				indentAt = /^[ \t]*/.exec(line.text)![0];
				insertAfter = true;
				first += 1;
				last = first - 1;
			}
		}
		const before = doc.getText(new vscode.Range(Math.max(0, range.start.line - CONTEXT_LINES), 0, range.start.line, 0));
		const afterStart = insertAfter ? range.end.line + 1 : range.end.line + (range.end.character === 0 && !range.isEmpty ? 0 : 1);
		const after = afterStart < doc.lineCount ? doc.getText(new vscode.Range(afterStart, 0, Math.min(doc.lineCount, afterStart + CONTEXT_LINES), 0)) : '';
		const request: InlineRequest = { file, language: doc.languageId, selected, before, after, line: first + 1, instruction };
		return { request, range, indentAt, insertAfter };
	}

	private async run(editor: vscode.TextEditor, agentId: string, request: InlineRequest, range: vscode.Range, indentAt: string, insertAfter: boolean): Promise<void> {
		const agent = this.registry.get(agentId);
		if (!agent) {
			return;
		}
		const doc = editor.document;
		const versionAtStart = doc.version;
		const answer = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('{0} is editing {1}…', agent.name, request.file), cancellable: true }, async (progress, token) => {
			const abort = new AbortController();
			token.onCancellationRequested(() => abort.abort());
			let text = '';
			let error = '';
			try {
				await agent.turn({ roomId: `inline-${Date.now().toString(36)}`, transcript: inlineTranscript(request, new Date()) }, event => {
					if (event.kind === 'text') {
						text += text ? `\n\n${event.text}` : event.text;
					} else if (event.kind === 'tool') {
						progress.report({ message: event.text });
					} else {
						error = event.text;
					}
				}, abort.signal);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			return token.isCancellationRequested ? undefined : { text, error };
		});
		if (!answer) {
			return;
		}
		const code = extractCode(answer.text);
		if (code === undefined) {
			void vscode.window.showWarningMessage(answer.error
				? vscode.l10n.t('{0} could not make the edit: {1}', agent.name, answer.error)
				: vscode.l10n.t('{0} answered without code; nothing was changed.', agent.name));
			return;
		}
		if (doc.version !== versionAtStart) {
			const go = await vscode.window.showWarningMessage(vscode.l10n.t('The file changed while {0} worked. Put the proposal in anyway?', agent.name), vscode.l10n.t('Put it in'));
			if (!go) {
				return;
			}
		}
		const fitted = fitReplacement(code, request.selected, indentAt);
		const text = insertAfter ? `\n${fitted.replace(/\n$/, '')}` : fitted;
		const before = doc.getText();
		this.applying = true;
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(doc.uri, range, text);
			if (!(await vscode.workspace.applyEdit(edit))) {
				void vscode.window.showWarningMessage(vscode.l10n.t('The proposal could not be put into the file.'));
				return;
			}
		} finally {
			this.applying = false;
		}
		const start = insertAfter ? range.start.line + 1 : range.start.line;
		const lines = fitted.replace(/\n$/, '').split('\n').length;
		this.pending.set(doc.uri.toString(), {
			id: Date.now().toString(36), uri: doc.uri, before, original: request.selected, insertAfter, span: { start, end: start + lines },
			agentId, request, proposal: fitted,
		});
		await this.context.globalState.update(LAST_AGENT, agentId);
		this.paint();
		this.updateContext();
	}

	// ---- deciding ----------------------------------------------------------------------

	private target(key?: string): Pending | undefined {
		return this.pending.get(key ?? vscode.window.activeTextEditor?.document.uri.toString() ?? '');
	}

	private accept(key?: string): void {
		const p = this.target(key);
		if (p) {
			this.drop(p.uri.toString());
		}
	}

	private async reject(key?: string): Promise<void> {
		const p = this.target(key);
		if (!p) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(p.uri);
		let range = proposalRange(doc, p);
		if (p.insertAfter && range.start.line > 0) {
			range = new vscode.Range(doc.lineAt(range.start.line - 1).range.end, range.end); // and the newline it added
		}
		this.applying = true;
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(p.uri, range, p.original);
			await vscode.workspace.applyEdit(edit);
		} finally {
			this.applying = false;
		}
		this.drop(p.uri.toString());
	}

	private async followUp(key?: string): Promise<void> {
		const p = this.target(key);
		const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === p?.uri.toString());
		if (!p || !editor) {
			return;
		}
		const instruction = await this.ask(p.agentId, vscode.l10n.t('Follow-up'));
		if (!instruction) {
			return;
		}
		const range = proposalRange(editor.document, p);
		const current = editor.document.getText(range);
		const request: InlineRequest = {
			...p.request,
			selected: current,
			instruction,
			history: [...(p.request.history ?? []), { instruction: p.request.instruction, proposal: p.proposal }],
		};
		// The follow-up replaces the proposal; Reject afterwards still brings back the original.
		this.drop(p.uri.toString());
		await this.run(editor, p.agentId, request, range, '', false);
		const next = this.pending.get(p.uri.toString());
		if (next) {
			this.pending.set(p.uri.toString(), { ...next, original: p.original, insertAfter: p.insertAfter, before: p.before });
		}
	}

	private async diff(key?: string): Promise<void> {
		const p = this.target(key);
		if (p) {
			await vscode.commands.executeCommand('vscode.diff', vscode.Uri.from({ scheme: SCHEME, path: p.uri.path, query: p.id }), p.uri, vscode.l10n.t('{0} · before ↔ proposal', vscode.workspace.asRelativePath(p.uri)));
		}
	}

	// ---- agents --------------------------------------------------------------------------

	/** The last agent used when it is ready, else the user's pick. */
	private async agentFor(): Promise<string | undefined> {
		const last = this.context.globalState.get<string>(LAST_AGENT);
		const entries = await this.registry.inviteList();
		if (last && entries.some(e => e.agent.id === last && e.readiness.ready)) {
			return last;
		}
		return this.chooseAgent();
	}

	private async chooseAgent(): Promise<string | undefined> {
		const entries = await this.registry.inviteList();
		if (!entries.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No agent is set up yet. Connect one in Arkestra first.'));
			return undefined;
		}
		const last = this.context.globalState.get<string>(LAST_AGENT);
		const pick = await vscode.window.showQuickPick(entries.map(e => ({
			label: e.agent.name,
			description: [e.agent.detail, e.agent.id === last ? vscode.l10n.t('last used') : ''].filter(Boolean).join(' · '),
			detail: e.readiness.ready ? undefined : e.readiness.reason,
			id: e.agent.id,
			ready: e.readiness.ready,
		})), { title: vscode.l10n.t('Edit in place with…') });
		if (!pick) {
			return undefined;
		}
		if (!pick.ready) {
			void vscode.window.showWarningMessage(vscode.l10n.t('{0} is not ready: {1}', pick.label, pick.detail ?? ''));
			return undefined;
		}
		await this.context.globalState.update(LAST_AGENT, pick.id);
		return pick.id;
	}

	/** The instruction box; its button switches the agent. */
	private ask(agentId: string, title: string): Promise<string | undefined> {
		return new Promise<string | undefined>(resolve => {
			const box = vscode.window.createInputBox();
			let current = agentId;
			const name = () => this.registry.get(current)?.name ?? current;
			const label = () => { box.title = `${title} · ${name()}`; };
			label();
			box.placeholder = vscode.l10n.t('What should change? (Enter sends, the button switches the agent)');
			box.buttons = [{ iconPath: new vscode.ThemeIcon('person'), tooltip: vscode.l10n.t('Switch agent') }];
			let done = false;
			box.onDidTriggerButton(async () => {
				done = true;
				box.hide();
				const chosen = await this.chooseAgent();
				if (chosen) {
					current = chosen;
				}
				done = false;
				label();
				box.show();
			});
			box.onDidAccept(() => {
				const value = box.value.trim();
				if (value) {
					done = true;
					box.hide();
					void this.context.globalState.update(LAST_AGENT, current);
					box.dispose();
					resolve(value);
				}
			});
			box.onDidHide(() => {
				if (!done) {
					resolve(undefined);
					box.dispose();
				}
			});
			box.show();
		});
	}

	// ---- painting --------------------------------------------------------------------------

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const p = this.pending.get(document.uri.toString());
		if (!p) {
			return [];
		}
		const at = new vscode.Range(p.span.start, 0, p.span.start, 0);
		const key = document.uri.toString();
		const name = this.registry.get(p.agentId)?.name ?? p.agentId;
		return [
			new vscode.CodeLens(at, { title: `$(check) ${vscode.l10n.t('Accept')}`, command: 'arkestra.inline.accept', arguments: [key], tooltip: vscode.l10n.t('Keep {0}\'s proposal', name) }),
			new vscode.CodeLens(at, { title: `$(discard) ${vscode.l10n.t('Reject')}`, command: 'arkestra.inline.reject', arguments: [key], tooltip: vscode.l10n.t('Bring back the original lines') }),
			new vscode.CodeLens(at, { title: `$(comment) ${vscode.l10n.t('Follow-up')}`, command: 'arkestra.inline.followUp', arguments: [key] }),
			new vscode.CodeLens(at, { title: `$(diff) ${vscode.l10n.t('Diff')}`, command: 'arkestra.inline.diff', arguments: [key] }),
			new vscode.CodeLens(at, { title: name, command: '' }),
		];
	}

	private paint(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const p = this.pending.get(editor.document.uri.toString());
			editor.setDecorations(this.decoration, p && p.span.end > p.span.start
				? [{ range: new vscode.Range(p.span.start, 0, p.span.end - 1, 0), hoverMessage: p.original ? new vscode.MarkdownString().appendText(vscode.l10n.t('Before:')).appendCodeblock(p.original, p.request.language) : vscode.l10n.t('New lines') }]
				: []);
		}
		this.lensChanged.fire();
	}

	private updateContext(): void {
		void vscode.commands.executeCommand('setContext', PENDING_KEY, !!this.target());
	}

	private moved(e: vscode.TextDocumentChangeEvent): void {
		const p = this.pending.get(e.document.uri.toString());
		if (!p || this.applying || !e.contentChanges.length) {
			return;
		}
		for (const c of e.contentChanges) {
			p.span = shiftSpan(p.span, { start: c.range.start.line, end: c.range.end.line, lines: c.text.split('\n').length });
		}
		if (p.span.end <= p.span.start && p.original) {
			this.drop(e.document.uri.toString()); // the proposal was deleted by hand
			return;
		}
		this.paint();
	}

	private drop(key: string): void {
		if (this.pending.delete(key)) {
			this.paint();
			this.updateContext();
		}
	}
}

/**
 * The proposal's text in the document: whole lines with their last newline when it replaced
 * whole lines (the original ends in one), else up to the end of its last line.
 */
function proposalRange(doc: vscode.TextDocument, p: Pending): vscode.Range {
	const last = Math.max(p.span.start, p.span.end - 1);
	if (p.original.endsWith('\n') && p.span.end < doc.lineCount) {
		return new vscode.Range(p.span.start, 0, p.span.end, 0);
	}
	return new vscode.Range(new vscode.Position(p.span.start, 0), doc.lineAt(Math.min(last, doc.lineCount - 1)).range.end);
}

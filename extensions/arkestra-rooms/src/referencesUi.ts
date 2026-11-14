/*---------------------------------------------------------------------------------------------
 *  Arkestra. Resolving @-references for a room message: files (with line ranges), the git
 *  diff, terminal commands and their output, other threads, briefs (#N, a file or a link)
 *  and web pages. VS Code's own #-references (files, selections) are attached the same way.
 *  The '@' completion offers the kinds, then files and threads.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import type { RoomState } from './room';
import { LIMITS, cap, completionKinds, fileTarget, htmlToText, parseReferences, stripAnsi, withAttachments, withoutAttachments, type Attachment, type Reference } from './references';

interface Command {
	readonly line: string;
	output: string;
	exit?: number;
}

/** Commands kept per terminal. */
const KEEP_COMMANDS = 20;

const run = (cmd: string, args: string[], cwd: string | undefined, timeout = 20_000) => new Promise<{ ok: boolean; out: string; err: string }>(resolve => {
	execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } }, (error, out, err) => resolve({ ok: !error, out: String(out), err: String(err) }));
});

export class References implements vscode.Disposable {
	private readonly commands = new WeakMap<vscode.Terminal, Command[]>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly threads: () => Promise<RoomState[]>) {
		// Terminal output is only readable while a command runs (shell integration), so every
		// command's output is collected from the start.
		this.disposables.push(vscode.window.onDidStartTerminalShellExecution(async e => {
			const list = this.commands.get(e.terminal) ?? [];
			const command: Command = { line: e.execution.commandLine.value, output: '' };
			list.push(command);
			if (list.length > KEEP_COMMANDS) {
				list.shift();
			}
			this.commands.set(e.terminal, list);
			try {
				for await (const chunk of e.execution.read()) {
					command.output = (command.output + chunk).slice(-LIMITS.terminal * 2);
				}
			} catch { /* the terminal went away */ }
		}), vscode.window.onDidEndTerminalShellExecution(e => {
			const command = this.commands.get(e.terminal)?.findLast(c => c.line === e.execution.commandLine.value);
			if (command) {
				command.exit = e.exitCode;
			}
		}));
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	/**
	 * The message as the agents get it: the text, then every referenced material. `notes`
	 * are short lines for the chat (what was attached, what could not be).
	 */
	async expand(prompt: string, nativeRefs: readonly vscode.ChatPromptReference[] = [], roomId?: string): Promise<{ text: string; notes: string[] }> {
		const refs = parseReferences(prompt);
		const attachments: Attachment[] = [];
		const notes: string[] = [];
		for (const ref of refs) {
			try {
				const a = await this.resolve(ref, roomId);
				attachments.push(a);
				notes.push(`${ref.token}${a.truncated ? ' (levágva)' : ''}`);
			} catch (error) {
				notes.push(`${ref.token}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const tokens = new Set(refs.map(r => r.token));
		for (const ref of nativeRefs) {
			if (typeof ref.value === 'string' && tokens.has(ref.value)) {
				continue; // our own completion, already resolved from the text
			}
			const a = await this.native(ref).catch(() => undefined);
			if (a) {
				attachments.push(a);
				notes.push(a.label);
			}
		}
		return { text: withAttachments(prompt, attachments), notes };
	}

	private async resolve(ref: Reference, roomId?: string): Promise<Attachment> {
		switch (ref.kind) {
			case 'file': return this.file(ref);
			case 'diff': return this.diff(ref);
			case 'terminal': return this.terminal(ref);
			case 'thread': return this.thread(ref, roomId);
			case 'brief': return this.brief(ref);
			case 'web': return this.web(ref.token, ref.arg);
		}
	}

	private root(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private toUri(p: string): vscode.Uri {
		if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) {
			return vscode.Uri.parse(p);
		}
		if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) {
			return vscode.Uri.file(p);
		}
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!folder) {
			throw new Error(vscode.l10n.t('no workspace folder for a relative path'));
		}
		return vscode.Uri.joinPath(folder, p);
	}

	private async file(ref: Reference): Promise<Attachment> {
		const target = fileTarget(ref.arg);
		const uri = this.toUri(target.path);
		const stat = await vscode.workspace.fs.stat(uri).then(s => s, () => undefined);
		if (!stat) {
			throw new Error(vscode.l10n.t('no such file'));
		}
		if (stat.type & vscode.FileType.Directory) {
			const entries = await vscode.workspace.fs.readDirectory(uri);
			const list = entries.sort((a, b) => a[0].localeCompare(b[0])).map(([name, type]) => `${name}${type & vscode.FileType.Directory ? '/' : ''}`).join('\n');
			return { label: `${ref.token} (mappa)`, text: list };
		}
		const doc = await vscode.workspace.openTextDocument(uri);
		const text = target.from
			? doc.getText(new vscode.Range(target.from - 1, 0, Math.min(doc.lineCount, target.to!), 0))
			: doc.getText();
		const c = cap(text, LIMITS.file);
		return { label: ref.token, text: c.text, language: doc.languageId, truncated: c.truncated };
	}

	private async diff(ref: Reference): Promise<Attachment> {
		const root = this.root();
		const top = root ? await run('git', ['rev-parse', '--show-toplevel'], root) : undefined;
		if (!top?.ok) {
			throw new Error(vscode.l10n.t('the workspace is not a git repository'));
		}
		const cwd = top.out.trim();
		const args = ref.arg ? ['diff', '--no-color', ref.arg] : ['diff', '--no-color', 'HEAD'];
		const r = await run('git', args, cwd);
		if (!r.ok) {
			throw new Error(r.err.trim().split('\n').at(-1) || 'git diff');
		}
		let text = r.out;
		if (!ref.arg) {
			const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], cwd)).out.trim();
			if (untracked) {
				text += `${text ? '\n' : ''}# Új, még nem követett fájlok:\n${untracked.split('\n').map(f => `#   ${f}`).join('\n')}\n`;
			}
		}
		const c = cap(text || '(nincs változás)', LIMITS.diff);
		return { label: ref.token, text: c.text, language: 'diff', truncated: c.truncated };
	}

	private async terminal(ref: Reference): Promise<Attachment> {
		// @terminal: the active terminal's last command; @terminal:3 its last three; @terminal:name a terminal by name.
		const count = /^\d+$/.test(ref.arg) ? Math.max(1, Math.min(KEEP_COMMANDS, Number(ref.arg))) : 1;
		const byName = ref.arg && !/^\d+$/.test(ref.arg) ? vscode.window.terminals.find(t => t.name.toLowerCase() === ref.arg.toLowerCase()) : undefined;
		const terminal = byName ?? vscode.window.activeTerminal ?? vscode.window.terminals.at(-1);
		if (!terminal) {
			throw new Error(vscode.l10n.t('no terminal is open'));
		}
		const list = (this.commands.get(terminal) ?? []).slice(-count);
		if (!list.length) {
			throw new Error(vscode.l10n.t('no command was seen in “{0}” yet (it needs shell integration)', terminal.name));
		}
		const text = list.map(c => `$ ${c.line}\n${stripAnsi(c.output).trimEnd()}${c.exit !== undefined ? `\n[kilépési kód: ${c.exit}]` : '\n[még fut]'}`).join('\n\n');
		const c = cap(text.slice(-LIMITS.terminal * 2), LIMITS.terminal);
		return { label: `${ref.token} (${terminal.name})`, text: c.text, language: 'console', truncated: c.truncated };
	}

	private async thread(ref: Reference, roomId?: string): Promise<Attachment> {
		const q = ref.arg.toLowerCase();
		const all = (await this.threads()).filter(t => t.id !== roomId);
		const found = all.find(t => t.id === ref.arg) ?? all.find(t => t.title.toLowerCase() === q) ?? all.find(t => t.title.toLowerCase().includes(q));
		if (!found) {
			throw new Error(vscode.l10n.t('no thread like this'));
		}
		const lines = found.messages.map(m => `${m.author.name}: ${withoutAttachments(m.text).message}`);
		// The end of a long thread matters most.
		let text = lines.join('\n\n');
		let truncated = false;
		if (text.length > LIMITS.thread) {
			text = text.slice(-LIMITS.thread);
			text = text.slice(text.indexOf('\n\n') + 2);
			truncated = true;
		}
		return { label: `${ref.token} („${found.title}”, ${found.messages.length} üzenet)`, text, language: 'markdown', truncated };
	}

	private async brief(ref: Reference): Promise<Attachment> {
		const arg = ref.arg;
		const issue = /^#?(\d+)$/.exec(arg)?.[1] ?? /github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)/.exec(arg)?.[1];
		if (issue) {
			const repoFlag = /github\.com\/([^/]+\/[^/]+)\//.exec(arg)?.[1];
			for (const kind of ['issue', 'pr']) {
				const r = await run('gh', [kind, 'view', issue, '--json', 'title,body,url', ...(repoFlag ? ['--repo', repoFlag] : [])], this.root());
				if (r.ok) {
					const j = JSON.parse(r.out) as { title: string; body: string; url: string };
					const c = cap(`# ${j.title}\n${j.url}\n\n${j.body}`, LIMITS.brief);
					return { label: ref.token, text: c.text, language: 'markdown', truncated: c.truncated };
				}
			}
			throw new Error(vscode.l10n.t('the brief #{0} could not be read (gh)', issue));
		}
		if (/^https?:\/\//.test(arg)) {
			return this.web(ref.token, arg);
		}
		return this.file({ kind: 'file', arg, token: ref.token });
	}

	private async web(label: string, url: string): Promise<Attachment> {
		if (!/^https?:\/\//.test(url)) {
			throw new Error(vscode.l10n.t('not a web address'));
		}
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 20_000);
		try {
			const res = await fetch(url, { signal: abort.signal, redirect: 'follow', headers: { 'accept': 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1' } });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const type = res.headers.get('content-type') ?? '';
			if (!/^(text\/|application\/(json|xml|xhtml))/.test(type)) {
				throw new Error(vscode.l10n.t('not a text page ({0})', type || '?'));
			}
			const body = await res.text();
			const page = /html/.test(type) ? htmlToText(body) : { text: body };
			const c = cap(page.text, LIMITS.web);
			return { label: `${label}${'title' in page && page.title ? ` („${page.title}”)` : ''}`, text: c.text, language: /json/.test(type) ? 'json' : 'markdown', truncated: c.truncated };
		} finally {
			clearTimeout(timer);
		}
	}

	/** VS Code's own references: a file, a range in it, or a value. */
	private async native(ref: vscode.ChatPromptReference): Promise<Attachment | undefined> {
		const value = ref.value;
		if (value instanceof vscode.Uri) {
			return this.file({ kind: 'file', arg: value.scheme === 'file' ? value.fsPath : value.toString(), token: `#${ref.name ?? vscode.workspace.asRelativePath(value)}` });
		}
		if (value instanceof vscode.Location) {
			const doc = await vscode.workspace.openTextDocument(value.uri);
			const range = new vscode.Range(value.range.start.line, 0, value.range.end.line + 1, 0);
			const c = cap(doc.getText(range), LIMITS.file);
			return { label: `#${vscode.workspace.asRelativePath(value.uri)}:${value.range.start.line + 1}-${value.range.end.line + 1}`, text: c.text, language: doc.languageId, truncated: c.truncated };
		}
		if (typeof value === 'string' && value.trim()) {
			const c = cap(value, LIMITS.file);
			return { label: `#${ref.name ?? ref.id}`, text: c.text, truncated: c.truncated };
		}
		return undefined;
	}

	// ---- completion ------------------------------------------------------------------------

	/** For the room participants: '@' offers the kinds, '@file:' files, '@thread:' threads. */
	completionProvider(): { provider: { provideCompletionItems(query: string, token: vscode.CancellationToken): Promise<vscode.ChatCompletionItem[]> }; triggerCharacters: string[] } {
		const item = (id: string, label: string, value: string, detail?: string, icon?: string) => {
			const c = new vscode.ChatCompletionItem(id, label, [{ level: vscode.ChatVariableLevel.Full, value, description: detail }]);
			c.insertText = value;
			c.detail = detail;
			if (icon) {
				c.icon = new vscode.ThemeIcon(icon);
			}
			return c;
		};
		const kinds: Record<string, [string, string]> = {
			file: [vscode.l10n.t('A file or folder, optionally #L10-40'), 'file'],
			diff: [vscode.l10n.t('The uncommitted changes (or @diff:main...HEAD)'), 'diff'],
			terminal: [vscode.l10n.t('The last terminal command and its output (@terminal:3 for three)'), 'terminal'],
			thread: [vscode.l10n.t('Another thread'), 'comment-discussion'],
			brief: [vscode.l10n.t('A brief: #12, an issue link or a file'), 'checklist'],
			web: [vscode.l10n.t('A web page'), 'globe'],
		};
		return {
			triggerCharacters: ['@'],
			provider: {
				provideCompletionItems: async (query, token) => {
					const [kind, arg = ''] = query.replace(/^@/, '').split(/:(.*)/s);
					if (query.includes(':') && kind === 'file') {
						const files = await vscode.workspace.findFiles(arg ? `**/*${arg.replace(/[[\]{}*?]/g, '')}*` : '**/*', '**/{node_modules,.git,.arkestra}/**', 40, token);
						return files.map(f => {
							const rel = vscode.workspace.asRelativePath(f);
							return item(`arkestra.ref.file.${rel}`, `@file:${rel}`, `@file:${/\s/.test(rel) ? `"${rel}"` : rel}`, undefined, 'file');
						});
					}
					if (query.includes(':') && kind === 'thread') {
						const q = arg.replace(/^"/, '').toLowerCase();
						return (await this.threads()).filter(t => t.title.toLowerCase().includes(q)).slice(0, 30).map(t =>
							item(`arkestra.ref.thread.${t.id}`, `@thread:${t.title}`, `@thread:"${t.title.replace(/"/g, '')}"`, vscode.l10n.t('{0} messages', t.messages.length), 'comment-discussion'));
					}
					return completionKinds(query).map(k => item(`arkestra.ref.${k}`, `@${k}`, k === 'diff' || k === 'terminal' ? `@${k}` : `@${k}:`, kinds[k][0], kinds[k][1]));
				},
			},
		};
	}
}

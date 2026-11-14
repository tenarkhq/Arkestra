/*---------------------------------------------------------------------------------------------
 *  Arkestra. The artifact gallery (AR26): every agent's output of every thread in one place,
 *  grouped by the agent that made it, with search, project / kind / agent filters, pinned ones
 *  on top, and per artifact its
 *  preview, versions, a tab of its own, the jump to its thread, @-reference into the room
 *  and copy.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { RoomState } from './room';
import { ARTIFACT_KINDS, authorKey, authorLabels, extensionFor, filterArtifacts, roomArtifacts, type Artifact, type ArtifactVersion } from './artifacts';
import { flowchartSvg, parseFlowchart } from './flowchart';

const PINNED = 'arkestra.artifacts.pinned';
/** Characters of one version sent to the gallery page (a preview, not an archive). */
const PREVIEW_LIMIT = 200_000;

export class ArtifactGallery implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private artifacts: Artifact[] = [];
	private readonly disposables: vscode.Disposable[] = [];
	private readonly pinsChanged = new vscode.EventEmitter<void>();
	/** Fires when an artifact is pinned or unpinned (the left bar's Pinned list follows). */
	readonly onDidChangePins = this.pinsChanged.event;
	/** The artifact to select when the gallery shows next. */
	private selectNext: string | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly rooms: () => Promise<RoomState[]>,
		private readonly openThread: (roomId: string) => Promise<void>,
	) {
		this.disposables.push(
			this.pinsChanged,
			vscode.commands.registerCommand('arkestra.artifacts.open', () => this.show()),
			vscode.commands.registerCommand('arkestra.artifacts.reveal', (key: unknown) => typeof key === 'string' ? this.reveal(key) : this.show()),
			vscode.window.registerWebviewPanelSerializer('arkestra.artifacts', { deserializeWebviewPanel: async panel => this.adopt(panel) }),
		);
	}

	dispose(): void {
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private pinned(): Set<string> {
		return new Set(this.context.globalState.get<string[]>(PINNED) ?? []);
	}

	/** The pinned artifacts, newest first. */
	async pinnedArtifacts(): Promise<{ key: string; title: string; kind: string }[]> {
		const pinned = this.pinned();
		return filterArtifacts(await this.collect(), { query: '', kinds: [], agents: [] }, pinned, false)
			.filter(a => pinned.has(a.key)).map(a => ({ key: a.key, title: a.title, kind: a.kind }));
	}

	/** Shows the gallery with one artifact selected. */
	async reveal(key: string): Promise<void> {
		this.selectNext = key;
		if (this.panel) {
			this.panel.reveal();
			await this.render();
		} else {
			await this.show();
		}
	}

	/** Rebuilds the list when the gallery is open (a thread changed). */
	refresh(): void {
		if (this.panel) {
			void this.render();
		}
	}

	private async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		this.adopt(vscode.window.createWebviewPanel('arkestra.artifacts', vscode.l10n.t('Artifacts'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
	}

	private adopt(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		panel.iconPath = new vscode.ThemeIcon('layers');
		const project = vscode.workspace.workspaceFolders?.[0]?.uri;
		panel.webview.options = { enableScripts: true, localResourceRoots: project ? [project] : [] };
		panel.onDidDispose(() => { this.panel = undefined; });
		panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) { void this.render(); } });
		panel.webview.onDidReceiveMessage(m => this.onMessage(m));
		void this.render(true);
	}

	private async collect(): Promise<Artifact[]> {
		const all: Artifact[] = [];
		for (const room of await this.rooms()) {
			all.push(...roomArtifacts(room, await this.reviewVersions(room)));
		}
		return all;
	}

	/** A brief check room's versions (v1.md, v2.md…) are one document with versions. */
	private async reviewVersions(room: RoomState) {
		const t = room.template;
		if (t?.type !== 'review' || !t.review?.version) {
			return [];
		}
		const versions: Omit<ArtifactVersion, 'n'>[] = [];
		for (let n = 1; n <= t.review.version; n++) {
			const content = await readFile(path.join(t.folder, `v${n}.md`), 'utf8').catch(() => undefined);
			if (content !== undefined) {
				versions.push({ at: room.messages.at(-1)?.at ?? '', messageId: `v${n}`, content });
			}
		}
		const fixer = t.members[t.review.reviewer === 'A' ? 'B' : 'A'];
		return versions.length ? [{ title: vscode.l10n.t('Brief · {0}', room.title), kind: 'document' as const, versions: versions.map((v, i) => ({ ...v, n: i + 1 })), agentId: fixer.id, agentName: fixer.name }] : [];
	}

	private async render(full = false): Promise<void> {
		const panel = this.panel;
		if (!panel) {
			return;
		}
		this.artifacts = await this.collect();
		const labels = this.labels();
		// Who made it (AR26): the page groups by this key under this label.
		const authors = authorLabels(this.artifacts, { unknown: labels.unknownAgent, local: labels.thisMachine });
		const data = {
			pinned: [...this.pinned()],
			items: await Promise.all(this.artifacts.map(async a => ({
				key: a.key, kind: a.kind, title: a.title, roomId: a.roomId, roomTitle: a.roomTitle, project: a.project ?? '', agentName: a.agentName || labels.unknownAgent,
				author: authorKey(a), authorLabel: authors.get(authorKey(a)) ?? labels.unknownAgent,
				versions: await Promise.all(a.versions.map(async v => ({ n: v.n, at: v.at, language: v.language ?? '', content: v.content.slice(0, PREVIEW_LIMIT), src: a.kind === 'image' ? this.imageSrc(panel.webview, v) : undefined, svg: a.kind === 'diagram' ? diagramSvg(v.content) : undefined }))),
			}))),
			labels,
			select: this.selectNext,
		};
		this.selectNext = undefined;
		if (full || !panel.webview.html) {
			panel.webview.html = galleryHtml(panel.webview.cspSource);
		}
		void panel.webview.postMessage({ type: 'data', data });
	}

	/** An image version as something the page may show: inline SVG, a data: URL, a project file, a web address. */
	private imageSrc(webview: vscode.Webview, v: ArtifactVersion): string | undefined {
		if (v.language === 'svg') {
			return `data:image/svg+xml;base64,${Buffer.from(v.content).toString('base64')}`;
		}
		if (/^(data:image\/|https:\/\/)/.test(v.content)) {
			return v.content;
		}
		const project = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!project || /^[a-z]+:/i.test(v.content)) {
			return undefined;
		}
		return webview.asWebviewUri(vscode.Uri.joinPath(project, v.content.replace(/^\.?\//, ''))).toString();
	}

	private labels() {
		const kinds: Record<string, string> = { diagram: vscode.l10n.t('Diagram'), document: vscode.l10n.t('Document'), page: vscode.l10n.t('Page'), code: vscode.l10n.t('Code'), image: vscode.l10n.t('Image') };
		return {
			title: vscode.l10n.t('Artifacts'), subtitle: vscode.l10n.t('Every agent\'s output of every thread in one place'), search: vscode.l10n.t('Search'),
			project: vscode.l10n.t('Project'), all: vscode.l10n.t('All'), noProject: vscode.l10n.t('No project'), kind: vscode.l10n.t('Kind'), agent: vscode.l10n.t('Agent'),
			pinnedFirst: vscode.l10n.t('Pinned ones on top'), pinnedGroup: vscode.l10n.t('Pinned'), unknownAgent: vscode.l10n.t('Unknown'), thisMachine: vscode.l10n.t('this machine'), empty: vscode.l10n.t('No artifacts yet. Diagrams, documents, pages, code and images the agents write in any thread show up here.'),
			noMatch: vscode.l10n.t('Nothing matches the filters.'), pin: vscode.l10n.t('Pin'), unpin: vscode.l10n.t('Unpin'), openTab: vscode.l10n.t('Open in a tab'), thread: vscode.l10n.t('Go to the thread'),
			send: vscode.l10n.t('Send to the room as an @-reference'), copy: vscode.l10n.t('Copy'), versions: vscode.l10n.t('Versions'), version: vscode.l10n.t('version {0}'), pick: vscode.l10n.t('Pick an artifact on the left.'),
			mermaid: vscode.l10n.t('This diagram kind is shown as its mermaid source; flowcharts are drawn.'), source: vscode.l10n.t('Source'), kinds, kindOrder: ARTIFACT_KINDS,
		};
	}

	private find(key: string, n?: number): { a: Artifact; v: ArtifactVersion } | undefined {
		const a = this.artifacts.find(x => x.key === key);
		const v = a && (n ? a.versions.find(x => x.n === n) : a.versions.at(-1));
		return a && v ? { a, v } : undefined;
	}

	/** A version as a file in Arkestra's storage (a tab, an @file reference). */
	private async save(a: Artifact, v: ArtifactVersion): Promise<vscode.Uri> {
		const dir = path.join(this.context.globalStorageUri.fsPath, 'artifacts', createHash('sha1').update(a.key).digest('hex').slice(0, 12));
		await mkdir(dir, { recursive: true });
		// `schema.py` → schema.v3.py; a title without a file name gets the kind's extension.
		const slug = a.title.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || a.kind;
		const own = /^(.+)\.([a-z0-9]{1,6})$/i.exec(slug);
		const file = path.join(dir, own ? `${own[1]}.v${v.n}.${own[2]}` : `${slug}.v${v.n}.${extensionFor(a, v)}`);
		await writeFile(file, v.content);
		return vscode.Uri.file(file);
	}

	private async onMessage(m: { type: string; key?: string; n?: number; roomId?: string }): Promise<void> {
		if (m.type === 'refresh') {
			return this.render();
		}
		if (m.type === 'thread' && m.roomId) {
			return this.openThread(m.roomId);
		}
		const found = m.key ? this.find(m.key, m.n) : undefined;
		if (!found) {
			return;
		}
		const { a, v } = found;
		switch (m.type) {
			case 'pin': {
				const pinned = this.pinned();
				if (pinned.has(a.key)) {
					pinned.delete(a.key);
				} else {
					pinned.add(a.key);
				}
				await this.context.globalState.update(PINNED, [...pinned]);
				this.pinsChanged.fire();
				return this.render();
			}
			case 'copy':
				await vscode.env.clipboard.writeText(v.content);
				void vscode.window.setStatusBarMessage(vscode.l10n.t('Copied: {0}', a.title), 2000);
				return;
			case 'openTab': {
				const uri = await this.save(a, v);
				if (a.kind === 'document') {
					await vscode.commands.executeCommand('markdown.showPreview', uri);
				} else {
					await vscode.window.showTextDocument(uri, { preview: false });
				}
				return;
			}
			case 'send': {
				const uri = await this.save(a, v);
				// Into the composer of the thread used last (or a new chat): Arkestra's own thread panel.
				await vscode.commands.executeCommand('arkestra.rooms.insertInThread', `@file:"${uri.fsPath}"`);
				return;
			}
			case 'render': {
				// Documents are rendered by VS Code's own markdown renderer.
				const html = await vscode.commands.executeCommand<string>('markdown.api.render', v.content).then(h => h, () => undefined);
				void this.panel?.webview.postMessage({ type: 'rendered', key: a.key, n: v.n, html: html ?? '' });
				return;
			}
		}
	}
}

function galleryHtml(cspSource: string): string {
	const nonce = randomBytes(16).toString('base64');
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: https:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-src 'self' data:;">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; }
	.wrap { display: grid; grid-template-columns: minmax(260px, 380px) 1fr; height: 100vh; }
	.left { border-right: 1px solid var(--vscode-panel-border); overflow: auto; padding: 12px; display: grid; gap: 12px; align-content: start; }
	.right { overflow: auto; padding: 16px 20px; min-width: 0; }
	h1 { font-size: 1.3em; margin: 0; } .mut { color: var(--vscode-descriptionForeground); }
	input[type=search] { width: 100%; box-sizing: border-box; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	.chips { display: flex; flex-wrap: wrap; gap: 4px; } .chips b { width: 100%; font-weight: 600; font-size: .9em; }
	.chip { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 1px 8px; cursor: pointer; background: none; color: inherit; font: inherit; }
	.chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	.group { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; color: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, transparent); font-size: 12px; padding: 10px 2px 0; }
	.group span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; cursor: pointer; display: grid; gap: 2px; }
	.card.sel { outline: 1px solid var(--vscode-focusBorder); }
	.card pre { margin: 4px 0 0; max-height: 4.5em; overflow: hidden; font-size: .85em; opacity: .8; }
	.kind { font-size: .8em; text-transform: uppercase; letter-spacing: .04em; }
	.bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
	button.act { font: inherit; padding: 3px 10px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.act:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.versions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
	.preview pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow: auto; }
	.preview iframe { width: 100%; height: 70vh; border: 1px solid var(--vscode-panel-border); background: white; }
	.preview img { max-width: 100%; }
	.diagram { overflow: auto; padding: 8px 0; }
	.flowchart .node { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-focusBorder); stroke-width: 1.2; }
	.flowchart .nlabel { fill: var(--vscode-foreground); font-size: 12px; }
	.flowchart .edge { stroke: var(--vscode-descriptionForeground); stroke-width: 1.4; }
	.flowchart .edge.dashed { stroke-dasharray: 4 3; }
	.flowchart .arrow { fill: var(--vscode-descriptionForeground); }
	.flowchart .elabel { fill: var(--vscode-descriptionForeground); font-size: 11px; }
	a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style></head><body><div class="wrap"><div class="left" id="left"></div><div class="right" id="right"></div></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const st = Object.assign({ query: '', project: '', kinds: [], agents: [], pinnedFirst: true, sel: undefined, ver: undefined }, vscode.getState() || {});
	let data = { items: [], pinned: [], labels: {} };
	const rendered = new Map();
	const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const latest = a => a.versions[a.versions.length - 1];
	const save = () => vscode.setState(st);
	const time = iso => { if (!iso) return ''; const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(); };
	function list() {
		const q = st.query.trim().toLowerCase();
		const pinned = new Set(data.pinned);
		return data.items
			.filter(a => !st.project || (a.project || '') === st.project)
			.filter(a => !st.kinds.length || st.kinds.includes(a.kind))
			.filter(a => !st.agents.length || st.agents.some(n => a.agentName.startsWith(n)))
			.filter(a => !q || a.title.toLowerCase().includes(q) || a.roomTitle.toLowerCase().includes(q) || latest(a).content.toLowerCase().includes(q))
			.sort((a, b) => (st.pinnedFirst ? (pinned.has(b.key) - pinned.has(a.key)) : 0) || String(latest(b).at).localeCompare(String(latest(a).at)));
	}
	function chips(title, values, current, multi, key) {
		return '<div class="chips"><b>' + esc(title) + '</b>' + values.map(v => '<button class="chip' + ((multi ? current.includes(v.value) : current === v.value) ? ' on' : '') + '" data-f="' + key + '" data-v="' + esc(v.value) + '">' + esc(v.label) + '</button>').join('') + '</div>';
	}
	function draw() {
		const L = data.labels;
		const pinned = new Set(data.pinned);
		const projects = [...new Set(data.items.map(a => a.project || ''))];
		const agents = [...new Set(data.items.map(a => a.agentName.replace(/ ·.*$/, '').replace(/ #\\d+$/, '')))];
		const items = list();
		// Under its author's header a card needs no author; among the pinned it does.
		const card = (a, withAuthor) => { const v = latest(a); return '<div class="card' + (a.key === st.sel ? ' sel' : '') + '" data-key="' + esc(a.key) + '"><span class="kind mut">' + esc(L.kinds[a.kind]) + '</span><b>' + esc(a.title) + '</b><span class="mut">' + (withAuthor ? esc(a.authorLabel) + ' · ' : '') + esc(a.roomTitle) + ' · ' + esc(time(v.at)) + (a.versions.length > 1 ? ' · v' + a.versions.length : '') + '</span>' + (a.kind === 'code' || a.kind === 'diagram' ? '<pre>' + esc(v.content.split('\\n').slice(0, 4).join('\\n')) + '</pre>' : '') + '</div>'; };
		const header = (label, n) => '<div class="group"><span>' + esc(label) + '</span><span>' + n + '</span></div>';
		const top = st.pinnedFirst ? items.filter(a => pinned.has(a.key)) : [];
		const rest = st.pinnedFirst ? items.filter(a => !pinned.has(a.key)) : items;
		// By author, the one with the newest artifact first (the list is newest first).
		const byAuthor = new Map();
		for (const a of rest) { if (!byAuthor.has(a.author)) byAuthor.set(a.author, { label: a.authorLabel, items: [] }); byAuthor.get(a.author).items.push(a); }
		document.getElementById('left').innerHTML = '<div><h1>' + esc(L.title) + '</h1><div class="mut">' + esc(L.subtitle) + '</div></div>'
			+ '<input type="search" id="q" placeholder="' + esc(L.search) + '" value="' + esc(st.query) + '">'
			+ (projects.length > 1 || projects[0] ? chips(L.project, [{ value: '', label: L.all }, ...projects.filter(Boolean).map(p => ({ value: p, label: p.split(/[\\\\/]/).pop() }))], st.project, false, 'project') : '')
			+ chips(L.kind, L.kindOrder.map(k => ({ value: k, label: L.kinds[k] })), st.kinds, true, 'kinds')
			+ (agents.length ? chips(L.agent, agents.map(a => ({ value: a, label: a })), st.agents, true, 'agents') : '')
			+ '<label><input type="checkbox" id="pf"' + (st.pinnedFirst ? ' checked' : '') + '> ' + esc(L.pinnedFirst) + '</label>'
			+ (!data.items.length ? '<p class="mut">' + esc(L.empty) + '</p>' : !items.length ? '<p class="mut">' + esc(L.noMatch) + '</p>' : '')
			+ (top.length ? header(L.pinnedGroup, top.length) + top.map(a => card(a, true)).join('') : '')
			+ [...byAuthor.values()].map(g => header(g.label, g.items.length) + g.items.map(a => card(a, false)).join('')).join('');
		drawDetail();
	}
	function drawDetail() {
		const L = data.labels;
		const a = data.items.find(x => x.key === st.sel);
		const right = document.getElementById('right');
		if (!a) { right.innerHTML = '<p class="mut">' + esc(L.pick || '') + '</p>'; return; }
		const v = a.versions.find(x => x.n === st.ver) || latest(a);
		const isPinned = data.pinned.includes(a.key);
		let preview = '';
		if (a.kind === 'page') preview = '<iframe sandbox="" srcdoc="' + esc(v.content) + '"></iframe>';
		else if (a.kind === 'image') preview = v.src ? '<img src="' + esc(v.src) + '" alt="' + esc(a.title) + '">' : '<pre>' + esc(v.content) + '</pre>';
		else if (a.kind === 'document') { const r = rendered.get(a.key + '#' + v.n); if (r === undefined) { vscode.postMessage({ type: 'render', key: a.key, n: v.n }); preview = '<pre>' + esc(v.content) + '</pre>'; } else preview = r || '<pre>' + esc(v.content) + '</pre>'; }
		else if (a.kind === 'diagram' && v.svg) preview = '<div class="diagram">' + v.svg + '</div><details><summary class="mut">' + esc(L.source) + '</summary><pre>' + esc(v.content) + '</pre></details>';
		else preview = (a.kind === 'diagram' ? '<p class="mut">' + esc(L.mermaid) + '</p>' : '') + '<pre>' + esc(v.content) + '</pre>';
		right.innerHTML = '<h1>' + esc(a.title) + (isPinned ? ' <span class="mut">· ' + esc(L.pinnedGroup) + '</span>' : '') + '</h1>'
			+ '<div class="mut">' + esc(a.authorLabel) + ' · ' + esc(a.roomTitle) + ' · ' + esc(L.version.replace('{0}', v.n)) + ' · ' + esc(time(v.at)) + ' · <a data-act="thread">' + esc(L.thread) + '</a></div>'
			+ '<div class="bar"><button class="act" data-act="pin">' + esc(isPinned ? L.unpin : L.pin) + '</button><button class="act" data-act="openTab">' + esc(L.openTab) + '</button><button class="act" data-act="send">' + esc(L.send) + '</button><button class="act" data-act="copy">' + esc(L.copy) + '</button></div>'
			+ '<div class="preview">' + preview + '</div>'
			+ (a.versions.length > 1 ? '<div class="versions"><b>' + esc(L.versions) + '</b>' + a.versions.map(x => '<button class="chip' + (x.n === v.n ? ' on' : '') + '" data-ver="' + x.n + '">v' + x.n + ' · ' + esc(time(x.at)) + '</button>').join('') + '</div>' : '');
	}
	document.addEventListener('click', e => {
		const t = e.target.closest('[data-f],[data-key],[data-act],[data-ver]');
		if (!t) return;
		if (t.dataset.f) { const f = t.dataset.f, v = t.dataset.v; if (f === 'project') st.project = v; else { const arr = st[f]; const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); } save(); draw(); return; }
		if (t.dataset.key) { st.sel = t.dataset.key; st.ver = undefined; save(); draw(); return; }
		if (t.dataset.ver) { st.ver = Number(t.dataset.ver); save(); drawDetail(); return; }
		const a = data.items.find(x => x.key === st.sel);
		if (!a) return;
		const v = a.versions.find(x => x.n === st.ver) || latest(a);
		if (t.dataset.act === 'thread') vscode.postMessage({ type: 'thread', roomId: a.roomId });
		else vscode.postMessage({ type: t.dataset.act, key: a.key, n: v.n });
	});
	document.addEventListener('input', e => { if (e.target.id === 'q') { st.query = e.target.value; save(); const pos = e.target.selectionStart; draw(); const q = document.getElementById('q'); q.focus(); q.setSelectionRange(pos, pos); } });
	document.addEventListener('change', e => { if (e.target.id === 'pf') { st.pinnedFirst = e.target.checked; save(); draw(); } });
	window.addEventListener('message', e => {
		const m = e.data;
		if (m.type === 'data') {
			data = m.data;
			if (data.select) { Object.assign(st, { sel: data.select, ver: undefined, query: '', project: '', kinds: [], agents: [] }); }
			draw();
		}
		if (m.type === 'rendered') { rendered.set(m.key + '#' + m.n, m.html); drawDetail(); }
	});
</script></body></html>`;
}

/** A flowchart drawn as SVG; other mermaid kinds stay source. */
function diagramSvg(source: string): string | undefined {
	const chart = parseFlowchart(source);
	return chart ? flowchartSvg(chart) : undefined;
}

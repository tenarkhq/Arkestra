/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Machines page: like the Artifacts page, a header with its title and one line,
 *  the search, the filter chips and the list; here one section per machine with its status and
 *  address, and under it the sessions of all its agents. Colours come from the theme, the type
 *  from the approved render.
 *--------------------------------------------------------------------------------------------*/

import { fontFaces, fontSrc, TYPE_CSS, type PageFonts } from './fonts';
import { canList, sessionMatches } from './machinesModel';

export interface MachinesStrings {
	readonly title: string;
	readonly subtitle: string;
	readonly search: string;
	readonly refresh: string;
	readonly connections: string;
	readonly agent: string;
	readonly machine: string;
	readonly all: string;
	readonly claude: string;
	readonly codex: string;
	readonly openThread: string;
	readonly continueHere: string;
	readonly loading: string;
	readonly noSessions: string;
	readonly noAgent: string;
	readonly noMatch: string;
	readonly couldNotRead: string;
	readonly connected: string;
	readonly connecting: string;
	readonly unreachable: string;
	readonly connectionError: string;
	readonly unknown: string;
	readonly localTip: string;
	readonly reconnect: string;
	readonly unreachableNote: string;
	readonly connectingNote: string;
	readonly checked: string;
	readonly folder: string;
	readonly openFolder: string;
	readonly edit: string;
	readonly remove: string;
	readonly removeAsk: string;
	readonly removeYes: string;
	readonly cancel: string;
	/** The connection form (a new one from the header, an edit in the machine's card). */
	readonly addConnection: string;
	readonly host: string;
	readonly hostHint: string;
	readonly name: string;
	readonly nameHint: string;
	readonly folderField: string;
	readonly folderHint: string;
	readonly save: string;
	/** The folder list of Open a folder on an SSH machine. */
	readonly folderUp: string;
	readonly terminalHere: string;
	readonly readingFolders: string;
	readonly noFolders: string;
	readonly couldNotReadFolder: string;
}

/** What the page sends back. */
export type MachinesMessage =
	| { type: 'ready' }
	| { type: 'load'; machine: string }
	| { type: 'open'; key: string }
	| { type: 'refresh' }
	| { type: 'reconnect'; machine: string }
	| { type: 'openFolder'; machine: string }
	| { type: 'remove'; machine: string }
	| { type: 'connections' }
	/** The connection form: `machine` empty for a new one. */
	| { type: 'saveConnection'; machine: string; host: string; name: string; folder: string }
	| { type: 'hosts' }
	/** The folder list: a folder's subfolders (empty `dir`: the default folder), a terminal in one. */
	| { type: 'browse'; machine: string; dir: string }
	| { type: 'terminalAt'; machine: string; dir: string };

const ICONS = {
	search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>',
	refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 8a5 5 0 1 1-1.5-3.55"/><path d="M13 2.5V5h-2.5"/></svg>',
	plug: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/></svg>',
	chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 4 4 4-4 4"/></svg>',
	machine: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="7" rx="1.5"/><path d="M5.5 13h5M8 10v3"/></svg>',
	folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.5h4.9A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
};

function esc(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

export function machinesHtml(nonce: string, s: MachinesStrings, fonts?: PageFonts): string {
	const strings = JSON.stringify(s).replace(/</g, '\\u003c');
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';${fontSrc(fonts)} script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${fontFaces(fonts)}
	:root {
		--fg: var(--vscode-editor-foreground, var(--vscode-foreground));
		--mute: var(--vscode-descriptionForeground);
		--dim: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, transparent);
		--line: var(--vscode-panel-border, var(--vscode-widget-border, transparent));
		--hover: var(--vscode-list-hoverBackground);
		--sel: var(--vscode-list-inactiveSelectionBackground);
		--accent: var(--vscode-progressBar-background, var(--vscode-button-background));
		--ok: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
		--warn: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow));
		--bad: var(--vscode-testing-iconFailed, var(--vscode-errorForeground));
		--claude: var(--vscode-charts-orange, #e0915a);
		--codex: var(--vscode-charts-blue, #9fb4d8);
	}
	html, body { margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--fg); }
	body { ${TYPE_CSS} font-size: 13px; }
	.page { max-width: 920px; margin: 0 auto; padding: 28px 28px 40px; display: flex; flex-direction: column; gap: 14px; }
	header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
	h1 { font-size: 22px; font-weight: 600; letter-spacing: -.01em; margin: 0 0 4px; }
	.hd { flex: 1 1 380px; min-width: 0; }
	.sub { color: var(--mute); line-height: 1.5; }
	.tools { display: flex; gap: 6px; }
	button { font: inherit; color: inherit; }
	.btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 7px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; white-space: nowrap; font-size: 12.5px; }
	.btn:hover { background: var(--hover); }
	.btn svg { width: 14px; height: 14px; color: var(--mute); }
	.btn:focus-visible, .chip:focus-visible, .row:focus-visible, .mh:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.search { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 11px; border-radius: 9px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); }
	.search:focus-within { border-color: var(--vscode-focusBorder); }
	.search svg { width: 15px; height: 15px; color: var(--mute); flex: none; }
	.search input { flex: 1; min-width: 0; border: 0; padding: 0; background: transparent; color: var(--vscode-input-foreground, var(--fg)); font: inherit; font-size: 13.5px; outline: none; }
	.search input::placeholder { color: var(--dim); }
	.filters { display: flex; flex-wrap: wrap; gap: 8px 22px; }
	.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
	.chips b { font-weight: 500; font-size: 12px; color: var(--mute); margin-right: 4px; }
	.chip { height: 26px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--line); background: transparent; cursor: pointer; font-size: 12.5px; color: var(--fg); }
	.chip:hover { background: var(--hover); }
	.chip.on { background: var(--sel); border-color: var(--vscode-focusBorder); }
	#list { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
	.m { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
	.mh { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 0 14px; cursor: pointer; user-select: none; -webkit-user-select: none; }
	.mh:hover { background: var(--hover); }
	.mh .chev { width: 12px; height: 12px; color: var(--dim); flex: none; transition: transform .12s; }
	.m.open .mh .chev { transform: rotate(90deg); }
	.mh .ic { width: 16px; height: 16px; color: var(--mute); flex: none; }
	.mh .name { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.mh .host { color: var(--mute); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
	.mh .when { color: var(--dim); font-size: 12px; white-space: nowrap; }
	.mi { display: flex; flex-direction: column; gap: 9px; padding: 0 14px 12px 38px; }
	.facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; color: var(--mute); font-size: 12px; min-width: 0; }
	.facts .fd { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
	.facts .fd svg { width: 13px; height: 13px; flex: none; color: var(--dim); }
	.facts .fd code { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 11.5px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.facts .counts { display: inline-flex; gap: 6px; flex-wrap: wrap; }
	.acts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
	.acts .btn { height: 26px; padding: 0 10px; font-size: 12px; }
	.acts .btn.danger, .confirm .btn.danger { color: var(--bad); }
	.confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--bad) 9%, transparent); }
	.confirm span { flex: 1 1 260px; line-height: 1.4; }
	.confirm .btn.danger { border-color: color-mix(in srgb, var(--bad) 55%, transparent); font-weight: 500; }
	.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; white-space: nowrap; color: var(--mute); }
	.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dim); }
	.conn.connected { color: var(--ok); } .conn.connected .dot { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
	.conn.connecting .dot { background: var(--mute); animation: pulse 1.2s ease-in-out infinite; }
	.conn.unreachable { color: var(--mute); } .conn.unreachable .dot { background: var(--dim); }
	.conn.error { color: var(--bad); } .conn.error .dot { background: var(--bad); }
	.conn.unknown .dot { background: transparent; border: 1.5px solid var(--dim); box-sizing: border-box; }
	@keyframes pulse { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.1); } }
	.spin { width: 10px; height: 10px; border-radius: 50%; flex: none; border: 2px solid color-mix(in srgb, var(--mute) 35%, transparent); border-top-color: var(--accent); animation: spin .8s linear infinite; box-sizing: border-box; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } .conn.connecting .dot { animation: none; opacity: .7; } }
	.mb { display: none; border-top: 1px solid var(--line); }
	.m.open .mb { display: block; }
	.err { color: var(--bad); padding: 9px 14px 0 38px; line-height: 1.45; overflow-wrap: anywhere; }
	.err:last-of-type { padding-bottom: 9px; }
	.note { color: var(--mute); padding: 12px 14px 12px 38px; display: flex; align-items: center; gap: 8px; }
	.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; align-items: center; padding: 9px 14px 9px 38px; cursor: pointer; }
	.row + .row { border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
	.row:hover { background: var(--hover); }
	.row .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13.5px; }
	.row .meta { display: flex; align-items: center; gap: 8px; color: var(--mute); font-size: 12px; min-width: 0; grid-column: 1; }
	.row .meta svg { width: 13px; height: 13px; flex: none; color: var(--dim); }
	.row .meta .f { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.row .side { grid-column: 2; grid-row: 1 / span 2; display: flex; align-items: center; gap: 10px; }
	.row .w { color: var(--dim); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
	.badge { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 11.5px; font-weight: 500; white-space: nowrap; flex: none; }
	.badge i { width: 6px; height: 6px; border-radius: 50%; }
	.badge.claude { color: var(--claude); background: color-mix(in srgb, var(--claude) 14%, transparent); }
	.badge.claude i { background: var(--claude); }
	.badge.codex { color: var(--codex); background: color-mix(in srgb, var(--codex) 14%, transparent); }
	.badge.codex i { background: var(--codex); }
	.badge.other { color: var(--mute); background: var(--sel); }
	.badge.other i { background: var(--mute); }
	.row .thread { font-size: 12px; font-weight: 500; color: var(--accent); white-space: nowrap; }
	.go { font-size: 12px; color: var(--dim); white-space: nowrap; visibility: hidden; }
	.row:hover .go, .row:focus-visible .go { visibility: visible; }
	.empty { color: var(--mute); padding: 24px 2px; }
	.cf { display: grid; gap: 10px; padding: 12px 14px; border-radius: 9px; border: 1px solid var(--line); background: var(--vscode-editorWidget-background, transparent); max-width: 560px; }
	.cf label { display: grid; gap: 4px; }
	.cf label > span { font-size: 12px; font-weight: 500; color: var(--mute); }
	.cf small { color: var(--mute); font-size: 11.5px; line-height: 1.4; }
	.cf input { font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); color: var(--vscode-input-foreground, var(--fg)); outline: none; }
	.cf input:focus { border-color: var(--vscode-focusBorder); }
	.cf .bad input { border-color: var(--bad); }
	.cf .ferr { color: var(--bad); font-size: 12px; }
	.cf .row2 { display: flex; gap: 6px; justify-content: flex-end; }
	.btn.pri { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	.btn.pri:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
	.m.adding { border-style: dashed; padding: 12px 14px; }
	.m.adding h2 { font-size: 13.5px; font-weight: 600; margin: 0 0 10px; }
	.fl { display: grid; gap: 2px; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--line); max-width: 560px; }
	.fl .here { display: flex; align-items: center; gap: 8px; padding: 2px 2px 8px; border-bottom: 1px solid var(--line); margin-bottom: 4px; min-width: 0; }
	.fl .here svg { width: 14px; height: 14px; color: var(--mute); flex: none; }
	.fl .here code { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.fl .fo { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 6px; border: 0; border-radius: 6px; background: transparent; cursor: pointer; font-size: 12.5px; color: var(--fg); }
	.fl .fo:hover, .fl .fo:focus-visible { background: var(--hover); outline: none; }
	.fl .fo svg { width: 13px; height: 13px; color: var(--dim); flex: none; }
	.fl .fn { color: var(--mute); font-size: 12px; padding: 6px; }
	.fl .fn.bad { color: var(--bad); }
	@media (max-width: 560px) { .page { padding: 18px 16px 28px; } .row, .err, .note, .mi { padding-left: 14px; } .row .go { display: none; } .mh .host { display: none; } }
</style></head><body>
<div class="page">
	<header>
		<div class="hd"><h1>${esc(s.title)}</h1><div class="sub">${esc(s.subtitle)}</div></div>
		<div class="tools">
			<button class="btn" id="refresh" title="${esc(s.refresh)}">${ICONS.refresh}<span>${esc(s.refresh)}</span></button>
			<button class="btn" id="addConn"><span>+ ${esc(s.addConnection)}</span></button>
			<button class="btn" id="connections">${ICONS.plug}<span>${esc(s.connections)}</span></button>
		</div>
	</header>
	<label class="search">${ICONS.search}<input id="q" type="search" spellcheck="false" placeholder="${esc(s.search)}" aria-label="${esc(s.search)}"></label>
	<div class="filters" id="filters"></div>
	<div id="list"></div>
</div>
<template id="i-chevron">${ICONS.chevron}</template>
<template id="i-machine">${ICONS.machine}</template>
<template id="i-folder">${ICONS.folder}</template>
<script type="application/json" id="l10n" nonce="${nonce}">${strings}</script>
<script nonce="${nonce}">
(() => {
	const vscode = acquireVsCodeApi();
	const S = JSON.parse(document.getElementById('l10n').textContent);
	// Bound to their names here: the shipped bundle renames functions, so a bare declaration would not be found.
	const sessionMatches = ${sessionMatches.toString()};
	const canList = ${canList.toString()};
	const st = Object.assign({ agent: '', machine: '', query: '', folded: [] }, vscode.getState() || {});
	// The machine whose Remove waits for its Yes; not kept across reloads.
	let confirming = '';
	// The connection form open (machine '' : a new one) with what is typed so far, kept across redraws.
	let editing = null;
	// The folder list of Open a folder on an SSH machine.
	let browsing = null;
	let hosts = [];
	const list = document.getElementById('list');
	const filters = document.getElementById('filters');
	const q = document.getElementById('q');
	q.value = st.query;
	let model = { machines: [] };
	const asked = new Set();
	const post = m => vscode.postMessage(m);
	const save = () => vscode.setState(st);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; };
	const icon = name => document.getElementById('i-' + name).content.firstElementChild.cloneNode(true);
	const CONN = { connected: S.connected, connecting: S.connecting, unreachable: S.unreachable, error: S.connectionError, unknown: S.unknown };

	function chip(group, value, label) {
		const b = el('button', 'chip' + (st[group] === value ? ' on' : ''), label);
		b.dataset.group = group;
		b.dataset.value = value;
		return b;
	}

	function drawFilters() {
		const agent = el('div', 'chips');
		agent.append(el('b', '', S.agent), chip('agent', '', S.all), chip('agent', 'claude', S.claude), chip('agent', 'codex', S.codex));
		const machine = el('div', 'chips');
		machine.append(el('b', '', S.machine), chip('machine', '', S.all), ...model.machines.map(m => chip('machine', m.id, m.name)));
		filters.replaceChildren(agent, machine);
	}

	function row(s, machineId) {
		const r = el('div', 'row');
		r.tabIndex = 0;
		r.setAttribute('role', 'button');
		r.dataset.key = s.key;
		r.title = [s.title, s.cwd].filter(Boolean).join('\\n');
		r.append(el('span', 't', s.title));
		const meta = el('span', 'meta');
		const badge = el('span', 'badge ' + s.kind);
		badge.append(el('i'), document.createTextNode(s.agent));
		meta.append(badge);
		if (s.folder) { meta.append(icon('folder'), el('span', 'f', s.folder)); }
		r.append(meta);
		const side = el('span', 'side');
		side.append(el('span', 'w', s.when));
		side.append(s.thread ? el('span', 'thread', S.openThread) : el('span', 'go', S.continueHere));
		r.append(side);
		return r;
	}

	function connForm(id, title) {
		const f = el('form', 'cf');
		f.dataset.form = id;
		f.noValidate = true;
		if (title) { f.append(el('h2', '', title)); }
		const field = (key, label, hint, placeholder, list) => {
			const l = el('label', editing.field === key ? 'bad' : '');
			l.append(el('span', '', label));
			const i = el('input');
			i.dataset.f = key;
			i.value = editing[key] || '';
			i.autocomplete = 'off';
			i.spellcheck = false;
			if (placeholder) { i.placeholder = placeholder; }
			if (list) { i.setAttribute('list', 'sshHosts'); }
			l.append(i, el('small', '', hint));
			if (editing.field === key && editing.error) { l.append(el('small', 'ferr', editing.error)); }
			return l;
		};
		f.append(field('host', S.host, S.hostHint, 'dev@server.example.com', true), field('name', S.name, S.nameHint), field('folder', S.folderField, S.folderHint, '~/projects/app'));
		const dl = el('datalist'); dl.id = 'sshHosts';
		for (const h of hosts) { const o = el('option'); o.value = h; dl.append(o); }
		f.append(dl);
		if (editing.error && !editing.field) { f.append(el('div', 'ferr', editing.error)); }
		const row = el('div', 'row2');
		const cancel = el('button', 'btn', S.cancel); cancel.type = 'button'; cancel.dataset.act = 'formCancel'; cancel.dataset.id = id;
		const save = el('button', 'btn pri', S.save); save.type = 'submit'; save.disabled = !!editing.busy;
		row.append(cancel, save);
		f.append(row);
		return f;
	}

	function folderList(m) {
		const box = el('div', 'fl');
		const here = el('div', 'here');
		here.append(icon('folder'), el('code', '', browsing.dir || m.folder));
		const go = el('button', 'btn pri', S.terminalHere); go.dataset.act = 'terminalHere'; go.dataset.id = m.id; go.disabled = !browsing.dir;
		const cancel = el('button', 'btn', S.cancel); cancel.dataset.act = 'browseCancel'; cancel.dataset.id = m.id;
		here.append(go, cancel);
		box.append(here);
		const item = (dir, label) => { const b = el('button', 'fo'); b.dataset.act = 'browseTo'; b.dataset.id = m.id; b.dataset.dir = dir; b.append(icon('folder'), el('span', '', label)); return b; };
		if (browsing.loading) { box.append(el('div', 'fn', S.readingFolders)); return box; }
		if (browsing.parent) { box.append(item(browsing.parent, S.folderUp)); }
		if (browsing.error) { box.append(el('div', 'fn bad', S.couldNotReadFolder.replace('{0}', browsing.error))); }
		else if (!browsing.folders.length) { box.append(el('div', 'fn', S.noFolders)); }
		for (const d of browsing.folders) { box.append(item(d, d.replace(/\\/+$/, '').split('/').pop() || d)); }
		return box;
	}

	function machine(m) {
		const open = !st.folded.includes(m.id);
		const box = el('section', 'm' + (open ? ' open' : ''));
		const head = el('div', 'mh');
		head.tabIndex = 0;
		head.setAttribute('role', 'button');
		head.setAttribute('aria-expanded', String(open));
		head.dataset.machine = m.id;
		const shown = m.sessions.filter(s => sessionMatches(s, m.id, st));
		const c = m.connection;
		const chev = icon('chevron');
		chev.classList.add('chev');
		const pc = icon('machine');
		pc.classList.add('ic');
		const conn = el('span', 'conn ' + c.state);
		conn.append(el('span', 'dot'), document.createTextNode(CONN[c.state] || ''));
		conn.title = m.local ? S.localTip : c.reason || CONN[c.state] || '';
		head.append(chev, pc, el('span', 'name', m.name), el('span', 'host', m.host), conn);
		if (m.checked) { head.append(el('span', 'when', S.checked.replace('{0}', m.checked))); }
		box.append(head);
		// What the card says without opening it: its default folder, its sessions per agent, what can be done.
		const info = el('div', 'mi');
		const facts = el('div', 'facts');
		const fd = el('span', 'fd');
		fd.title = S.folder + ': ' + m.folder;
		fd.append(icon('folder'), el('span', '', S.folder), el('code', '', m.folder));
		facts.append(fd);
		if (m.counts.length) {
			const counts = el('span', 'counts');
			for (const k of m.counts) {
				const b = el('span', 'badge ' + k.kind);
				b.append(el('i'), document.createTextNode(k.agent + ' ' + k.n));
				counts.append(b);
			}
			facts.append(counts);
		}
		info.append(facts);
		const button = (act, label, cls) => { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label); b.dataset.act = act; b.dataset.id = m.id; return b; };
		if (editing && editing.id === m.id) {
			info.append(connForm(m.id));
		} else if (browsing && browsing.id === m.id) {
			info.append(folderList(m));
		} else if (confirming === m.id) {
			const ask = el('div', 'confirm');
			ask.append(el('span', '', S.removeAsk.replace('{0}', m.name)), button('removeYes', S.removeYes, 'danger'), button('cancel', S.cancel));
			info.append(ask);
		} else {
			const acts = el('div', 'acts');
			if (!m.local) { acts.append(button('reconnect', S.reconnect)); }
			acts.append(button('openFolder', S.openFolder));
			if (m.configured) { acts.append(button('edit', S.edit), button('remove', S.remove, 'danger')); }
			info.append(acts);
		}
		box.append(info);
		const body = el('div', 'mb');
		const note = (text, spin) => { const n = el('div', 'note'); if (spin) { n.append(el('span', 'spin')); } n.append(document.createTextNode(text)); return n; };
		if (c.state === 'error' && c.reason) { body.append(el('div', 'err', c.reason)); }
		if (!canList(c)) {
			if (!m.sessions.length && c.state !== 'error') { body.append(c.state === 'connecting' ? note(S.connectingNote, true) : note(S.unreachableNote)); }
		} else {
			for (const e of m.errors) { body.append(el('div', 'err', S.couldNotRead.replace('{0}', e.agent).replace('{1}', e.message))); }
			if ((m.state === 'loading' || m.state === 'idle') && !m.sessions.length) { body.append(note(S.loading, true)); }
			if (m.state === 'none') { body.append(note(S.noAgent)); }
			else if ((m.state === 'ok' || m.state === 'partial') && !m.sessions.length) { body.append(note(S.noSessions)); }
		}
		if (m.sessions.length && !shown.length) { body.append(note(S.noMatch)); }
		for (const s of shown) { body.append(row(s, m.id)); }
		box.append(body);
		return box;
	}

	function draw() {
		drawFilters();
		const visible = model.machines.filter(m => !st.machine || m.id === st.machine);
		// Lazily: a machine is read when it is shown unfolded, once per page (Refresh reads again).
		for (const m of visible) {
			if (m.state === 'idle' && canList(m.connection) && !st.folded.includes(m.id) && !asked.has(m.id)) { asked.add(m.id); post({ type: 'load', machine: m.id }); }
		}
		const a = document.activeElement;
		const inForm = a && a.dataset && a.dataset.f && a.closest('[data-form]');
		const focused = inForm ? '[data-form="' + CSS.escape(inForm.dataset.form) + '"] [data-f="' + CSS.escape(a.dataset.f) + '"]'
			: a && a.dataset ? (a.dataset.act ? '[data-act="' + CSS.escape(a.dataset.act) + '"][data-id="' + CSS.escape(a.dataset.id) + '"]' + (a.dataset.dir ? '[data-dir="' + CSS.escape(a.dataset.dir) + '"]' : '') : a.dataset.key ? '[data-key="' + CSS.escape(a.dataset.key) + '"]' : a.dataset.machine ? '[data-machine="' + CSS.escape(a.dataset.machine) + '"]' : '') : '';
		const caret = inForm ? [a.selectionStart, a.selectionEnd] : null;
		const cards = visible.map(machine);
		if (editing && editing.id === '') {
			const add = el('section', 'm adding');
			add.append(connForm('', S.addConnection));
			cards.unshift(add);
		}
		list.replaceChildren(...cards);
		if (focused) { const n = list.querySelector(focused); if (n) { n.focus(); if (caret && n.setSelectionRange) { try { n.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } } } }
	}

	function openForm(id, m) {
		editing = id ? { id, host: m.host, name: m.name, folder: m.setFolder || '' } : { id: '', host: '', name: '', folder: '' };
		confirming = '';
		browsing = null;
		if (!hosts.length) { post({ type: 'hosts' }); }
		draw();
		const first = list.querySelector('[data-form="' + CSS.escape(id) + '"] input');
		if (first) { first.focus(); }
	}

	list.addEventListener('input', e => { const f = e.target.dataset && e.target.dataset.f; if (f && editing) { editing[f] = e.target.value; } });
	list.addEventListener('submit', e => {
		e.preventDefault();
		if (!editing || editing.busy) { return; }
		editing.busy = true;
		editing.error = '';
		editing.field = '';
		draw();
		post({ type: 'saveConnection', machine: editing.id, host: editing.host || '', name: editing.name || '', folder: editing.folder || '' });
	});
	list.addEventListener('keydown', e => { if (e.key === 'Escape' && editing && e.target.closest('[data-form]')) { e.preventDefault(); editing = null; draw(); } });

	function toggle(id) {
		const i = st.folded.indexOf(id);
		if (i >= 0) { st.folded.splice(i, 1); } else { st.folded.push(id); }
		save();
		draw();
	}

	document.addEventListener('click', e => {
		const t = e.target.closest('[data-act], [data-group], [data-machine], [data-key], #refresh, #connections, #addConn');
		if (!t) { return; }
		if (t.dataset.act) {
			const id = t.dataset.id, act = t.dataset.act;
			const m = model.machines.find(x => x.id === id);
			if (act === 'reconnect') { asked.delete(id); post({ type: 'reconnect', machine: id }); }
			else if (act === 'remove') { confirming = id; editing = null; browsing = null; draw(); list.querySelector('[data-act="cancel"]')?.focus(); }
			else if (act === 'cancel') { confirming = ''; draw(); }
			else if (act === 'removeYes') { confirming = ''; draw(); post({ type: 'remove', machine: id }); }
			else if (act === 'edit' && m) { openForm(id, m); }
			else if (act === 'formCancel') { editing = null; draw(); }
			else if (act === 'openFolder' && m && !m.local) { browsing = { id, dir: '', folders: [], loading: true }; editing = null; confirming = ''; draw(); post({ type: 'browse', machine: id, dir: '' }); }
			else if (act === 'browseTo') { browsing = { id, dir: t.dataset.dir, folders: [], loading: true }; draw(); list.querySelector('[data-act="browseCancel"]')?.focus(); post({ type: 'browse', machine: id, dir: t.dataset.dir }); }
			else if (act === 'browseCancel') { browsing = null; draw(); }
			else if (act === 'terminalHere' && browsing && browsing.dir) { post({ type: 'terminalAt', machine: id, dir: browsing.dir }); browsing = null; draw(); }
			else { post({ type: act, machine: id }); }
			return;
		}
		if (t.id === 'addConn') { openForm('', null); return; }
		if (t.id === 'refresh') { asked.clear(); post({ type: 'refresh' }); return; }
		if (t.id === 'connections') { post({ type: 'connections' }); return; }
		if (t.dataset.group) { st[t.dataset.group] = t.dataset.value; save(); draw(); return; }
		if (t.dataset.machine) { toggle(t.dataset.machine); return; }
		if (t.dataset.key) { post({ type: 'open', key: t.dataset.key }); }
	});
	document.addEventListener('keydown', e => {
		const t = e.target;
		if ((e.key === 'Enter' || e.key === ' ') && t.dataset && (t.dataset.key || t.dataset.machine)) { e.preventDefault(); t.click(); }
	});
	q.addEventListener('input', () => { st.query = q.value; save(); draw(); });
	window.addEventListener('message', e => {
		const m = e.data;
		if (m && m.type === 'model') {
			model = m.model;
			if (confirming && !model.machines.some(x => x.id === confirming && x.configured)) { confirming = ''; }
			if (editing && editing.id && !model.machines.some(x => x.id === editing.id && x.configured)) { editing = null; }
			if (browsing && !model.machines.some(x => x.id === browsing.id)) { browsing = null; }
			if (m.reset) { asked.clear(); }
			if (st.machine && !model.machines.some(x => x.id === st.machine)) { st.machine = ''; save(); }
			draw();
		} else if (m && m.type === 'saved' && editing && editing.id === m.machine) {
			if (m.error) { editing.busy = false; editing.error = m.error; editing.field = m.field || ''; draw(); }
			else { editing = null; draw(); }
		} else if (m && m.type === 'hosts') {
			hosts = m.hosts || [];
			if (editing) { draw(); }
		} else if (m && m.type === 'folders' && browsing && browsing.id === m.machine && (!browsing.dir || browsing.dir === m.dir)) {
			browsing = { id: m.machine, dir: m.dir, parent: m.parent || '', folders: m.folders || [], error: m.error || '', loading: false };
			draw();
		}
	});
	post({ type: 'ready' });
})();
</script></body></html>`;
}

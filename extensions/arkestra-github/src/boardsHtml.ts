/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Boards page: every board added as a mosaic of tiles (counts, done bar, the
 *  lines' progress, last read), a tile's menu (pin, GitHub, remove with an inline confirm) and
 *  the "+ Add board" tile whose form sits in the page. Styled like the Artifacts page; the
 *  bundled Inter. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import { fontFaces } from './boardHtml';
import { parseProjectRef } from './project';

/** The page's words; the extension passes them in the UI language. */
export const BOARDS_LABELS = {
	title: 'Boards',
	subtitle: 'Every GitHub Project you added, in one place',
	search: 'Search boards',
	all: 'All',
	pinned: 'Pinned',
	add: '+ Add board',
	addTitle: 'Add board',
	addHint: 'A GitHub Project by owner/number or its URL',
	placeholder: 'owner/number or project URL',
	invalid: 'owner/number, e.g. tenarkhq/3, or https://github.com/orgs/<org>/projects/<n>',
	already: 'This board is already here.',
	addButton: 'Add',
	cancel: 'Cancel',
	yours: 'Your projects',
	listing: 'Reading your projects…',
	listError: 'Your projects could not be listed: {0}',
	closed: 'closed',
	items: 'items',
	open: 'open',
	done: 'done',
	read: 'read {0}',
	unread: 'not read yet',
	reading: 'reading…',
	failed: 'could not be read: {0}',
	workspace: 'this workspace',
	pinnedTag: 'pinned',
	pin: 'Pin',
	unpin: 'Unpin',
	github: 'Open on GitHub',
	remove: 'Remove',
	confirm: 'Remove “{0}” from Boards? The project stays on GitHub.',
	more: 'More actions',
	moreLanes: '+{0} more',
	empty: 'No boards yet',
	emptyText: 'Add a GitHub Project to follow its work here: what is open, what is done and how far each line is.',
	noMatch: 'Nothing matches the search.',
};

export type BoardsLabels = typeof BOARDS_LABELS;

const STYLE = `
:root { --fg: var(--vscode-foreground); --mute: var(--vscode-descriptionForeground); --dim: color-mix(in srgb, var(--vscode-descriptionForeground) 75%, transparent); --line: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.25))); --tile: color-mix(in srgb, var(--vscode-foreground) 3%, var(--vscode-editor-background)); --hover: color-mix(in srgb, var(--vscode-foreground) 6%, var(--vscode-editor-background)); --sel: var(--vscode-list-inactiveSelectionBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent)); --ok: var(--vscode-testing-iconPassed, #4cc38a); --donebar: color-mix(in srgb, var(--ok) 72%, transparent); --track: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); --danger: var(--vscode-errorForeground, #e07a7a); }
* { box-sizing: border-box; }
body { margin: 0; color: var(--fg); background: var(--vscode-editor-background); font: 400 13px/1.45 "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
button, input { font: inherit; color: inherit; }
.page { padding: 28px 32px 40px; display: grid; gap: 16px; align-content: start; }
h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
.mut { color: var(--mute); }
.sub { color: var(--mute); margin-top: 2px; }
.tools { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
input[type=search], .field { height: 30px; padding: 0 10px; border-radius: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--line)); outline: none; }
input[type=search] { width: 280px; max-width: 100%; }
input:focus { border-color: var(--vscode-focusBorder); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--line); background: none; cursor: pointer; font-size: 12.5px; }
.chip.on { background: var(--sel); border-color: transparent; }
.chip em { font-style: normal; color: var(--dim); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.tile { position: relative; border: 1px solid var(--line); border-radius: 12px; background: var(--tile); padding: 14px 16px 12px; display: flex; flex-direction: column; gap: 8px; min-height: 172px; min-width: 0; cursor: pointer; text-align: left; outline: none; }
.tile:hover, .tile:focus-visible { background: var(--hover); border-color: color-mix(in srgb, var(--vscode-foreground) 22%, transparent); }
.top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.top svg { width: 16px; height: 16px; flex: none; color: var(--mute); }
.name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.pin { color: var(--mute); display: inline-flex; }
.pin svg { width: 13px; height: 13px; }
.more { width: 26px; height: 26px; border: 0; border-radius: 6px; background: none; color: var(--mute); cursor: pointer; display: grid; place-items: center; flex: none; font-size: 16px; line-height: 1; }
.more:hover, .more.on { background: var(--sel); color: var(--fg); }
.ref { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.counts { display: flex; gap: 14px; align-items: baseline; font-size: 12.5px; color: var(--mute); }
.counts b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; margin-right: 3px; }
.counts .pct { margin-left: auto; color: var(--fg); font-variant-numeric: tabular-nums; }
.bar { height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
.bar i, .mini i { display: block; height: 100%; width: 0; background: var(--donebar); border-radius: inherit; }
.lanes { display: grid; gap: 4px; margin-top: 2px; }
.lane { display: grid; grid-template-columns: minmax(0, 1fr) 72px 38px; gap: 8px; align-items: center; font-size: 12px; }
.lane .ln { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lane.rel .ln { color: var(--mute); }
.mini { height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; }
.lane .lp { text-align: right; color: var(--mute); font-variant-numeric: tabular-nums; }
.foot { margin-top: auto; font-size: 11.5px; color: var(--dim); display: flex; gap: 6px; align-items: center; }
.foot.err { color: var(--danger); }
.foot .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.menu { position: absolute; z-index: 5; top: 42px; right: 10px; min-width: 188px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--fg)); border: 1px solid var(--vscode-menu-border, var(--line)); border-radius: 10px; padding: 5px; box-shadow: 0 10px 30px var(--vscode-widget-shadow, rgba(0,0,0,.35)); display: flex; flex-direction: column; cursor: default; }
.mi { height: 30px; display: flex; align-items: center; padding: 0 10px; border-radius: 6px; border: 0; background: none; cursor: pointer; text-align: left; font-size: 13px; }
.mi:hover { background: var(--vscode-menu-selectionBackground, var(--sel)); color: var(--vscode-menu-selectionForeground, inherit); }
.mi.danger { color: var(--danger); }
.mi:disabled { opacity: .45; cursor: default; }
.msep { height: 1px; background: var(--line); margin: 4px 2px; }
.confirm { gap: 10px; justify-content: center; cursor: default; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--line); background: none; cursor: pointer; font-size: 12.5px; }
.btn:hover { background: var(--sel); }
.btn.pri { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 500; }
.btn.pri:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
.btn.danger { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); border-color: transparent; font-weight: 500; }
.add { border-style: dashed; background: none; justify-content: center; align-items: center; gap: 4px; color: var(--mute); }
.add .plus { font-size: 15px; color: var(--fg); font-weight: 500; }
.add.form { justify-content: flex-start; align-items: stretch; cursor: default; border-style: solid; background: var(--tile); color: var(--fg); gap: 8px; }
.add.form:hover { background: var(--tile); }
.err { color: var(--danger); font-size: 12px; min-height: 0; }
.err:empty { display: none; }
.list { display: grid; gap: 2px; max-height: 190px; overflow: auto; }
.pick { display: flex; justify-content: space-between; gap: 10px; align-items: center; height: 30px; padding: 0 8px; border: 0; border-radius: 6px; background: none; cursor: pointer; text-align: left; }
.pick:hover { background: var(--sel); }
.pick span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick span:last-child { color: var(--dim); font-size: 12px; white-space: nowrap; }
.label { font-size: 12px; color: var(--mute); margin-top: 4px; }
.empty { border: 1px solid var(--line); border-radius: 12px; padding: 22px 24px; display: grid; gap: 6px; max-width: 640px; }
.empty b { font-size: 15px; font-weight: 600; }
`;

const ICON_BOARD = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="3.5" height="10" rx="1"/><rect x="6.5" y="3" width="3.5" height="7" rx="1"/><rect x="11" y="3" width="3" height="5" rx="1"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 2h4l-.6 4.2L12 8.5V10H4V8.5l2.6-2.3z"/><path d="M8 10v4"/></svg>';

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const L = __LABELS__;
const ICON_BOARD = __ICON_BOARD__;
const ICON_PIN = __ICON_PIN__;
__PARSE__
const boardKey = text => { const r = parseProjectRef(String(text || '')); return r ? r.owner.toLowerCase() + '/' + r.number : undefined; };
const st = Object.assign({ query: '', scope: 'all', owners: [] }, vscode.getState() || {});
let tiles = [];
let loaded = false;
let menu, confirmKey, form = false, addText = '', addError = '', projects;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (text, v) => String(text).replace('{0}', v);
const save = () => vscode.setState({ query: st.query, scope: st.scope, owners: st.owners });
const post = m => vscode.postMessage(m);
const ownerOf = t => t.ref.split('/')[0];
function when(ms) {
	const d = new Date(ms);
	const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	return new Date().toDateString() === d.toDateString() ? hm : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm;
}
function visible() {
	const q = st.query.trim().toLowerCase();
	return tiles
		.filter(t => st.scope !== 'pinned' || t.pinned)
		.filter(t => !st.owners.length || st.owners.includes(ownerOf(t).toLowerCase()))
		.filter(t => !q || t.title.toLowerCase().includes(q) || t.ref.toLowerCase().includes(q))
		.map((t, i) => [t, i]).sort((a, b) => (b[0].pinned - a[0].pinned) || (b[0].workspace - a[0].workspace) || (a[1] - b[1])).map(x => x[0]);
}
function laneRows(t) {
	if (!t.lanes.length) return '';
	// The lines with work left come first when not all fit; shown in their own order.
	const order = [...t.lanes.filter(l => !l.released), ...t.lanes.filter(l => l.released)];
	const keep = new Set(order.slice(0, 4));
	const shown = t.lanes.filter(l => keep.has(l));
	return '<div class="lanes">' + shown.map(l => '<div class="lane' + (l.released ? ' rel' : '') + '" title="' + esc(l.name + ' · ' + l.done + '/' + l.total) + '"><span class="ln">' + esc(l.name) + '</span><span class="mini"><i data-w="' + l.percent + '"></i></span><span class="lp">' + l.percent + '%</span></div>').join('')
		+ (order.length > shown.length ? '<div class="lane rel"><span class="ln">' + esc(fill(L.moreLanes, order.length - shown.length)) + '</span></div>' : '') + '</div>';
}
function foot(t) {
	if (t.state === 'error') return '<div class="foot err">' + esc(fill(L.failed, t.error || '')) + '</div>';
	if (t.state === 'reading') return '<div class="foot">' + esc(L.reading) + '</div>';
	if (!t.readAt) return '<div class="foot">' + esc(L.unread) + '</div>';
	return '<div class="foot">' + esc(fill(L.read, when(t.readAt))) + '</div>';
}
function tile(t) {
	const k = esc(t.key);
	if (confirmKey === t.key) {
		return '<div class="tile confirm" data-key="' + k + '"><div>' + esc(fill(L.confirm, t.title)) + '</div><div class="row"><button class="btn danger" data-act="removeYes" data-key="' + k + '">' + esc(L.remove) + '</button><button class="btn" data-act="removeNo">' + esc(L.cancel) + '</button></div></div>';
	}
	const tags = [t.ref, t.workspace ? L.workspace : '', t.pinned ? L.pinnedTag : ''].filter(Boolean).join(' · ');
	return '<div class="tile" tabindex="0" data-open="' + k + '">'
		+ '<div class="top">' + ICON_BOARD + '<span class="name">' + esc(t.title) + '</span>' + (t.pinned ? '<span class="pin" title="' + esc(L.pinnedTag) + '">' + ICON_PIN + '</span>' : '')
		+ '<button class="more' + (menu === t.key ? ' on' : '') + '" data-act="menu" data-key="' + k + '" title="' + esc(L.more) + '" aria-label="' + esc(L.more) + '">⋯</button></div>'
		+ '<div class="ref mut">' + esc(tags) + '</div>'
		+ (t.readAt || t.items ? '<div class="counts"><span><b>' + t.items + '</b>' + esc(L.items) + '</span><span><b>' + t.open + '</b>' + esc(L.open) + '</span><span><b>' + t.done + '</b>' + esc(L.done) + '</span><span class="pct">' + t.percent + '%</span></div>'
			+ '<div class="bar" title="' + esc(t.done + ' / ' + t.items + ' ' + L.done) + '"><i data-w="' + t.percent + '"></i></div>' + laneRows(t) : '')
		+ foot(t)
		+ (menu === t.key ? '<div class="menu" role="menu">'
			+ '<button class="mi" data-act="pin" data-key="' + k + '">' + esc(t.pinned ? L.unpin : L.pin) + '</button>'
			+ '<button class="mi" data-act="github" data-key="' + k + '"' + (t.url ? '' : ' disabled') + '>' + esc(L.github) + '</button>'
			+ (t.workspace ? '' : '<div class="msep"></div><button class="mi danger" data-act="remove" data-key="' + k + '">' + esc(L.remove) + '</button>')
			+ '</div>' : '')
		+ '</div>';
}
function addTile() {
	if (!form) return '<button class="tile add" data-act="addOpen"><span class="plus">' + esc(L.add) + '</span><span>' + esc(L.addHint) + '</span></button>';
	return '<div class="tile add form" data-form="1"><b>' + esc(L.addTitle) + '</b>'
		+ '<input class="field" id="addIn" spellcheck="false" placeholder="' + esc(L.placeholder) + '" value="' + esc(addText) + '">'
		+ '<div class="err" id="addErr">' + esc(addError) + '</div>'
		+ '<div class="row"><button class="btn pri" data-act="addGo">' + esc(L.addButton) + '</button><button class="btn" data-act="addCancel">' + esc(L.cancel) + '</button></div>'
		+ '<div class="label">' + esc(L.yours) + '</div><div class="list" id="addList">' + projectRows() + '</div></div>';
}
function projectRows() {
	if (!projects) return '<div class="mut">' + esc(L.listing) + '</div>';
	if (projects.error) return '<div class="mut">' + esc(fill(L.listError, projects.error)) + '</div>';
	const have = new Set(tiles.map(t => t.key));
	const q = addText.trim().toLowerCase();
	const typed = boardKey(addText);
	return projects.choices
		.map(p => ({ p, key: p.owner.toLowerCase() + '/' + p.number }))
		.filter(x => !have.has(x.key) && (!q || x.key === typed || x.p.title.toLowerCase().includes(q) || x.key.includes(q)))
		.slice(0, 50)
		.map(x => '<button class="pick" data-act="addPick" data-key="' + esc(x.key) + '"><span>' + esc(x.p.title) + '</span><span>' + esc(x.p.owner + '/' + x.p.number + (x.p.closed ? ' · ' + L.closed : '')) + '</span></button>').join('');
}
function widths() {
	if (!document.querySelectorAll) return;
	document.querySelectorAll('[data-w]').forEach(e => { e.style.width = Math.max(0, Math.min(100, Number(e.dataset.w) || 0)) + '%'; });
}
function draw() {
	const owners = [...new Set(tiles.map(t => ownerOf(t).toLowerCase()))];
	const shown = visible();
	const pinnedCount = tiles.filter(t => t.pinned).length;
	const chip = (label, on, attrs, n) => '<button class="chip' + (on ? ' on' : '') + '" ' + attrs + '>' + esc(label) + (n !== undefined ? ' <em>' + n + '</em>' : '') + '</button>';
	document.getElementById('root').innerHTML = '<div class="page"><header><h1>' + esc(L.title) + '</h1><div class="sub">' + esc(L.subtitle) + '</div></header>'
		+ (tiles.length ? '<div class="tools"><input type="search" id="q" placeholder="' + esc(L.search) + '" value="' + esc(st.query) + '"><div class="chips">'
			+ chip(L.all, st.scope === 'all', 'data-act="scope" data-v="all"', tiles.length)
			+ chip(L.pinned, st.scope === 'pinned', 'data-act="scope" data-v="pinned"', pinnedCount)
			+ (owners.length > 1 ? owners.map(o => chip(o, st.owners.includes(o), 'data-act="owner" data-v="' + esc(o) + '"')).join('') : '')
			+ '</div></div>' : '')
		+ (loaded && !tiles.length ? '<div class="empty"><b>' + esc(L.empty) + '</b><span class="mut">' + esc(L.emptyText) + '</span></div>' : '')
		+ (tiles.length && !shown.length ? '<div class="mut">' + esc(L.noMatch) + '</div>' : '')
		+ '<div class="grid">' + shown.map(tile).join('') + addTile() + '</div></div>';
	widths();
}
function openForm() {
	form = true; addError = '';
	if (!projects) post({ type: 'projects' });
	draw();
	const i = document.getElementById('addIn'); if (i && i.focus) i.focus();
}
function closeForm() { form = false; addText = ''; addError = ''; draw(); }
function submit(key) {
	if (!key) { addError = L.invalid; draw(); return; }
	if (tiles.some(t => t.key === key)) { addError = L.already; draw(); return; }
	post({ type: 'add', key });
}
document.addEventListener('click', e => {
	const a = e.target.closest ? e.target.closest('[data-act]') : null;
	if (a) {
		const act = a.dataset.act, key = a.dataset.key;
		if (act === 'menu') { menu = menu === key ? undefined : key; confirmKey = undefined; draw(); return; }
		menu = undefined;
		if (act === 'scope') { st.scope = a.dataset.v; save(); draw(); return; }
		if (act === 'owner') { const v = a.dataset.v; const i = st.owners.indexOf(v); i >= 0 ? st.owners.splice(i, 1) : st.owners.push(v); save(); draw(); return; }
		if (act === 'pin') { post({ type: 'pin', key }); draw(); return; }
		if (act === 'github') { post({ type: 'github', key }); draw(); return; }
		if (act === 'remove') { confirmKey = key; draw(); return; }
		if (act === 'removeYes') { confirmKey = undefined; post({ type: 'remove', key }); draw(); return; }
		if (act === 'removeNo') { confirmKey = undefined; draw(); return; }
		if (act === 'addOpen') { openForm(); return; }
		if (act === 'addCancel') { closeForm(); return; }
		if (act === 'addGo') { submit(boardKey(addText)); return; }
		if (act === 'addPick') { submit(key); return; }
		return;
	}
	if (e.target.closest && e.target.closest('.menu,.confirm,[data-form]')) return;
	const t = e.target.closest ? e.target.closest('[data-open]') : null;
	if (menu !== undefined) { menu = undefined; draw(); if (!t) return; }
	if (t) post({ type: 'open', key: t.dataset.open });
});
document.addEventListener('keydown', e => {
	if (e.key === 'Escape') { if (form) closeForm(); else if (menu !== undefined || confirmKey !== undefined) { menu = undefined; confirmKey = undefined; draw(); } return; }
	if (e.key !== 'Enter') return;
	if (e.target.id === 'addIn') { e.preventDefault && e.preventDefault(); submit(boardKey(addText)); return; }
	if (e.target.dataset && e.target.dataset.open) post({ type: 'open', key: e.target.dataset.open });
});
document.addEventListener('input', e => {
	if (e.target.id === 'q') { st.query = e.target.value; save(); const pos = e.target.selectionStart; draw(); const q = document.getElementById('q'); if (q && q.focus) { q.focus(); if (q.setSelectionRange) q.setSelectionRange(pos, pos); } return; }
	if (e.target.id === 'addIn') {
		addText = e.target.value;
		addError = addText.trim() && !boardKey(addText) && !(projects && projects.choices && projects.choices.length) ? L.invalid : '';
		const err = document.getElementById('addErr'); if (err) err.innerHTML = esc(addError);
		const list = document.getElementById('addList'); if (list) list.innerHTML = projectRows();
	}
});
window.addEventListener('message', e => {
	const m = e.data;
	if (m.type === 'data') { tiles = m.tiles; loaded = true; if (menu && !tiles.some(t => t.key === menu)) menu = undefined; if (m.openForm && !form) { openForm(); return; } draw(); }
	if (m.type === 'projects') { projects = { choices: m.choices || [], error: m.error }; if (form) { const list = document.getElementById('addList'); if (list) list.innerHTML = projectRows(); } }
	if (m.type === 'added') { closeForm(); }
	if (m.type === 'addError') { addError = String(m.text || ''); if (form) { const err = document.getElementById('addErr'); if (err) err.innerHTML = esc(addError); } }
});
draw();
post({ type: 'ready' });
`;

/** The page; `fonts`: the webview address of media/fonts (none: the system's sans). */
export function boardsHtml(nonce: string, cspSource: string, labels: Partial<BoardsLabels> = {}, fonts?: string): string {
	const words = JSON.stringify({ ...BOARDS_LABELS, ...labels }).replace(/</g, '\\u003c');
	const script = SCRIPT
		.replace('__LABELS__', () => words)
		.replace('__ICON_BOARD__', () => JSON.stringify(ICON_BOARD))
		.replace('__ICON_PIN__', () => JSON.stringify(ICON_PIN))
		.replace('__PARSE__', () => parseProjectRef.toString());
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}';${fonts ? ` font-src ${cspSource};` : ''} script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Boards</title>
<style nonce="${nonce}">${fontFaces(fonts)}${STYLE}</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

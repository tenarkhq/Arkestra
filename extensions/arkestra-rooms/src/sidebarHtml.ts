/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar's page: a flat list like the Claude app. The top items, Pinned, the
 *  user's own sections, then every thread and CLI session of the machines grouped by agent
 *  (Claude, Codex, ...), then the archived ones folded. Colours come from the theme; the layout,
 *  spacing and type sizes from the approved render.
 *--------------------------------------------------------------------------------------------*/

import { fontFaces, fontSrc, TYPE_CSS, type PageFonts } from './fonts';

/** One row: a thread, a CLI session no thread continues yet, a pinned board or a pinned artifact. */
export interface SidebarRow {
	/** `thread:<id>`, `session:<agentId>\n<sessionId>`, `board:<key>`, `artifact:<key>`; selection and clicks use it. */
	readonly key: string;
	readonly kind: 'thread' | 'session' | 'board' | 'artifact';
	/** A thread's id; a session's `<agentId>\n<sessionId>` (opening or moving it continues it first). */
	readonly id: string;
	readonly title: string;
	readonly tip?: string;
	readonly running?: boolean;
	readonly pinned?: boolean;
	readonly archived?: boolean;
	/** The section the thread is in. */
	readonly section?: string;
	/** The machine it runs on, only while rows of several machines show. */
	readonly machine?: string;
}

/** One agent's group of the default listing; `older`: past the recent window, behind "Show older". */
export interface SidebarGroup {
	readonly id: string;
	readonly name: string;
	readonly rows: readonly SidebarRow[];
	readonly older: readonly SidebarRow[];
}

export interface SidebarModel {
	/** Machines known to the Connections extension, this one included. */
	readonly machines: number;
	readonly query: string;
	readonly selected?: string;
	readonly pinned: readonly SidebarRow[];
	readonly sections: readonly { readonly id: string; readonly name: string; readonly rows: readonly SidebarRow[] }[];
	/** Every thread and session in no section and not pinned, by agent. */
	readonly groups: readonly SidebarGroup[];
	readonly archived: readonly SidebarRow[];
	/** No thread and no session at all yet. */
	readonly empty: boolean;
}

export interface SidebarStrings {
	readonly newChat: string;
	readonly search: string;
	readonly searchPlaceholder: string;
	readonly boards: string;
	readonly artifacts: string;
	readonly machines: string;
	readonly pinned: string;
	readonly newSection: string;
	readonly archived: string;
	/** `Show older ({0})`. */
	readonly showOlder: string;
	readonly showFewer: string;
	readonly noChats: string;
	readonly noMatch: string;
	readonly more: string;
	readonly running: string;
	readonly moveTo: string;
	readonly noSection: string;
	readonly newSectionMenu: string;
	readonly sectionName: string;
	readonly pin: string;
	readonly unpin: string;
	readonly rename: string;
	readonly archive: string;
	readonly restore: string;
	readonly delete: string;
	readonly renameSection: string;
	readonly moveUp: string;
	readonly moveDown: string;
	readonly deleteSection: string;
}

/** What the page sends back. */
export type SidebarMessage =
	| { type: 'ready' }
	| { type: 'nav'; item: 'newChat' | 'boards' | 'artifacts' | 'machines' }
	| { type: 'open'; key: string }
	| { type: 'thread'; action: 'pin' | 'unpin' | 'rename' | 'archive' | 'unarchive' | 'delete'; id: string; name?: string }
	| { type: 'move'; id: string; section: string | null }
	| { type: 'moveToNew'; id: string; name: string }
	| { type: 'section'; action: 'new' | 'rename' | 'delete' | 'up' | 'down'; id?: string; name?: string }
	| { type: 'reorder'; id: string; before: string | null }
	| { type: 'search'; query: string };

const ICONS = {
	plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3v10M3 8h10"/></svg>',
	search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>',
	board: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="3.5" height="10" rx="1"/><rect x="6.5" y="3" width="3.5" height="7" rx="1"/><rect x="11" y="3" width="3" height="5" rx="1"/></svg>',
	artifact: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>',
	machine: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="7" rx="1.5"/><path d="M5.5 13h5M8 10v3"/></svg>',
};

function esc(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

export function sidebarHtml(nonce: string, s: SidebarStrings, fonts?: PageFonts): string {
	const strings = JSON.stringify(s).replace(/</g, '\\u003c');
	const nav = (id: string, icon: string, label: string, extra = '') =>
		`<div class="it${id === 'newChat' ? ' new' : ''}" role="button" tabindex="${id === 'newChat' ? 0 : -1}" data-nav="${id}" data-key="nav:${id}">${icon}<span class="n">${esc(label)}</span>${extra}</div>`;
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';${fontSrc(fonts)} script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${fontFaces(fonts)}
	:root {
		--fg: var(--vscode-sideBar-foreground, var(--vscode-foreground));
		--mute: var(--vscode-descriptionForeground);
		--dim: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, transparent);
		--hover: var(--vscode-list-hoverBackground);
		--sel: var(--vscode-list-inactiveSelectionBackground);
		--accent: var(--vscode-progressBar-background);
	}
	html, body { margin: 0; padding: 0; background: var(--vscode-sideBar-background); color: var(--fg); }
	body { ${TYPE_CSS} font-size: 13px; font-weight: 400; padding: 10px 8px 16px; user-select: none; -webkit-user-select: none; }
	#nav, #list { display: flex; flex-direction: column; gap: 2px; }
	.it { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 10px; border-radius: 7px; color: var(--fg); white-space: nowrap; overflow: hidden; cursor: pointer; outline: none; flex: none; }
	.it:hover, .it.menu-open { background: var(--hover); }
	.it.sel { background: var(--sel); }
	.it:focus-visible, .proj:focus-visible, .sec.fold:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.it svg { width: 16px; height: 16px; flex: none; color: var(--mute); }
	.it .n { overflow: hidden; text-overflow: ellipsis; flex: 1; }
	.it .k { color: var(--dim); font-size: 11.5px; }
	.it .m { flex: none; max-width: 36%; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
	.it.new { font-weight: 500; }
	.it .run, .it .gap { width: 7px; height: 7px; border-radius: 50%; flex: none; }
	.it .run { background: var(--accent); }
	.it .more { visibility: hidden; color: var(--dim); width: 18px; text-align: center; border-radius: 4px; flex: none; }
	.it .more:hover { color: var(--fg); }
	.it:hover .more, .it.menu-open .more, .it:focus-visible .more { visibility: visible; }
	.it.muted, .it.muted .n { color: var(--mute); }
	.it.add { color: var(--dim); }
	.it.add svg { color: var(--dim); }
	.it.older { color: var(--dim); font-size: 12px; height: 28px; padding-left: 27px; }
	.ed { flex: 1; min-width: 0; height: 24px; padding: 0 7px; font: inherit; color: var(--fg); background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder); border-radius: 6px; outline: none; }
	.q { display: none; flex: 1; min-width: 0; border: 0; padding: 0; background: transparent; color: var(--fg); font: inherit; outline: none; }
	.q::placeholder { color: var(--dim); }
	.it.on { background: var(--vscode-input-background); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); cursor: text; }
	.it.on .n { display: none; }
	.it.on .q { display: block; }
	.sec { display: flex; align-items: center; justify-content: space-between; color: var(--dim); font-size: 12px; padding: 16px 10px 6px; border-radius: 6px; }
	.sec.fold { cursor: pointer; outline: none; }
	.sec.fold:hover { color: var(--mute); }
	.proj { color: var(--mute); font-size: 12.5px; font-weight: 500; padding: 12px 10px 4px; display: flex; justify-content: space-between; align-items: center; gap: 8px; border-radius: 6px; outline: none; }
	.proj .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.proj .more { color: var(--dim); cursor: pointer; padding: 0 2px; border-radius: 4px; }
	.proj .more:hover { color: var(--fg); }
	.drop { background: var(--vscode-list-dropBackground, var(--hover)); }
	.empty { color: var(--dim); padding: 10px; line-height: 1.5; }
	.menu { position: fixed; z-index: 5; min-width: 180px; max-width: calc(100% - 8px); box-sizing: border-box; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent)); border-radius: 10px; padding: 5px; box-shadow: 0 10px 30px var(--vscode-widget-shadow, rgba(0, 0, 0, .45)); display: flex; flex-direction: column; }
	.mi { display: flex; justify-content: space-between; align-items: center; gap: 12px; height: 30px; padding: 0 10px; border-radius: 6px; cursor: pointer; outline: none; white-space: nowrap; }
	.mi .l { overflow: hidden; text-overflow: ellipsis; }
	.mi:hover, .mi:focus { background: var(--vscode-menu-selectionBackground, var(--sel)); color: var(--vscode-menu-selectionForeground, inherit); }
	.mi .s { color: var(--mute); }
	.mi.back { color: var(--mute); }
	.mi.danger { color: var(--vscode-errorForeground); }
	.msep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border, transparent)); margin: 4px 2px; }
</style></head><body>
<div id="nav">
	${nav('newChat', ICONS.plus, s.newChat)}
	${nav('search', ICONS.search, s.search, `<input class="q" type="text" spellcheck="false" placeholder="${esc(s.searchPlaceholder)}" aria-label="${esc(s.search)}">`)}
	${nav('boards', ICONS.board, s.boards)}
	${nav('artifacts', ICONS.artifact, s.artifacts)}
	${nav('machines', ICONS.machine, s.machines, '<span class="k" id="machines"></span>')}
</div>
<div id="list"></div>
<template id="i-board">${ICONS.board}</template>
<template id="i-artifact">${ICONS.artifact}</template>
<template id="i-plus">${ICONS.plus}</template>
<script type="application/json" id="l10n" nonce="${nonce}">${strings}</script>
<script nonce="${nonce}">
(() => {
	const vscode = acquireVsCodeApi();
	const S = JSON.parse(document.getElementById('l10n').textContent);
	const list = document.getElementById('list');
	const search = document.querySelector('[data-nav="search"]');
	const input = search.querySelector('.q');
	const ui = Object.assign({ archivedOpen: false, olderOpen: {} }, vscode.getState() || {});
	const T_THREAD = 'application/x-arkestra-thread';
	const T_SECTION = 'application/x-arkestra-section';
	let model;
	let rows = new Map();
	let menu, menuKey;
	let dragging = '';
	let pending = false;
	let hovering = false;
	let typing;

	const post = m => vscode.postMessage(m);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; };
	const icon = name => document.getElementById('i-' + name).content.firstElementChild.cloneNode(true);
	const keyOf = e => e && (e.dataset.key || (e.dataset.section ? 'section:' + e.dataset.section : e.dataset.action ? 'action:' + e.dataset.action : ''));
	const focusables = () => [...document.querySelectorAll('.it, .proj, .sec.fold')];

	function row(r, muted) {
		const it = el('div', 'it' + (muted ? ' muted' : ''));
		it.tabIndex = -1;
		it.setAttribute('role', 'button');
		it.dataset.key = r.key;
		it.dataset.kind = r.kind;
		it.dataset.id = r.id;
		const chat = r.kind === 'thread' || r.kind === 'session';
		if (chat) {
			const dot = el('span', r.running ? 'run' : 'gap');
			if (r.running) { dot.title = S.running; }
			it.append(dot);
			it.draggable = true;
			it.dataset.menu = '1';
		} else {
			it.append(icon(r.kind));
		}
		it.append(el('span', 'n', r.title));
		if (r.machine) { it.append(el('span', 'k m', r.machine)); }
		it.title = r.tip || r.title;
		if (chat) {
			const more = el('span', 'more', '⋯');
			more.setAttribute('role', 'button');
			more.setAttribute('aria-label', S.more);
			it.append(more);
		}
		rows.set(r.key, r);
		return it;
	}

	function header(text, drop) {
		const h = el('div', 'sec');
		h.append(el('span', '', text));
		if (drop !== undefined) { h.dataset.drop = drop; }
		return h;
	}

	function sectionHeader(s) {
		const h = el('div', 'proj');
		h.tabIndex = -1;
		h.draggable = true;
		h.dataset.section = s.id;
		h.dataset.drop = s.id;
		h.append(el('span', 'n', s.name));
		const more = el('span', 'more', '⋯');
		more.setAttribute('role', 'button');
		more.setAttribute('aria-label', S.more);
		h.append(more);
		return h;
	}

	// ---- a name typed in place (new section, rename): no input box at the top of the window
	let editing = false;
	function editName(host, initial, done) {
		const input = document.createElement('input');
		input.className = 'ed';
		input.type = 'text';
		input.spellcheck = false;
		input.value = initial || '';
		input.placeholder = S.sectionName;
		const n = host.querySelector('.n');
		if (n) { n.replaceWith(input); } else { host.append(input); }
		const more = host.querySelector('.more');
		if (more) { more.style.display = 'none'; }
		editing = true;
		let finished = false;
		const finish = ok => {
			if (finished) { return; }
			finished = true;
			editing = false;
			pending = false;
			const value = input.value.trim();
			if (ok && value && value !== (initial || '')) { done(value); }
			render();
		};
		input.addEventListener('keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter') { e.preventDefault(); finish(true); }
			else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
		});
		input.addEventListener('blur', () => finish(true));
		input.addEventListener('click', e => e.stopPropagation());
		input.focus();
		input.select();
	}
	const addRow = () => document.querySelector('.it.add');

	function render() {
		if (!model) { return; }
		if (dragging || editing) { pending = true; return; }
		const focused = keyOf(document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-key], [data-section], [data-action]'));
		const q = model.query;
		rows = new Map();
		const out = document.createDocumentFragment();
		if (model.pinned.length) {
			out.append(header(S.pinned));
			model.pinned.forEach(r => out.append(row(r)));
		}
		for (const s of model.sections) {
			if (q && !s.rows.length) { continue; }
			out.append(sectionHeader(s));
			s.rows.forEach(r => out.append(row(r)));
		}
		if (!q) {
			const add = el('div', 'it add');
			add.tabIndex = -1;
			add.setAttribute('role', 'button');
			add.dataset.action = 'newSection';
			add.append(icon('plus'), el('span', 'n', S.newSection));
			out.append(add);
		}
		// The default listing, by agent; a header takes a row dragged out of its section back here.
		for (const g of model.groups) {
			out.append(header(g.name, ''));
			g.rows.forEach(r => out.append(row(r)));
			if (g.older.length) {
				const open = !!ui.olderOpen[g.id];
				if (open) { g.older.forEach(r => out.append(row(r))); }
				const more = el('div', 'it older', open ? S.showFewer : S.showOlder.replace('{0}', String(g.older.length)));
				more.tabIndex = -1;
				more.setAttribute('role', 'button');
				more.setAttribute('aria-expanded', String(open));
				more.dataset.action = 'older:' + g.id;
				out.append(more);
			}
		}
		if (model.archived.length) {
			const open = !!q || ui.archivedOpen;
			const h = header(S.archived);
			h.classList.add('fold');
			h.tabIndex = -1;
			h.setAttribute('role', 'button');
			h.setAttribute('aria-expanded', String(open));
			h.dataset.action = 'archived';
			h.append(el('span', 'k', String(model.archived.length)));
			out.append(h);
			if (open) { model.archived.forEach(r => out.append(row(r, true))); }
		}
		const any = model.pinned.length || model.groups.length || model.archived.length || model.sections.some(s => s.rows.length);
		if (q && !any) {
			out.append(el('div', 'empty', S.noMatch));
		} else if (!q && model.empty) {
			out.append(el('div', 'empty', S.noChats));
		}
		list.replaceChildren(out);
		document.getElementById('machines').textContent = model.machines ? String(model.machines) : '';
		if (!q && input.value && document.activeElement !== input) { stopSearch(false); }
		markSelected();
		if (menuKey) { focusables().find(e => keyOf(e) === menuKey)?.classList.add('menu-open'); }
		const again = focused && focusables().find(e => keyOf(e) === focused);
		roving(again || document.querySelector('.it.sel') || document.querySelector('[data-nav="newChat"]'));
		if (again && !menu && document.activeElement !== input) { again.focus({ preventScroll: true }); }
	}

	function roving(target) {
		for (const e of focusables()) { e.tabIndex = e === target ? 0 : -1; }
	}

	function markSelected() {
		for (const e of document.querySelectorAll('.it.sel')) { e.classList.remove('sel'); }
		const key = model && model.selected;
		if (key) { document.querySelector('.it[data-key="' + CSS.escape(key) + '"]')?.classList.add('sel'); }
	}

	// ---- search, in place
	function startSearch() {
		search.classList.add('on');
		input.focus();
	}
	function stopSearch(send) {
		const had = input.value;
		input.value = '';
		search.classList.remove('on');
		if (send && had) { post({ type: 'search', query: '' }); }
	}
	input.addEventListener('input', () => {
		clearTimeout(typing);
		typing = setTimeout(() => post({ type: 'search', query: input.value }), 60);
	});
	input.addEventListener('keydown', e => {
		if (e.key === 'Escape') { e.preventDefault(); stopSearch(true); search.focus(); }
		if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('.it')?.focus(); }
		e.stopPropagation();
	});
	input.addEventListener('blur', () => { if (!input.value) { stopSearch(true); } });

	// ---- menus: the row's and the section's; a submenu opens in place (the bar is narrow)
	function closeMenu(reopen) {
		if (!menu) { return; }
		menu.remove();
		menu = undefined;
		for (const e of document.querySelectorAll('.menu-open')) { e.classList.remove('menu-open'); }
		const owner = menuKey && focusables().find(e => keyOf(e) === menuKey);
		menuKey = undefined;
		owner?.focus({ preventScroll: true });
		if (!reopen) { flush(); }
	}

	function openMenu(items, at, owner) {
		closeMenu(true);
		menu = el('div', 'menu');
		menu.setAttribute('role', 'menu');
		menuKey = keyOf(owner);
		owner.classList.add('menu-open');
		document.body.append(menu);
		const show = entries => {
			menu.replaceChildren();
			for (const i of entries) {
				if (i.sep) { menu.append(el('div', 'msep')); continue; }
				const m = el('div', 'mi' + (i.danger ? ' danger' : '') + (i.back ? ' back' : ''));
				m.setAttribute('role', 'menuitem');
				m.tabIndex = -1;
				m.append(el('span', 'l', i.label));
				if (i.sub) { m.append(el('span', 's', '›')); }
				if (i.check) { m.append(el('span', 's', '✓')); }
				m.addEventListener('click', ev => {
					ev.stopPropagation();
					if (i.sub) { show(i.sub()); return; }
					closeMenu();
					i.run();
				});
				menu.append(m);
			}
			const w = menu.offsetWidth, h = menu.offsetHeight;
			// The page's usable width and height: innerWidth counts the scrollbar, which would cover the menu's edge.
			const vw = document.documentElement.clientWidth || innerWidth, vh = document.documentElement.clientHeight || innerHeight;
			const left = Math.max(4, Math.min(at.left, vw - w - 4));
			let top = at.bottom + 2;
			if (top + h > vh - 4) { top = Math.max(4, at.top - h - 2); }
			menu.style.left = left + 'px';
			menu.style.top = top + 'px';
			menu.querySelector('.mi')?.focus();
		};
		show(items);
	}

	function rowMenu(it, at) {
		const r = rows.get(it.dataset.key);
		if (!r || (r.kind !== 'thread' && r.kind !== 'session')) { return; }
		const act = action => () => post({ type: 'thread', action, id: r.id });
		const main = () => [
			{ label: S.moveTo, sub: moveTo },
			...(r.archived ? [] : [{ label: r.pinned ? S.unpin : S.pin, run: act(r.pinned ? 'unpin' : 'pin') }]),
			{ label: S.rename, run: () => editName(it, r.title, name => post({ type: 'thread', action: 'rename', id: r.id, name })) },
			{ label: r.archived ? S.restore : S.archive, run: act(r.archived ? 'unarchive' : 'archive') },
			// A session no thread continues yet stays on its machine: nothing here to delete.
			...(r.kind === 'thread' ? [{ label: S.delete, danger: true, run: act('delete') }] : []),
		];
		const moveTo = () => [
			{ label: '‹ ' + S.moveTo, back: true, sub: main },
			...model.sections.map(s => ({ label: s.name, check: r.section === s.id, run: () => post({ type: 'move', id: r.id, section: s.id }) })),
			...(r.section ? [{ label: S.noSection, run: () => post({ type: 'move', id: r.id, section: null }) }] : []),
			{ sep: true },
			{ label: '+ ' + S.newSectionMenu, run: () => { const add = addRow(); if (add) { editName(add, '', name => post({ type: 'moveToNew', id: r.id, name })); } } },
		];
		openMenu(main(), at, it);
	}

	function sectionMenu(h, at) {
		const id = h.dataset.section;
		const i = model.sections.findIndex(s => s.id === id);
		const act = action => () => post({ type: 'section', action, id });
		openMenu([
			{ label: S.renameSection, run: () => editName(h, (model.sections[i] || {}).name, name => post({ type: 'section', action: 'rename', id, name })) },
			...(i > 0 ? [{ label: S.moveUp, run: act('up') }] : []),
			...(i >= 0 && i < model.sections.length - 1 ? [{ label: S.moveDown, run: act('down') }] : []),
			{ sep: true },
			{ label: S.deleteSection, danger: true, run: act('delete') },
		], at, h);
	}

	const point = e => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });

	// ---- clicks, right clicks, keys
	document.addEventListener('click', e => {
		const t = e.target;
		if (menu && menu.contains(t)) { return; }
		const wasOpen = !!menu;
		const before = menuKey;
		closeMenu();
		const navItem = t.closest('[data-nav]');
		if (navItem) {
			if (navItem.dataset.nav === 'search') { startSearch(); } else { post({ type: 'nav', item: navItem.dataset.nav }); }
			return;
		}
		const more = t.closest('.more');
		const it = t.closest('.it[data-key]');
		const head = t.closest('.proj');
		if (more) {
			const owner = it || head;
			if (wasOpen && before === keyOf(owner)) { return; }
			const at = more.getBoundingClientRect();
			if (it) { rowMenu(it, at); } else if (head) { sectionMenu(head, at); }
			return;
		}
		const action = t.closest('[data-action]');
		if (action && action.dataset.action === 'newSection') { editName(action, '', name => post({ type: 'section', action: 'new', name })); return; }
		if (action && action.dataset.action === 'archived') { ui.archivedOpen = !ui.archivedOpen; vscode.setState(ui); render(); return; }
		if (action && action.dataset.action.startsWith('older:')) { const g = action.dataset.action.slice(6); ui.olderOpen = Object.assign({}, ui.olderOpen, { [g]: !ui.olderOpen[g] }); vscode.setState(ui); render(); return; }
		if (it) {
			model.selected = it.dataset.key;
			markSelected();
			roving(it);
			post({ type: 'open', key: it.dataset.key });
		}
	});

	document.addEventListener('contextmenu', e => {
		e.preventDefault();
		const it = e.target.closest('.it[data-menu]');
		const head = e.target.closest('.proj');
		if (it) { rowMenu(it, point(e)); } else if (head) { sectionMenu(head, point(e)); } else { closeMenu(); }
	});

	document.addEventListener('keydown', e => {
		if (menu) {
			const items = [...menu.querySelectorAll('.mi')];
			const at = items.indexOf(document.activeElement);
			if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
			else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[at < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
			else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); if (at >= 0 && (e.key !== 'ArrowRight' || items[at].querySelector('.s'))) { items[at].click(); } }
			else if (e.key === 'ArrowLeft') { e.preventDefault(); menu.querySelector('.mi.back')?.click(); }
			else if (e.key === 'Tab') { e.preventDefault(); }
			return;
		}
		const cur = document.activeElement && document.activeElement.closest && document.activeElement.closest('.it, .proj, .sec.fold');
		if (!cur) { return; }
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cur.click(); }
		else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const all = focusables();
			const next = all[all.indexOf(cur) + (e.key === 'ArrowDown' ? 1 : -1)];
			if (next) { roving(next); next.focus(); }
		} else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
			e.preventDefault();
			const r = cur.getBoundingClientRect();
			if (cur.matches('.it[data-menu]')) { rowMenu(cur, r); } else if (cur.matches('.proj')) { sectionMenu(cur, r); }
		}
	});
	addEventListener('blur', () => closeMenu());
	addEventListener('resize', () => closeMenu());
	document.addEventListener('scroll', () => closeMenu(), true);

	// ---- drag a thread onto a section header (or "No section"); drag a section header to reorder
	const dropTarget = e => e.target.closest && e.target.closest('[data-drop]');
	const clearDrop = () => { for (const d of document.querySelectorAll('.drop')) { d.classList.remove('drop'); } };
	const endDrag = () => { dragging = ''; clearDrop(); if (pending) { pending = false; render(); } };
	document.addEventListener('dragstart', e => {
		const it = e.target.closest && e.target.closest('.it[data-menu]');
		const head = e.target.closest && e.target.closest('.proj');
		closeMenu();
		if (it) { e.dataTransfer.setData(T_THREAD, it.dataset.id); dragging = 'thread'; }
		else if (head) { e.dataTransfer.setData(T_SECTION, head.dataset.section); dragging = 'section'; }
		else { e.preventDefault(); return; }
		e.dataTransfer.effectAllowed = 'move';
	});
	document.addEventListener('dragover', e => {
		const target = dropTarget(e);
		if (!target || !dragging) { return; }
		if (dragging === 'section' && target.dataset.section === undefined && target.dataset.drop !== '') { return; }
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		if (!target.classList.contains('drop')) { clearDrop(); target.classList.add('drop'); }
	});
	document.addEventListener('dragleave', e => {
		const target = dropTarget(e);
		if (target && !(e.relatedTarget && target.contains(e.relatedTarget))) { target.classList.remove('drop'); }
	});
	document.addEventListener('drop', e => {
		const target = dropTarget(e);
		e.preventDefault();
		if (target && dragging === 'thread') {
			const id = e.dataTransfer.getData(T_THREAD);
			if (id) { post({ type: 'move', id, section: target.dataset.drop || null }); }
		} else if (target && dragging === 'section') {
			const id = e.dataTransfer.getData(T_SECTION);
			if (id) { post({ type: 'reorder', id, before: target.dataset.section || null }); }
		}
		endDrag();
	});
	document.addEventListener('dragend', endDrag);

	// A list refreshed in the background waits while the mouse is on it or a menu is open, so no
	// row moves under the pointer; what the user just did shows at once.
	function flush() {
		if (pending && !dragging && !editing && !menu && !hovering) { pending = false; render(); }
	}
	list.addEventListener('mouseenter', () => { hovering = true; });
	list.addEventListener('mouseleave', () => { hovering = false; flush(); });

	addEventListener('message', e => {
		const m = e.data;
		if (m && m.type === 'model') {
			model = m.model;
			if (m.quiet && (hovering || menu)) { pending = true; return; }
			render();
		}
		else if (m && m.type === 'select' && model) { model.selected = m.key; markSelected(); }
	});
	post({ type: 'ready' });
})();
</script>
</body></html>`;
}

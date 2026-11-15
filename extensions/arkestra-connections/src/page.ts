/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Connections page: every machine with its access, agent CLIs and status; a new
 *  SSH connection is typed into the page's own form, a removal is confirmed in its row (no
 *  input box at the top of the window, no dialog). The rows arrive as messages, so a half-typed
 *  form stays. No VS Code here, so it is testable; the texts come in already translated.
 *--------------------------------------------------------------------------------------------*/

import type { Machine, ProbeResult } from './ssh';

export interface PageStrings {
	readonly title: string;
	readonly lead: string;
	readonly machine: string;
	readonly access: string;
	readonly clis: string;
	readonly status: string;
	readonly thisMachine: string;
	readonly local: string;
	readonly check: string;
	readonly remove: string;
	readonly removeAsk: string;
	readonly removeYes: string;
	readonly cancel: string;
	readonly checking: string;
	readonly reachable: string;
	readonly unreachable: string;
	readonly noCli: string;
	readonly add: string;
	readonly host: string;
	readonly hostHint: string;
	readonly name: string;
	readonly nameHint: string;
	readonly folder: string;
	readonly folderHint: string;
	readonly save: string;
}

/** One row as the page draws it. */
export interface PageRow {
	readonly id: string;
	readonly name: string;
	readonly access: string;
	readonly clis: readonly string[];
	readonly state: 'none' | 'checking' | 'ok' | 'bad';
	readonly text: string;
	readonly removable: boolean;
}

function esc(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

/** The rows: this machine first, then the SSH machines in their order, each with its last check. */
export function pageRows(machines: readonly Machine[], status: ReadonlyMap<string, ProbeResult | 'checking'>, t: Pick<PageStrings, 'thisMachine' | 'local' | 'checking' | 'reachable' | 'unreachable'>): PageRow[] {
	const row = (id: string, name: string, access: string, removable: boolean): PageRow => {
		const s = status.get(id);
		const state = s === undefined ? { state: 'none' as const, text: '', clis: [] } : s === 'checking' ? { state: 'checking' as const, text: t.checking, clis: [] }
			: s.reachable ? { state: 'ok' as const, text: t.reachable, clis: s.clis } : { state: 'bad' as const, text: s.error ?? t.unreachable, clis: [] };
		return { id, name, access, removable, ...state };
	};
	return [
		row('local', t.thisMachine, t.local, false),
		...machines.map(m => row(m.id, m.name, `ssh · ${m.host}${m.port ? `:${m.port}` : ''}${m.folder ? ` · ${m.folder}` : ''}`, true)),
	];
}

/** The page; `rows` messages fill the table, `saved` answers the form (`error` and `field`, or done). */
export function connectionsPage(nonce: string, t: PageStrings): string {
	const strings = JSON.stringify(t).replace(/</g, '\\u003c');
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px 24px; max-width: 980px; }
	h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 4px; }
	p.lead { color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
	table { width: 100%; border-collapse: collapse; }
	th { text-align: left; font-weight: 600; font-size: .85em; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
	td { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
	.mut { color: var(--vscode-descriptionForeground); }
	.ok { color: var(--vscode-testing-iconPassed); }
	.bad { color: var(--vscode-errorForeground); }
	.cli { font-family: var(--vscode-editor-font-family); font-size: .9em; padding: 1px 7px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 4px; }
	.act { text-align: right; white-space: nowrap; }
	.ask { text-align: right; }
	.ask span { margin-right: 8px; }
	button { font: inherit; padding: 4px 12px; margin-left: 6px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.danger { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
	#addOpen { margin: 16px 0 0; }
	form { margin-top: 16px; padding: 14px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; display: grid; gap: 10px; max-width: 520px; }
	form[hidden] { display: none; }
	label { display: grid; gap: 4px; }
	label span { font-size: .85em; font-weight: 600; color: var(--vscode-descriptionForeground); }
	label small { color: var(--vscode-descriptionForeground); }
	input { font: inherit; padding: 5px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; outline: none; }
	input:focus { border-color: var(--vscode-focusBorder); }
	.bad input { border-color: var(--vscode-errorForeground); }
	.err { color: var(--vscode-errorForeground); font-size: .9em; }
	.err:empty { display: none; }
	.row { display: flex; gap: 0; justify-content: flex-end; }
</style></head>
<body>
	<h1>${esc(t.title)}</h1>
	<p class="lead">${esc(t.lead)}</p>
	<table>
		<thead><tr><th>${esc(t.machine)}</th><th>${esc(t.access)}</th><th>${esc(t.clis)}</th><th>${esc(t.status)}</th><th></th></tr></thead>
		<tbody id="rows"></tbody>
	</table>
	<button id="addOpen">+ ${esc(t.add)}</button>
	<form id="add" hidden novalidate>
		<label data-f="host"><span>${esc(t.host)}</span><input name="host" list="hosts" autocomplete="off" spellcheck="false" placeholder="dev@server.example.com"><small>${esc(t.hostHint)}</small><small class="err"></small></label>
		<datalist id="hosts"></datalist>
		<label data-f="name"><span>${esc(t.name)}</span><input name="name" autocomplete="off" spellcheck="false"><small>${esc(t.nameHint)}</small><small class="err"></small></label>
		<label data-f="folder"><span>${esc(t.folder)}</span><input name="folder" autocomplete="off" spellcheck="false" placeholder="~/projects/app"><small>${esc(t.folderHint)}</small><small class="err"></small></label>
		<div class="err" id="formErr"></div>
		<div class="row"><button type="button" class="sec" id="addCancel">${esc(t.cancel)}</button><button type="submit">${esc(t.save)}</button></div>
	</form>
	<script type="application/json" id="l10n" nonce="${nonce}">${strings}</script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const S = JSON.parse(document.getElementById('l10n').textContent);
		const rowsEl = document.getElementById('rows'), form = document.getElementById('add'), open = document.getElementById('addOpen');
		let rows = [], confirming = '';
		const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; };
		const button = (act, id, label, cls) => { const b = el('button', cls || '', label); b.dataset.act = act; b.dataset.id = id; return b; };
		function draw() {
			rowsEl.replaceChildren(...rows.map(r => {
				const tr = el('tr');
				const name = el('td'); name.append(el('b', '', r.name));
				const clis = el('td');
				if (r.state === 'ok') { if (r.clis.length) { for (const c of r.clis) { clis.append(el('span', 'cli', c)); } } else { clis.append(el('span', 'mut', S.noCli)); } }
				tr.append(name, el('td', 'mut', r.access), clis, el('td', r.state === 'ok' ? 'ok' : r.state === 'bad' ? 'bad' : 'mut', r.text));
				if (confirming === r.id) {
					const td = el('td', 'ask');
					td.append(el('span', '', S.removeAsk.replace('{0}', r.name)), button('removeYes', r.id, S.removeYes, 'danger'), button('cancel', r.id, S.cancel, 'sec'));
					tr.append(td);
				} else {
					const td = el('td', 'act');
					td.append(button('check', r.id, S.check));
					if (r.removable) { td.append(button('remove', r.id, S.remove, 'sec')); }
					tr.append(td);
				}
				return tr;
			}));
		}
		function showForm(on) {
			form.hidden = !on;
			open.hidden = on;
			if (on) { form.reset(); clearErrors(); form.querySelector('input').focus(); }
		}
		function clearErrors() { for (const e of form.querySelectorAll('.err')) { e.textContent = ''; } for (const f of form.querySelectorAll('.bad')) { f.classList.remove('bad'); } }
		document.addEventListener('click', e => {
			const b = e.target.closest('button[data-act]');
			if (b) {
				const id = b.dataset.id, act = b.dataset.act;
				if (act === 'remove') { confirming = id; draw(); }
				else if (act === 'cancel') { confirming = ''; draw(); }
				else if (act === 'removeYes') { confirming = ''; draw(); vscode.postMessage({ type: 'remove', id }); }
				else { vscode.postMessage({ type: act, id }); }
				return;
			}
			if (e.target.id === 'addOpen') { showForm(true); }
			if (e.target.id === 'addCancel') { showForm(false); }
		});
		form.addEventListener('keydown', e => { if (e.key === 'Escape') { showForm(false); open.focus(); } });
		form.addEventListener('submit', e => {
			e.preventDefault();
			clearErrors();
			const v = Object.fromEntries(new FormData(form).entries());
			vscode.postMessage({ type: 'save', host: v.host || '', name: v.name || '', folder: v.folder || '' });
		});
		window.addEventListener('message', e => {
			const m = e.data;
			if (m.type === 'rows') {
				rows = m.rows;
				if (confirming && !rows.some(r => r.id === confirming)) { confirming = ''; }
				draw();
				const list = document.getElementById('hosts');
				list.replaceChildren(...(m.hosts || []).map(h => { const o = document.createElement('option'); o.value = h; return o; }));
			} else if (m.type === 'saved') {
				if (m.error) {
					const f = m.field ? form.querySelector('[data-f="' + m.field + '"]') : null;
					if (f) { f.classList.add('bad'); f.querySelector('.err').textContent = m.error; f.querySelector('input').focus(); }
					else { document.getElementById('formErr').textContent = m.error; }
				} else { showForm(false); }
			} else if (m.type === 'addOpen') {
				showForm(true);
			}
		});
		vscode.postMessage({ type: 'ready' });
	</script>
</body></html>`;
}

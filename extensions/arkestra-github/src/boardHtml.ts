/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Board and Table views' page (AR30). The extension posts the board model; the
 *  page draws it and posts back what the user does (move, edit, new issue, start a room).
 *  Drawn with DOM calls, never with HTML strings from data.
 *--------------------------------------------------------------------------------------------*/

const STYLE = String.raw`
:root { --gap: 10px; --radius: 6px; }
* { box-sizing: border-box; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.4 var(--vscode-font-family); }
button, select, input { font: inherit; color: inherit; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 4px; padding: 3px 9px; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:hover { filter: brightness(1.1); }
select, input { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 2px 6px; }
a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
header { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 14px; display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.title { font-weight: 600; font-size: 14px; }
.muted { color: var(--vscode-descriptionForeground); }
.tabs { display: flex; gap: 2px; }
.tabs button { background: transparent; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; border-radius: 0; }
.tabs button.on { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
.spacer { flex: 1; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 10px; font-size: 11px; line-height: 18px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
.tone-ok { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 22%, transparent); color: var(--vscode-foreground); }
.tone-bad { background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 25%, transparent); color: var(--vscode-foreground); }
.tone-run { background: color-mix(in srgb, var(--vscode-progressBar-background, #3794ff) 25%, transparent); color: var(--vscode-foreground); }
.tone-warn { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 25%, transparent); color: var(--vscode-foreground); }
.tone-muted { background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: currentColor; }
main { padding: 12px 14px; }
.board { display: flex; gap: var(--gap); align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
.col { flex: 0 0 272px; background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background)); border-radius: var(--radius); display: flex; flex-direction: column; max-height: calc(100vh - 150px); }
.col.drop { outline: 2px dashed var(--vscode-focusBorder); }
.col h3 { margin: 0; padding: 8px 10px; font-size: 12px; font-weight: 600; display: flex; gap: 6px; align-items: center; }
.cards { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 8px 9px; display: flex; flex-direction: column; gap: 5px; cursor: grab; }
.card.dragging { opacity: .4; }
.card .top { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.card .num { color: var(--vscode-descriptionForeground); font-size: 12px; }
.card .name { font-weight: 500; }
.kv { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; font-size: 12px; }
.kv span:nth-child(odd) { color: var(--vscode-descriptionForeground); }
.chips { display: flex; gap: 4px; flex-wrap: wrap; }
.more { margin: 0 8px 8px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; white-space: nowrap; }
td.wrap { white-space: normal; min-width: 220px; }
th { position: sticky; top: 0; background: var(--vscode-editor-background); cursor: pointer; user-select: none; font-weight: 600; }
td select, td input { width: 100%; min-width: 90px; }
.form { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); }
.form input.wide { flex: 1; min-width: 200px; }
.empty { padding: 40px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
footer { border-top: 1px solid var(--vscode-panel-border); margin-top: 12px; padding: 8px 14px 14px; }
footer summary { cursor: pointer; font-weight: 600; font-size: 12px; }
.log { display: grid; grid-template-columns: auto auto 1fr; gap: 2px 10px; font-size: 12px; margin-top: 6px; }
.log .err { color: var(--vscode-errorForeground); }
.plan { display: flex; flex-direction: column; gap: 18px; }
.plan h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 4px; color: var(--vscode-descriptionForeground); }
.plan .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 8px; max-width: 70ch; }
.lanes { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--gap); }
.lane { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.lane.development { border-color: var(--vscode-focusBorder); }
.lane .name { font-weight: 600; font-size: 14px; }
.bar { height: 6px; border-radius: 3px; background: var(--vscode-editorWidget-background); overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--vscode-progressBar-background, #3794ff); }
.rails { display: flex; flex-direction: column; gap: 10px; }
.rail { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 8px 10px; min-width: 0; }
.rail .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.rail .branch { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.steps { display: flex; gap: 0; overflow-x: auto; margin-top: 8px; padding-bottom: 4px; }
.step { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 0 14px 0 0; position: relative; max-width: 220px; }
.step::before { content: ''; position: absolute; left: 0; right: 0; top: 5px; height: 2px; background: var(--vscode-panel-border); }
.step .pin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--vscode-panel-border); background: var(--vscode-editor-background); position: relative; }
.step.done .pin { background: var(--vscode-testing-iconPassed, #3fb950); border-color: var(--vscode-testing-iconPassed, #3fb950); }
.step.now .pin { border-color: var(--vscode-focusBorder); background: var(--vscode-focusBorder); }
.step .lbl { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; }
.step .sub { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; }
.stairs-wrap { overflow-x: auto; }
.stairs { display: grid; gap: 4px 6px; align-items: center; min-width: 560px; }
.stairs .lv { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; }
.stairs .lanehead { grid-column: 1 / -1; font-weight: 600; font-size: 12px; margin-top: 8px; }
.cell { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 6px; font-size: 12px; position: relative; overflow: hidden; cursor: pointer; white-space: nowrap; text-overflow: ellipsis; }
.cell > .fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--vscode-progressBar-background, #3794ff) 22%, transparent); }
.cell > span { position: relative; }
.cell.critical { border-color: var(--vscode-testing-iconFailed, #f85149); border-width: 2px; }
.cell.startable { box-shadow: inset 3px 0 0 var(--vscode-testing-iconPassed, #3fb950); }
.cell.running { box-shadow: inset 3px 0 0 var(--vscode-progressBar-background, #3794ff); }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.graph-top { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.graph-top button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.graph-body { display: flex; gap: 12px; align-items: flex-start; }
.canvas { flex: 1; min-width: 0; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); max-height: calc(100vh - 190px); background: var(--vscode-editor-background); }
.canvas svg { display: block; touch-action: none; }
.node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border); stroke-width: 1; }
.node.milestone rect { fill: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, var(--vscode-editor-background)); }
.node.done rect { opacity: .7; }
.node.critical rect { stroke: var(--vscode-testing-iconFailed, #f85149); stroke-width: 2; }
.node.sel rect { stroke: var(--vscode-focusBorder); stroke-width: 2.5; }
.node text { fill: var(--vscode-foreground); font-size: 12px; pointer-events: none; }
.node text.sub { fill: var(--vscode-descriptionForeground); font-size: 11px; }
.node .stripe-ok { fill: var(--vscode-testing-iconPassed, #3fb950); }
.node .stripe-bad { fill: var(--vscode-testing-iconFailed, #f85149); }
.node .stripe-run { fill: var(--vscode-progressBar-background, #3794ff); }
.node .stripe-warn { fill: var(--vscode-editorWarning-foreground, #cca700); }
.node { cursor: grab; }
.drawing .node { cursor: crosshair; }
.edge { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.5; cursor: pointer; }
.edge.loose { stroke-dasharray: 5 4; }
.edge.release { stroke-dasharray: 2 4; stroke-width: 1; }
.edge.critical { stroke: var(--vscode-testing-iconFailed, #f85149); stroke-width: 2.5; }
.edge.sel { stroke: var(--vscode-focusBorder); stroke-width: 3; }
.edge-hit { fill: none; stroke: transparent; stroke-width: 12; cursor: pointer; }
.ghost { stroke: var(--vscode-focusBorder); stroke-width: 2; stroke-dasharray: 4 3; fill: none; pointer-events: none; }
.side { flex: 0 0 280px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.side h4 { margin: 4px 0 0; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.side ul { margin: 0; padding-left: 16px; }
@media (max-width: 760px) { .graph-body { flex-direction: column; } .side { flex-basis: auto; width: 100%; } }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; border: 1px solid var(--vscode-panel-border); }
`;

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const ui = { tab: saved.tab || 'board', filters: saved.filters || {}, search: saved.search || '', open: saved.open || {}, sort: saved.sort || null, form: false };
let model = null;
let screen = null;
const save = () => vscode.setState(Object.assign({}, vscode.getState(), { tab: ui.tab, filters: ui.filters, search: ui.search, open: ui.open, sort: ui.sort }));
const post = (m) => vscode.postMessage(m);

function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else if (k === 'style') el.style.cssText = v; // CSSOM: allowed by the page's CSP, a style attribute is not
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	for (const kid of kids.flat(Infinity)) {
		if (kid === undefined || kid === null || kid === false) continue;
		el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	return el;
}
const chip = (text, tone, attrs) => h('span', Object.assign({ class: 'chip' + (tone ? ' tone-' + tone : '') }, attrs || {}), text);

const columnOf = (card) => model.columns.find(c => c.cards.some(x => x.id === card.id));
function cardValue(card, key) {
	if (key === 'status') { const col = columnOf(card); return [col ? col.name : 'No status']; }
	if (key === 'labels') return card.labels;
	if (key === 'assignees') return card.assignees;
	const f = card.fields.find(x => 'f:' + x.fieldId === key);
	return f ? [f.value] : [];
}
function visible(card) {
	for (const [key, want] of Object.entries(ui.filters)) {
		if (want === '!done') { const col = columnOf(card); if (col && col.done) return false; continue; }
		if (want && !cardValue(card, key).includes(want)) return false;
	}
	const q = ui.search.trim().toLowerCase();
	if (q && !(card.title.toLowerCase().includes(q) || ('#' + card.number) === q || String(card.number) === q)) return false;
	return true;
}
const label = (card) => card.number !== undefined ? '#' + card.number : '';

function roomChip(room) {
	const tone = room.status === 'running' ? 'run' : room.status === 'waiting' ? 'warn' : room.status === 'ended' ? 'muted' : '';
	const progress = room.progress ? ' · ' + room.progress.done + '/' + room.progress.total : '';
	return chip(room.type + ' room · ' + room.phase + progress, tone, { title: room.title, onclick: (e) => { e.stopPropagation(); post({ type: 'openRoom', roomId: room.roomId }); }, style: 'cursor:pointer' });
}
function prereq(card) {
	if (card.blockers.length) {
		const open = card.blockers.filter(b => b.open);
		return open.length ? chip('blocked · ' + open.map(b => b.label).join(', '), 'bad') : chip('prerequisites done · ' + card.blockers.map(b => b.label).join(', '), 'ok');
	}
	return null;
}

function cardEl(card) {
	const fields = model.cardFields.map(id => card.fields.find(f => f.fieldId === id)).filter(Boolean);
	const el = h('div', { class: 'card', draggable: 'true', 'data-id': card.id },
		h('div', { class: 'top' }, h('span', { class: 'num' }, label(card) || (card.type === 'draft' ? 'draft' : '')), card.labels.map(l => chip(l)), card.state === 'CLOSED' ? chip('closed', 'muted') : null),
		h('a', { class: 'name', onclick: () => card.url && post({ type: 'open', url: card.url }) }, card.title),
		fields.length ? h('div', { class: 'kv' }, fields.map(f => [h('span', {}, f.name), h('span', {}, f.value)])) : null,
		h('div', { class: 'chips' },
			prereq(card),
			card.prs.map(p => chip(p.label, p.tone, { onclick: (e) => { e.stopPropagation(); post({ type: 'open', url: p.url }); }, style: 'cursor:pointer' })),
			card.review ? chip(card.review.label, card.review.tone) : null,
			card.comments ? chip(card.comments + ' comments', 'muted') : null,
			card.room ? roomChip(card.room) : null),
		card.startable ? h('div', {}, h('button', { class: 'primary', onclick: (e) => { e.stopPropagation(); post({ type: 'startRoom', itemId: card.id }); } }, 'Start room ▸')) : null);
	el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/arkestra-item', card.id); el.classList.add('dragging'); });
	el.addEventListener('dragend', () => el.classList.remove('dragging'));
	return el;
}

function boardEl() {
	return h('div', { class: 'board' }, model.columns.map(col => {
		const cards = col.cards.filter(visible);
		const limit = col.done && !ui.open[col.id] ? 3 : Infinity;
		const el = h('section', { class: 'col' },
			h('h3', {}, col.color ? h('span', { class: 'dot', style: 'color:' + colour(col.color) }) : null, col.name, h('span', { class: 'muted' }, String(cards.length))),
			h('div', { class: 'cards' }, cards.slice(0, limit).map(cardEl)),
			cards.length > limit ? h('button', { class: 'more', onclick: () => { ui.open[col.id] = true; save(); draw(); } }, '+ ' + (cards.length - limit) + ' more') : null);
		if (col.id) {
			el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/arkestra-item')) { e.preventDefault(); el.classList.add('drop'); } });
			el.addEventListener('dragleave', () => el.classList.remove('drop'));
			el.addEventListener('drop', (e) => {
				e.preventDefault(); el.classList.remove('drop');
				const id = e.dataTransfer.getData('text/arkestra-item');
				const card = model.columns.flatMap(c => c.cards).find(c => c.id === id);
				if (card && card.statusId !== col.id) post({ type: 'move', itemId: id, optionId: col.id });
			});
		}
		return el;
	}));
}
function colour(name) {
	const map = { GRAY: '#8b949e', BLUE: '#3794ff', GREEN: '#3fb950', YELLOW: '#d29922', ORANGE: '#db6d28', RED: '#f85149', PINK: '#db61a2', PURPLE: '#a371f7' };
	return map[name] || 'currentColor';
}

function editor(card, field) {
	const cur = card.fields.find(f => f.fieldId === field.id);
	const send = (value) => post({ type: 'setField', itemId: card.id, fieldId: field.id, value });
	if (field.type === 'single_select' || field.type === 'iteration') {
		const opts = field.type === 'single_select' ? field.options : field.iterations.map(i => ({ id: i.id, name: i.title }));
		const sel = h('select', { onchange: () => send(sel.value ? (field.type === 'single_select' ? { optionId: sel.value } : { iterationId: sel.value }) : null) },
			h('option', { value: '' }, '—'), opts.map(o => h('option', { value: o.id, selected: cur && cur.valueId === o.id }, o.name)));
		return sel;
	}
	if (field.type === 'text' || field.type === 'number' || field.type === 'date') {
		const input = h('input', { type: field.type === 'text' ? 'text' : field.type, value: cur ? cur.value : '' });
		input.addEventListener('change', () => send(input.value === '' ? null : field.type === 'number' ? Number(input.value) : input.value));
		return input;
	}
	return document.createTextNode(cur ? cur.value : '');
}

function tableEl() {
	const cards = model.columns.flatMap(c => c.cards).filter(visible);
	const status = model.statusFieldId ? { id: model.statusFieldId, name: 'Status', type: 'single_select', options: model.columns.filter(c => c.id).map(c => ({ id: c.id, name: c.name })) } : null;
	const cols = [
		{ key: 'num', name: '#', get: c => c.number || 0, cell: c => label(c) },
		{ key: 'title', name: 'Title', get: c => c.title.toLowerCase(), cell: c => h('a', { onclick: () => c.url && post({ type: 'open', url: c.url }) }, c.title), wrap: true },
		status && { key: 'status', name: 'Status', get: c => c.status || '', cell: c => editor(Object.assign({}, c, { fields: c.statusId ? [{ fieldId: status.id, valueId: c.statusId, value: c.status }] : [] }), status) },
		...model.fields.filter(f => f.type !== 'other').map(f => ({ key: 'f:' + f.id, name: f.name, get: c => { const v = c.fields.find(x => x.fieldId === f.id); return v ? (f.type === 'number' ? Number(v.value) : v.value.toLowerCase()) : ''; }, cell: c => editor(c, f) })),
		{ key: 'labels', name: 'Labels', get: c => c.labels.join(','), cell: c => h('div', { class: 'chips' }, c.labels.map(l => chip(l))) },
		{ key: 'prereq', name: 'Prerequisites', get: c => c.blockers.filter(b => b.open).length, cell: c => prereq(c) || (c.startable ? chip('startable', 'ok') : '') },
		{ key: 'pr', name: 'PR', get: c => c.prs.length ? c.prs[0].label : '', cell: c => h('div', { class: 'chips' }, c.prs.map(p => chip(p.label, p.tone)), c.review ? chip(c.review.label, c.review.tone) : null) },
		{ key: 'room', name: 'Room', get: c => c.room ? c.room.status : '', cell: c => c.room ? roomChip(c.room) : (c.startable ? h('button', { onclick: () => post({ type: 'startRoom', itemId: c.id }) }, 'Start room ▸') : '') },
		{ key: 'progress', name: 'Progress', get: c => c.room && c.room.progress ? c.room.progress.done / c.room.progress.total : -1, cell: c => c.room && c.room.progress ? c.room.progress.done + '/' + c.room.progress.total : '' },
	].filter(Boolean);
	if (ui.sort) {
		const col = cols.find(c => c.key === ui.sort.key);
		if (col) cards.sort((a, b) => { const x = col.get(a), y = col.get(b); return (x < y ? -1 : x > y ? 1 : 0) * ui.sort.dir; });
	}
	const head = h('tr', {}, cols.map(c => h('th', { onclick: () => { ui.sort = ui.sort && ui.sort.key === c.key ? { key: c.key, dir: -ui.sort.dir } : { key: c.key, dir: 1 }; save(); draw(); } }, c.name + (ui.sort && ui.sort.key === c.key ? (ui.sort.dir > 0 ? ' ▲' : ' ▼') : ''))));
	return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, cards.map(card => h('tr', {}, cols.map(c => h('td', { class: c.wrap ? 'wrap' : '' }, c.cell(card))))))));
}

function newIssueForm() {
	const title = h('input', { class: 'wide', placeholder: 'Title of the new issue' });
	const repo = h('input', { list: 'repos', value: model.repositories[0] || '', placeholder: 'owner/repository', size: 22 });
	const status = h('select', {}, model.columns.filter(c => c.id).map(c => h('option', { value: c.id }, c.name)));
	const submit = () => {
		if (!title.value.trim() || !repo.value.trim()) return;
		post({ type: 'createIssue', title: title.value.trim(), repository: repo.value.trim(), optionId: status.value || undefined });
		ui.form = false; draw();
	};
	title.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { ui.form = false; draw(); } });
	setTimeout(() => title.focus(), 0);
	return h('div', { class: 'form' }, title, repo, h('datalist', { id: 'repos' }, model.repositories.map(r => h('option', { value: r }))), model.statusFieldId ? status : null,
		h('button', { class: 'primary', onclick: submit }, 'Create'), h('button', { onclick: () => { ui.form = false; draw(); } }, 'Cancel'));
}

function headerEl() {
	const search = h('input', { placeholder: 'Search title or #', value: ui.search, size: 18 });
	search.addEventListener('input', () => { ui.search = search.value; save(); drawMain(); });
	return h('header', {},
		h('div', { class: 'row' },
			h('a', { class: 'title', onclick: () => post({ type: 'open', url: model.project.url }) }, model.project.title),
			h('span', { class: 'muted' }, 'GitHub Project ' + model.project.ref + ' · two-way sync'),
			chip(model.sync.text, model.sync.tone),
			h('span', { class: 'spacer' }),
			h('div', { class: 'tabs' }, ['board', 'table', 'plan', 'graph'].map(t => h('button', { class: ui.tab === t ? 'on' : '', onclick: () => { ui.tab = t; save(); draw(); } }, { board: 'Board', table: 'Table', plan: 'Plan', graph: 'Graph' }[t]))),
			h('button', { title: 'Read the project again', onclick: () => post({ type: 'refresh' }) }, '↻'),
			h('button', { class: 'primary', onclick: () => { ui.form = !ui.form; draw(); } }, '+ New issue')),
		ui.form ? newIssueForm() : null,
		h('div', { class: 'row' }, search, model.filters.map(f => {
			const sel = h('select', { onchange: () => { ui.filters[f.key] = sel.value; save(); drawMain(); } }, h('option', { value: '' }, f.name + ': all'),
				f.key === 'status' ? h('option', { value: '!done', selected: ui.filters[f.key] === '!done' }, f.name + ': not done') : null,
				f.values.map(v => h('option', { value: v, selected: ui.filters[f.key] === v }, f.name + ': ' + v)));
			return sel;
		}), Object.values(ui.filters).some(Boolean) || ui.search ? h('a', { onclick: () => { ui.filters = {}; ui.search = ''; save(); draw(); } }, 'Clear filters') : null));
}

function footerEl() {
	const d = h('details', { open: saved.log ? true : undefined }, h('summary', {}, 'Sync log · both directions'),
		model.journal.length ? h('div', { class: 'log' }, model.journal.map(e => [h('span', { class: 'muted' }, e.time), h('span', {}, e.direction === 'in' ? 'GitHub → here' : 'here → GitHub'), h('span', { class: e.error ? 'err' : '' }, (e.item ? e.item + ' · ' : '') + e.text)])) : h('div', { class: 'muted' }, 'Nothing yet: changes on GitHub and here show up in this log.'));
	d.addEventListener('toggle', () => { saved.log = d.open; vscode.setState(Object.assign({}, vscode.getState(), { log: d.open })); });
	return h('footer', {}, d);
}

function planEl() {
	const p = model.plan;
	if (!p) return h('div', { class: 'muted' }, 'No plan yet.');
	const stateText = { released: 'Released', development: 'In development', next: 'Next', later: 'Later' };
	const lanes = h('section', {},
		h('h2', {}, 'Release lanes'),
		h('p', { class: 'hint' }, (p.live ? 'Live: ' + p.live + ' · ' : '') + (p.laneField ? 'lanes from the ' + p.laneField + ' field' : 'no lane field (Line, Release, Milestone…): everything is in Backlog') + (p.weightField ? ' · weighted by ' + p.weightField : ' · every task weighs the same')),
		h('div', { class: 'lanes' }, p.lanes.map(l => h('div', { class: 'lane ' + l.state },
			h('div', { class: 'muted' }, stateText[l.state]),
			h('div', { class: 'name' }, l.name),
			h('div', { class: 'bar' }, h('i', { style: 'width:' + l.percent + '%' })),
			h('div', { class: 'muted' }, l.done + '/' + l.total + ' done · ' + l.percent + '%')))));
	const rails = h('section', {},
		h('h2', {}, 'Branches'),
		h('p', { class: 'hint' }, 'Where the base branch and each open branch stand, and what goes on them next, in order.'),
		h('div', { class: 'rails' }, p.rails.map(r => h('div', { class: 'rail' },
			h('div', { class: 'head' }, h('span', { class: 'branch' }, r.name), r.head ? h('span', { class: 'muted' }, r.head) : null, h('span', { class: 'muted' }, r.note)),
			h('div', { class: 'steps' }, r.steps.map(s => h('div', { class: 'step' + (s.done ? ' done' : '') + (s.now ? ' now' : ''), onclick: s.url ? () => post({ type: 'open', url: s.url }) : s.roomId ? () => post({ type: 'openRoom', roomId: s.roomId }) : undefined, style: s.url || s.roomId ? 'cursor:pointer' : '' },
				h('span', { class: 'pin' }), h('span', { class: 'lbl', title: s.label }, (s.done ? '✓ ' : '') + s.label), s.sub ? h('span', { class: 'sub' + (s.tone ? ' tone-' + s.tone : ''), title: s.sub }, s.sub) : null)))))));
	const cols = 'minmax(120px, 1fr) '.repeat(p.levels);
	const grid = h('div', { class: 'stairs', style: 'grid-template-columns:' + cols }, Array.from({ length: p.levels }, (_, i) => h('div', { class: 'lv' }, String(i))),
		p.stairs.filter(s => s.cells.length).map(s => [h('div', { class: 'lanehead' }, s.lane + ' · ' + s.percent + '%'),
			s.cells.map(c => h('div', { class: 'cell' + (c.critical ? ' critical' : '') + (c.startable ? ' startable' : '') + (c.running ? ' running' : ''), title: c.label + ' ' + c.title, style: 'grid-column:' + (c.level + 1), onclick: () => c.roomId ? post({ type: 'openRoom', roomId: c.roomId }) : c.url && post({ type: 'open', url: c.url }) },
				h('i', { class: 'fill', style: 'width:' + Math.round(c.fill * 100) + '%' }), h('span', {}, c.label + ' ' + c.title)))]));
	const stairs = h('section', {},
		h('h2', {}, 'Dependency staircase'),
		h('p', { class: 'hint' }, 'Dependency level instead of time: a task goes one column after its latest prerequisite, so tasks in one column can run in parallel. The fill is completion; the red chain is the critical path.'),
		h('div', { class: 'stairs-wrap' }, grid),
		p.critical.map(c => h('div', { class: 'muted' }, 'Critical path · ' + c.lane + ': ' + c.path.join(' → '))),
		h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'border:2px solid var(--vscode-testing-iconFailed, #f85149)' }), 'critical path'), h('span', {}, h('i', { style: 'background:color-mix(in srgb, var(--vscode-progressBar-background, #3794ff) 22%, transparent)' }), 'completion'), h('span', {}, h('i', { style: 'box-shadow: inset 3px 0 0 var(--vscode-testing-iconPassed, #3fb950)' }), 'startable now'), h('span', {}, h('i', { style: 'box-shadow: inset 3px 0 0 var(--vscode-progressBar-background, #3794ff)' }), 'a room is running on it')),
		h('p', { class: 'hint' }, 'Click a task to open it, or its running room.'));
	return h('div', { class: 'plan' }, lanes, rails, stairs);
}

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
	const el = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else el.setAttribute(k, String(v));
	}
	for (const kid of kids.flat(Infinity)) {
		if (kid === undefined || kid === null || kid === false) continue;
		el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	return el;
}
const W = 200, H = 64;
ui.graph = Object.assign({ mode: 'select', critical: true, zoom: 1 }, saved.graph || {}, { selected: null, target: null });
const saveGraph = () => vscode.setState(Object.assign({}, vscode.getState(), { graph: { mode: ui.graph.mode === 'pick' ? 'select' : ui.graph.mode, critical: ui.graph.critical, zoom: ui.graph.zoom } }));
const cut = (text, n) => text.length > n ? text.slice(0, n - 1) + '…' : text;

function edgePath(a, b) {
	const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
	const back = x2 < x1 + 20;
	const dx = back ? 80 : Math.max(40, (x2 - x1) / 2);
	return 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
}
const edgeKey = (e) => e.kind + ':' + e.from + '>' + e.to;

function graphEl() {
	const g = model.graph;
	if (!g) return h('div', { class: 'muted' }, 'No graph yet.');
	const nodes = new Map(g.nodes.map(n => [n.id, Object.assign({}, n)]));
	const z = ui.graph.zoom;
	const svg = s('svg', { width: Math.round(g.width * z), height: Math.round(g.height * z), viewBox: '0 0 ' + g.width + ' ' + g.height, class: ui.graph.mode !== 'select' ? 'drawing' : '' },
		s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }))));
	const edgeLayer = s('g', {});
	const nodeLayer = s('g', {});
	svg.append(edgeLayer, nodeLayer);
	const pointIn = (ev) => {
		const r = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, top: 0 };
		return { x: (ev.clientX - r.left) / z, y: (ev.clientY - r.top) / z };
	};
	const drawEdges = () => {
		edgeLayer.replaceChildren(...g.edges.filter(e => nodes.has(e.from) && nodes.has(e.to)).map(e => {
			const d = edgePath(nodes.get(e.from), nodes.get(e.to));
			const key = edgeKey(e);
			const crit = ui.graph.critical && e.critical;
			const select = (ev) => { ev.stopPropagation(); ui.graph.selected = { edge: e }; drawMain(); };
			return s('g', {}, s('path', { class: 'edge-hit', d, onclick: select }),
				s('path', { class: 'edge ' + e.kind + (crit ? ' critical' : '') + (ui.graph.selected && ui.graph.selected.edge && edgeKey(ui.graph.selected.edge) === key ? ' sel' : ''), d, 'marker-end': 'url(#arrow)', onclick: select }));
		}));
	};
	for (const n of nodes.values()) {
		const sel = ui.graph.selected && ui.graph.selected.node === n.id;
		const el = s('g', { class: 'node ' + n.kind + (n.done ? ' done' : '') + (ui.graph.critical && n.critical ? ' critical' : '') + (sel ? ' sel' : ''), transform: 'translate(' + n.x + ',' + n.y + ')', 'data-node': n.id },
			s('rect', { width: W, height: H, rx: n.kind === 'milestone' ? 18 : 6 }),
			n.tone ? s('rect', { class: 'stripe-' + n.tone, width: 4, height: H, rx: 2 }) : null,
			s('text', { x: 12, y: 18 }, cut(n.label + (n.status ? ' · ' + n.status : ''), 30)),
			s('text', { x: 12, y: 36 }, cut(n.title, 30)),
			n.sub ? s('text', { class: 'sub', x: 12, y: 54 }, cut(n.sub, 32)) : null);
		el.addEventListener('pointerdown', (ev) => {
			ev.stopPropagation();
			const start = pointIn(ev);
			const ox = n.x, oy = n.y;
			let moved = false;
			const drawing = ui.graph.mode === 'draw' || ui.graph.mode === 'loose';
			const ghost = drawing ? s('path', { class: 'ghost' }) : null;
			if (ghost) svg.append(ghost);
			const move = (e2) => {
				const p = pointIn(e2);
				if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 4) moved = true;
				if (drawing) { ghost.setAttribute('d', 'M' + (ox + W) + ',' + (oy + H / 2) + ' L' + p.x + ',' + p.y); return; }
				if (ui.graph.mode !== 'select') return;
				n.x = Math.max(0, ox + p.x - start.x); n.y = Math.max(0, oy + p.y - start.y);
				el.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
				drawEdges();
			};
			const up = (e2) => {
				window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
				if (ghost) ghost.remove();
				if (drawing) {
					const p = pointIn(e2);
					const hit = [...nodes.values()].find(m => p.x >= m.x && p.x <= m.x + W && p.y >= m.y && p.y <= m.y + H);
					if (hit && hit.id !== n.id) linkNodes(n, hit, ui.graph.mode);
					return;
				}
				if (moved) post({ type: 'savePosition', id: n.id, x: n.x, y: n.y });
				else clickNode(n);
			};
			window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
		});
		nodeLayer.append(el);
	}
	drawEdges();
	svg.addEventListener('pointerdown', () => { if (ui.graph.selected) { ui.graph.selected = null; drawMain(); } });
	const mode = (m, text, title) => h('button', { class: ui.graph.mode === m ? 'on' : '', title, onclick: () => { ui.graph.mode = m; ui.graph.target = null; saveGraph(); drawMain(); } }, text);
	const top = h('div', { class: 'graph-top' },
		mode('select', 'Select', 'Click to select, drag to move'),
		mode('draw', 'Draw prerequisite', 'Drag from one task to another: the first becomes the prerequisite of the second, on GitHub too'),
		mode('loose', 'Draw loose link', 'A link that blocks nothing; kept in this workspace'),
		h('button', { onclick: () => post({ type: 'autoLayout' }) }, 'Auto layout'),
		h('button', { class: ui.graph.critical ? 'on' : '', onclick: () => { ui.graph.critical = !ui.graph.critical; saveGraph(); drawMain(); } }, 'Critical path'),
		h('button', { title: 'Zoom out', onclick: () => { ui.graph.zoom = Math.max(0.4, ui.graph.zoom - 0.15); saveGraph(); drawMain(); } }, '−'),
		h('button', { title: 'Zoom in', onclick: () => { ui.graph.zoom = Math.min(1.8, ui.graph.zoom + 0.15); saveGraph(); drawMain(); } }, '+'),
		h('span', { class: 'muted' }, ui.graph.mode === 'pick' ? 'Click the task that has to come first.' : ui.graph.mode === 'draw' ? 'Drag a line from one task to another: it becomes its prerequisite, on GitHub too.' : ui.graph.mode === 'loose' ? 'Drag a line between two tasks: a loose link, it blocks nothing.' : 'Drag to move · click for details'));
	return h('div', {}, top, h('div', { class: 'graph-body' }, h('div', { class: 'canvas' }, svg), sideEl(g, nodes)),
		h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'border:2px solid var(--vscode-testing-iconFailed, #f85149)' }), 'critical path'), h('span', {}, '── prerequisite'), h('span', {}, '- - loose link (blocks nothing)'), h('span', {}, '··· leads to the release')));
}

function linkNodes(a, b, mode) {
	if (a.kind === 'milestone' || b.kind === 'milestone') return;
	if (mode === 'loose') { post({ type: 'addLoose', a: a.id, b: b.id }); return; }
	if (!a.linkable || !b.linkable) { post({ type: 'notice', text: 'Prerequisites link issues only.' }); return; }
	post({ type: 'addDependency', blocking: a.id, blocked: b.id });
}
function clickNode(n) {
	if (ui.graph.mode === 'pick' && ui.graph.target) {
		const target = model.graph.nodes.find(x => x.id === ui.graph.target);
		if (target && n.id !== target.id) linkNodes(n, target, 'draw');
		ui.graph.mode = 'select'; ui.graph.target = null; drawMain(); return;
	}
	ui.graph.selected = { node: n.id }; drawMain();
}

function sideEl(g, nodes) {
	const sel = ui.graph.selected;
	if (!sel) return h('aside', { class: 'side' }, h('div', { class: 'muted' }, 'Select a task to see what it waits for and what waits for it. When every prerequisite of a task is done, it is startable, and one click starts a room on it.'));
	if (sel.edge) {
		const e = sel.edge, a = nodes.get(e.from), b = nodes.get(e.to);
		const what = e.kind === 'blocks' ? a.label + ' must come before ' + b.label : e.kind === 'loose' ? a.label + ' and ' + b.label + ' are loosely linked' : a.label + ' leads to ' + b.title;
		return h('aside', { class: 'side' }, h('div', { class: 'title' }, what),
			e.kind === 'blocks' ? h('div', { class: 'muted' }, 'A GitHub "blocked by" link.') : e.kind === 'loose' ? h('div', { class: 'muted' }, 'Kept in this workspace; blocks nothing.') : null,
			e.kind === 'blocks' ? h('button', { onclick: () => { post({ type: 'removeDependency', blocking: e.from, blocked: e.to }); ui.graph.selected = null; } }, 'Remove the prerequisite')
				: e.kind === 'loose' ? h('button', { onclick: () => { post({ type: 'removeLoose', a: e.from, b: e.to }); ui.graph.selected = null; } }, 'Remove the loose link') : null);
	}
	const n = nodes.get(sel.node);
	if (!n) return h('aside', { class: 'side' });
	const before = g.edges.filter(e => e.to === n.id && e.kind === 'blocks').map(e => nodes.get(e.from));
	const after = g.edges.filter(e => e.from === n.id && e.kind !== 'loose').map(e => nodes.get(e.to));
	const loose = g.edges.filter(e => e.kind === 'loose' && (e.from === n.id || e.to === n.id)).map(e => nodes.get(e.from === n.id ? e.to : e.from));
	const item = (m, state) => h('li', {}, h('a', { onclick: () => { ui.graph.selected = { node: m.id }; drawMain(); } }, m.label + ' ' + cut(m.title, 34)), state ? h('span', { class: 'muted' }, ' · ' + state) : null);
	const crit = g.critical.find(c => c.lane === n.lane);
	return h('aside', { class: 'side' },
		h('div', { class: 'muted' }, n.label + (n.status ? ' · ' + n.status : '') + (n.kind === 'task' ? ' · ' + n.lane : '')),
		h('div', { class: 'title' }, n.title),
		n.sub ? chip(n.sub, n.tone) : null,
		n.kind === 'task' ? [h('h4', {}, 'Prerequisites'), before.length ? h('ul', {}, before.map(m => item(m, m.done ? 'done' : 'open'))) : h('div', { class: 'muted' }, 'None')] : [h('h4', {}, 'Waits for'), h('ul', {}, g.edges.filter(e => e.to === n.id).map(e => item(nodes.get(e.from), nodes.get(e.from).done ? 'done' : 'open')))],
		n.kind === 'task' && after.length ? [h('h4', {}, 'It blocks'), h('ul', {}, after.map(m => item(m, m.kind === 'milestone' ? 'release' : 'waits for it')))] : null,
		loose.length ? [h('h4', {}, 'Loose links'), h('ul', {}, loose.map(m => item(m, '')))] : null,
		n.critical && crit ? [h('h4', {}, 'Critical path to ' + crit.lane), h('div', {}, crit.path.join(' → ')), h('div', { class: 'muted' }, 'A slip of ' + n.label + ' pushes the whole release.')] : null,
		h('div', { class: 'row' },
			n.roomId ? h('button', { class: 'primary', onclick: () => post({ type: 'openRoom', roomId: n.roomId }) }, 'Go to the running room') : null,
			n.startable && !n.roomId ? h('button', { class: 'primary', onclick: () => post({ type: 'startRoom', itemId: n.id }) }, 'Start room ▸') : null,
			n.linkable ? h('button', { onclick: () => { ui.graph.mode = 'pick'; ui.graph.target = n.id; drawMain(); } }, 'Add prerequisite') : null,
			n.url ? h('button', { onclick: () => post({ type: 'open', url: n.url }) }, 'Open on GitHub') : null));
}
window.addEventListener('keydown', (e) => {
	if (ui.tab !== 'graph' || !ui.graph.selected || !ui.graph.selected.edge) return;
	if (e.key !== 'Delete' && e.key !== 'Backspace') return;
	if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName || '')) return;
	const ed = ui.graph.selected.edge;
	if (ed.kind === 'blocks') post({ type: 'removeDependency', blocking: ed.from, blocked: ed.to });
	if (ed.kind === 'loose') post({ type: 'removeLoose', a: ed.from, b: ed.to });
	ui.graph.selected = null; drawMain();
});

let mainEl = null;
function drawMain() {
	if (!mainEl) return;
	mainEl.replaceChildren(ui.tab === 'table' ? tableEl() : ui.tab === 'plan' ? planEl() : ui.tab === 'graph' ? graphEl() : boardEl());
}
function draw() {
	if (screen) { document.body.replaceChildren(emptyEl(screen)); return; }
	if (!model) return;
	const scroll = mainEl ? mainEl.querySelector('.board, .table-wrap') : null;
	const left = scroll ? scroll.scrollLeft : 0;
	mainEl = h('main', {});
	document.body.replaceChildren(headerEl(), mainEl, footerEl());
	drawMain();
	const again = mainEl.querySelector('.board, .table-wrap');
	if (again) again.scrollLeft = left;
}
function emptyEl(s) {
	return h('div', { class: 'empty' }, h('div', { class: 'title' }, s.title), s.text ? h('div', { class: 'muted' }, s.text) : null,
		h('div', { class: 'row' }, (s.actions || []).map((a, i) => h('button', { class: i === 0 ? 'primary' : '', onclick: () => post({ type: a.command }) }, a.label))));
}
window.addEventListener('message', (e) => {
	const m = e.data;
	if (m.type === 'model') { model = m.model; screen = null; draw(); }
	if (m.type === 'screen') { screen = m.screen; draw(); }
});
post({ type: 'ready' });
`;

export function boardHtml(nonce: string, cspSource: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Project</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

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
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; border: 1px solid var(--vscode-panel-border); }
`;

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const ui = { tab: saved.tab || 'board', filters: saved.filters || {}, search: saved.search || '', open: saved.open || {}, sort: saved.sort || null, form: false };
let model = null;
let screen = null;
const save = () => vscode.setState({ tab: ui.tab, filters: ui.filters, search: ui.search, open: ui.open, sort: ui.sort });
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

function cardValue(card, key) {
	if (key === 'labels') return card.labels;
	if (key === 'assignees') return card.assignees;
	const f = card.fields.find(x => 'f:' + x.fieldId === key);
	return f ? [f.value] : [];
}
function visible(card) {
	for (const [key, want] of Object.entries(ui.filters)) {
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
			h('div', { class: 'tabs' }, ['board', 'table', 'plan'].map(t => h('button', { class: ui.tab === t ? 'on' : '', onclick: () => { ui.tab = t; save(); draw(); } }, { board: 'Board', table: 'Table', plan: 'Plan' }[t]))),
			h('button', { title: 'Read the project again', onclick: () => post({ type: 'refresh' }) }, '↻'),
			h('button', { class: 'primary', onclick: () => { ui.form = !ui.form; draw(); } }, '+ New issue')),
		ui.form ? newIssueForm() : null,
		h('div', { class: 'row' }, search, model.filters.map(f => {
			const sel = h('select', { onchange: () => { ui.filters[f.key] = sel.value; save(); drawMain(); } }, h('option', { value: '' }, f.name + ': all'), f.values.map(v => h('option', { value: v, selected: ui.filters[f.key] === v }, f.name + ': ' + v)));
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

let mainEl = null;
function drawMain() {
	if (!mainEl) return;
	mainEl.replaceChildren(ui.tab === 'table' ? tableEl() : ui.tab === 'plan' ? planEl() : boardEl());
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

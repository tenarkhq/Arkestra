/*---------------------------------------------------------------------------------------------
 *  Arkestra. The board page's script against a minimal fake DOM: header and menu, board, drag to
 *  a column, start a room, table filters, groups, columns, details pane, new issue form, empty screen.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { boardHtml } from '../boardHtml';
import { boardModel } from '../board';
import { planModel } from '../plan';
import { graphModel } from '../graph';

test('the board page draws and posts what the user does', async () => {
const html = boardHtml('n', 'c');
const g: any = globalThis;
const realTimeout = g.setTimeout;

const script = html.split('<script nonce="n">')[1].split('</script>')[0];

class Node_ { children: any[] = []; constructor() { } append(...k: any[]) { this.children.push(...k); } replaceChildren(...k: any[]) { this.children = k; } }
class Text_ extends Node_ { constructor(public text: string) { super(); } }
class El extends Node_ {
	attrs: any = {}; listeners: any = {}; style: any = {}; classList = { add() { }, remove() { } }; value: any = ''; constructor(public tag: string) { super(); }
	setAttribute(k: string, v: any) { this.attrs[k] = v; if (k === 'value') this.value = v; }
	addEventListener(k: string, f: any) { (this.listeners[k] ??= []).push(f); }
	querySelector() { return null; }
	focus() { }
	fire(k: string, e: any = {}) { for (const f of this.listeners[k] ?? []) f({ preventDefault() { }, stopPropagation() { }, ...e }); }
}
const posted: any[] = [];
const listeners: any = {};
const body = new El('body');
g.Node = Node_;
g.document = { createElement: (t: string) => new El(t), createElementNS: (_ns: string, t: string) => new El(t), createTextNode: (t: string) => new Text_(t), body };
g.__win = {};
g.window = { addEventListener: (k: string, f: any) => { listeners[k] = f; (g.__win[k] ??= []).push(f); }, removeEventListener: (k: string, f: any) => { g.__win[k] = (g.__win[k] ?? []).filter((x: any) => x !== f); } };
let state: any;
g.acquireVsCodeApi = () => ({ getState: () => state, setState: (s: any) => { state = s; }, postMessage: (m: any) => posted.push(m) });

g.setTimeout = (f: any) => f();
new Function(script)();

const find = (el: any, pred: (e: any) => boolean, acc: any[] = []): any[] => { if (pred(el)) acc.push(el); for (const k of el.children ?? []) find(k, pred, acc); return acc; };
const text = (el: any): string => el instanceof Text_ ? el.text : (el.children ?? []).map(text).join('');

const snap: any = {
	id: 'P1', owner: 'o', number: 3, title: 'Arkestra', url: 'https://github.com/orgs/o/projects/3', fetchedAt: 0,
	fields: [{ id: 'S', name: 'Status', type: 'single_select', options: [{ id: 'r', name: 'Ready', color: 'BLUE' }, { id: 'd', name: 'Done' }] }, { id: 'L', name: 'Line', type: 'text' }, { id: 'N', name: 'Estimate', type: 'number' }],
	items: [
		{ id: 'I1', type: 'issue', contentId: 'C1', number: 1, title: 'Board view', url: 'https://github.com/o/r/issues/1', state: 'OPEN', repository: 'o/r', labels: ['feature'], assignees: [], fields: { S: { kind: 'option', optionId: 'r', name: 'Ready' }, L: { kind: 'text', text: '0.9' } }, blockedBy: [], pullRequests: [] },
		...Array.from({ length: 5 }, (_: unknown, i: number) => ({ id: 'D' + i, type: 'issue', contentId: 'CD' + i, number: 10 + i, title: 'Old ' + i, state: 'CLOSED', repository: 'o/r', labels: [], assignees: [], fields: { S: { kind: 'option', optionId: 'd', name: 'Done' } }, blockedBy: [], pullRequests: [] })),
	],
};
const model = boardModel({ snapshot: snap, rooms: [{ roomId: 'x', title: 't', refs: ['#10'], type: 'coding', status: 'ended', phase: 'kész', agents: 2 }], status: { kind: 'synced', at: 0, live: true }, live: true, journal: [{ at: 0, direction: 'in', item: '#1', text: 'issues opened' }], clock: () => '14:12:08' });

listeners.message({ data: { type: 'model', ref: 'o/3', model: { ...model, pinned: false } } });
assert.equal(state.ref, 'o/3', 'the tab keeps its project for the next start');
const button = (label: string) => find(body, (e: any) => e.tag === 'button' && text(e) === label)[0];
// The header: title, "owner/number · synced", the view switch, + New issue, and the ⋯ menu.
assert.ok(text(body).includes('o/3 · live · updated 14:12'), 'sync state as a subtitle: live only with the relay');
const more = () => find(body, (e: any) => e.tag === 'button' && e.attrs.title === 'More actions')[0];
more().fire('click');
button('Pin this board').fire('click');
more().fire('click');
button('+ Boardanother project').fire('click');
assert.ok(posted.some((m: any) => m.type === 'togglePin') && posted.some((m: any) => m.type === 'openBoard'), 'pin and open another board posted');
listeners.message({ data: { type: 'model', ref: 'o/3', model: { ...model, pinned: true } } });
assert.ok(text(body).includes('· pinned'), 'pinned shown');
listeners.message({ data: { type: 'model', model: { ...model, sync: { text: 'x', tone: 'muted', kind: 'polling', at: '14:00:05', everyMin: 1 } } } });
const polled = find(body, (e: any) => e.tag === 'span' && text(e) === 'updated 14:00 · every 1 min');
assert.equal(polled.length, 1, 'without the relay: a neutral "updated" with the interval');
assert.ok(!polled[0].className && /relay \(an optional push channel\) is not connected/.test(polled[0].attrs.title), 'not a warning; the relay only in the hover');
assert.ok(!text(body).includes('relay offline') && !find(body, (e: any) => e.className === 'warn').length, 'no relay warning');
listeners.message({ data: { type: 'model', model } });
const t1 = text(body);
assert.ok(t1.includes('Line0.9') && t1.includes('Board view') && t1.includes('Start room ▸') && !t1.includes('Old 0') && t1.includes('GitHub → here'), 'board drawn, done hidden by default');
button('Start room ▸').fire('click');
assert.ok(posted.some((m: any) => m.type === 'startRoom' && m.itemId === 'I1'), 'start room posted');
// A card opens the details pane on the Board too; ✕ closes it.
const aside = () => find(body, (e: any) => e.tag === 'aside')[0];
find(body, (e: any) => String(e.className ?? '').startsWith('card') && e.attrs['data-id'] === 'I1')[0].fire('click');
assert.ok(state.selected === 'I1' && text(aside()).includes('Board view') && text(aside()).includes('Open on GitHub'), 'board card opens the details pane');
assert.ok(find(body, (e: any) => e.className === 'card sel').length === 1, 'the card shows as selected');
find(aside(), (e: any) => e.tag === 'button' && e.attrs.title === 'Close')[0].fire('click');
assert.ok(!aside() && state.selected === null, 'board details closed');
// drag I1 to Done
const done = find(body, (e: any) => e.tag === 'section' && text(e).startsWith('Done'))[0];
done.fire('drop', { dataTransfer: { getData: () => 'I1', types: ['text/arkestra-item'] } });
assert.ok(posted.some((m: any) => m.type === 'move' && m.itemId === 'I1' && m.optionId === 'd'), 'move posted');
const statusSel = () => find(body, (e: any) => e.tag === 'select' && text(e).startsWith('Status: all'))[0];
statusSel().value = ''; statusSel().fire('change');
assert.ok(text(body).includes('+ 2 more'), 'done back on the board');
statusSel().value = '!done'; statusSel().fire('change');
// table: plain cells, grouped by Line, default columns
button('Table').fire('click');
const t2 = text(body);
assert.ok(t2.includes('Board view') && t2.includes('Estimate') && t2.includes('Blocked by') && !t2.includes('Old 0'), 'table drawn');
assert.ok(find(body, (e: any) => e.className === 'grp' && text(e) === '0.91').length === 1, 'group header with its count');
assert.ok(!find(body, (e: any) => e.className === 'tr th' && text(e).includes('Line')).length, 'the grouped column is hidden');
assert.ok(!find(body, (e: any) => e.className?.startsWith?.('tr') && find(e, (x: any) => x.tag === 'select' || x.tag === 'input').length).length, 'no dropdowns in the grid');
assert.ok(text(statusSel()).includes('Status: not done') && text(statusSel()).includes('Status: Done'), 'status filter offered');
assert.equal(state.filters.status, '!done', 'kept in the view state');
statusSel().value = ''; statusSel().fire('change');
assert.ok(text(body).includes('Old 0') && text(body).includes('No Line'), 'done back, in the no-Line group');
statusSel().value = '!done'; statusSel().fire('change');
// + Filter adds a chip; × takes it away
button('+ Filter').fire('click');
button('Label').fire('click');
assert.deepEqual(state.extra, ['labels']);
const labelSel = find(body, (e: any) => e.tag === 'select' && text(e).startsWith('Label: all'))[0];
labelSel.value = 'feature'; labelSel.fire('change');
assert.equal(state.filters.labels, 'feature');
find(body, (e: any) => e.tag === 'button' && e.attrs.title === 'Remove filter')[0].fire('click');
assert.ok(!('labels' in state.filters) && state.extra.length === 0, 'filter removed');
// a row opens the details pane: every field editable, GitHub, no chat without the command
find(body, (e: any) => e.attrs?.['data-id'] === 'I1')[0].fire('click');
assert.equal(state.selected, 'I1');
const pane = () => find(body, (e: any) => e.tag === 'aside')[0];
assert.ok(text(pane()).includes('#1') && text(pane()).includes('Open on GitHub') && !text(pane()).includes('Chat about this'), 'details pane');
const input = find(pane(), (e: any) => e.tag === 'input' && e.attrs.type === 'number')[0];
input.value = '3'; input.fire('change');
assert.ok(posted.some((m: any) => m.type === 'setField' && m.fieldId === 'N' && m.value === 3), 'number edit posted');
const paneStatus = find(pane(), (e: any) => e.tag === 'select' && e.attrs.title === 'Status')[0];
paneStatus.value = 'd'; paneStatus.fire('change');
assert.ok(posted.some((m: any) => m.type === 'setField' && m.fieldId === 'S' && m.value.optionId === 'd'), 'status edit posted');
listeners.message({ data: { type: 'model', model: { ...model, canChat: true } } });
button('Chat about this').fire('click');
assert.ok(posted.some((m: any) => m.type === 'chat' && m.itemId === 'I1'), 'chat posted');
button('Open on GitHub').fire('click');
assert.ok(posted.some((m: any) => m.type === 'open' && m.url === 'https://github.com/o/r/issues/1'), 'open posted');
find(pane(), (e: any) => e.tag === 'button' && e.attrs.title === 'Close')[0].fire('click');
assert.ok(!pane() && state.selected === null, 'pane closed');
// double-click a cell edits it in place
const cell = find(body, (e: any) => e.attrs?.['data-id'] === 'I1')[0].children[3];
cell.fire('dblclick');
assert.ok(find(cell, (e: any) => e.tag === 'input' && e.attrs.type === 'number').length === 1, 'inline editor');
// columns chooser and group by, kept in the state
more().fire('click');
button('Columns…').fire('click');
button('Labels').fire('click');
assert.deepEqual(state.columns, ['num', 'title', 'status', 'f:L', 'f:N', 'prereq', 'labels']);
assert.ok(text(find(body, (e: any) => e.className === 'tr th')[0]).includes('Labels'), 'column added');
find(body, (e: any) => e.tag === 'button' && text(e) === 'Group: Line')[0].fire('click');
button('None').fire('click');
assert.equal(state.group, '');
assert.ok(text(find(body, (e: any) => e.className === 'tr th')[0]).includes('Line'), 'Line column back without grouping');
find(body, (e: any) => e.tag === 'span' && text(e) === 'Title' && e.listeners.click)[0].fire('click');
assert.deepEqual(state.sort, { key: 'title', dir: 1 });
// new issue form
button('+ New issue').fire('click');
const title = find(body, (e: any) => e.tag === 'input' && e.attrs.placeholder === 'Title of the new issue')[0];
title.value = 'New task';
button('Create').fire('click');
assert.ok(posted.some((m: any) => m.type === 'createIssue' && m.title === 'New task' && m.repository === 'o/r'), 'create posted');
const plan = planModel({ snapshot: snap, rooms: [], git: { base: 'main', baseHead: 'abc1234', tags: ['v1.0'], log: [{ sha: 'abc1234', subject: 'Board (#70)', refs: [] }], branches: new Map() } });
const graph = graphModel(snap, [], plan);
listeners.message({ data: { type: 'model', model: { ...model, plan, graph } } });
find(body, (e: any) => e.tag === 'button' && text(e) === 'Plan')[0].fire('click');
const t3 = text(body);
assert.ok(t3.includes('Release lanes') && t3.includes('Dependency staircase') && t3.includes('abc1234') && t3.includes('#70') && t3.includes('Live: v1.0'), 'plan drawn');
// The same filter row on the Plan, with the same state: done tasks (Backlog here) hidden by "not done".
assert.ok(statusSel() && state.filters.status === '!done', 'filter row on the Plan, its state kept');
const cells = () => find(body, (e: any) => String(e.className ?? '').startsWith('cell'));
assert.deepEqual(cells().map((c: any) => c.attrs['data-id']), ['I1'], 'only the tasks the filters let through');
assert.ok(text(body).includes('levels, progress and the critical path count every task'), 'the filtered staircase says so');
const stairsEl = find(body, (e: any) => e.className === 'stairs')[0];
assert.match(stairsEl.style.cssText ?? stairsEl.attrs.style ?? '', /repeat\(\d+, minmax\(140px, 320px\)\)/, 'columns capped');
cells()[0].fire('click');
assert.ok(state.selected === 'I1' && text(aside()).includes('Open on GitHub'), 'a staircase cell opens the details pane');
button('Open on GitHub').fire('click');
assert.ok(posted.some((m: any) => m.type === 'open' && m.url === 'https://github.com/o/r/issues/1'), 'the task opens from the details');
statusSel().value = ''; statusSel().fire('change');
const doneCell = cells().find((c: any) => c.attrs['data-id'] === 'D0');
assert.ok(doneCell && doneCell.className.split(' ').includes('done') && text(doneCell).startsWith('✓ #10'), 'a done task reads as done');
assert.ok(text(body).includes('✓ done') && text(body).includes('in progress (fill = how far)'), 'legend: done and progress');
statusSel().value = '!done'; statusSel().fire('change');
find(body, (e: any) => e.tag === 'button' && text(e) === 'Graph')[0].fire('click');
const t4 = text(body);
assert.ok(t4.includes('Draw prerequisite') && t4.includes('Auto layout') && t4.includes('Release'), 'graph drawn');
assert.ok(statusSel(), 'filter row on the Graph');
assert.ok(!find(body, (e: any) => e.tag === 'g' && e.attrs['data-node'] === 'D0').length, 'a filtered-out task is not drawn');
{
	// The canvas is cut to the shown tasks: its view box starts near the topmost-leftmost shown node.
	const svgEl = find(find(body, (e: any) => e.className === 'canvas')[0], (e: any) => e.tag === 'svg')[0];
	const shownNodes = find(body, (e: any) => e.tag === 'g' && e.attrs['data-node']).map((e: any) => /translate\(([\d.]+),([\d.]+)\)/.exec(e.attrs.transform)!.slice(1).map(Number));
	const [vx, vy, vw, vh] = String(svgEl.attrs.viewBox).split(' ').map(Number);
	assert.equal(vx, Math.max(0, Math.min(...shownNodes.map(p => p[0])) - 40), 'view box starts at the shown nodes (x)');
	assert.equal(vy, Math.max(0, Math.min(...shownNodes.map(p => p[1])) - 40), 'view box starts at the shown nodes (y)');
	assert.equal(vw, Math.max(...shownNodes.map(p => p[0])) + 200 + 40 - vx, 'view box ends at the shown nodes (x)');
	assert.ok(vh > 0);
}
statusSel().value = ''; statusSel().fire('change');
const node = find(body, (e: any) => e.tag === 'g' && e.attrs['data-node'] === 'I1')[0];
node.fire('pointerdown', { clientX: 10, clientY: 10 });
for (const f of [...(g.__win.pointerup ?? [])]) f({ clientX: 10, clientY: 10 });
assert.equal(state.selected, 'I1', 'a graph node opens the details pane');
assert.ok(text(aside()).includes('Board view') && text(aside()).includes('Prerequisites') && text(aside()).includes('Add prerequisite'), 'node details with its links');
assert.ok(find(find(body, (e: any) => e.tag === 'g' && e.attrs['data-node'] === 'D0')[0], (e: any) => e.attrs?.class === 'meter-done').length === 1, 'a done node has the green completion bar');
find(body, (e: any) => e.tag === 'button' && text(e) === 'Add prerequisite')[0].fire('click');
const other = find(body, (e: any) => e.tag === 'g' && e.attrs['data-node'] === 'D0')[0];
other.fire('pointerdown', { clientX: 0, clientY: 0 });
for (const f of [...(g.__win.pointerup ?? [])]) f({ clientX: 0, clientY: 0 });
assert.ok(posted.some((m: any) => m.type === 'addDependency' && m.blocking === 'D0' && m.blocked === 'I1'), 'prerequisite posted');
listeners.keydown({ key: 'Escape' });
assert.ok(!find(body, (e: any) => e.tag === 'aside' && e.className === 'details').length && state.selected === null, 'Escape closes the details pane');
find(body, (e: any) => e.tag === 'button' && text(e) === 'Auto layout')[0].fire('click');
assert.ok(posted.some((m: any) => m.type === 'autoLayout'), 'auto layout posted');
listeners.message({ data: { type: 'screen', screen: { title: 'No GitHub Project for this workspace', text: 'x', actions: [{ label: 'Follow a project…', command: 'setProject' }] } } });
assert.ok(text(body).includes('No GitHub Project'), 'empty screen');
// Follow a project…: the board's own list and a typed field, no quick pick at the top.
const picker = { loading: false, current: 'o/3', projects: [{ ref: 'o/3', title: 'Arkestra', detail: 'o/3 · current', current: true }, { ref: 'me/1', title: 'Mine', detail: 'me/1', current: false }] };
listeners.message({ data: { type: 'screen', screen: { title: 'Follow a GitHub Project', picker, actions: [{ label: 'Cancel', command: 'pickCancel' }] } } });
assert.ok(text(body).includes('Arkestra') && text(body).includes('me/1') && text(body).includes('Or type one:'), 'the projects and the typed field');
assert.equal(find(body, (e: any) => e.tag === 'button' && e.className === 'pick on').length, 1, 'the current one marked');
find(body, (e: any) => e.tag === 'button' && text(e).startsWith('Mine'))[0].fire('click');
assert.deepEqual(posted.at(-1), { type: 'followProject', ref: 'me/1' });
const pickField = find(body, (e: any) => e.tag === 'input' && e.attrs.id === 'pickRef')[0];
assert.equal(pickField.value, 'o/3', 'the field starts with the followed project');
pickField.value = 'https://github.com/orgs/acme/projects/7';
pickField.fire('input');
pickField.fire('keydown', { key: 'Enter' });
assert.deepEqual(posted.at(-1), { type: 'followProject', ref: 'https://github.com/orgs/acme/projects/7' });
listeners.message({ data: { type: 'screen', screen: { title: 'Follow a GitHub Project', picker: { ...picker, error: 'No project acme/7.' }, actions: [{ label: 'Cancel', command: 'pickCancel' }] } } });
assert.ok(text(body).includes('No project acme/7.'), 'what is wrong, on the page');
assert.equal(find(body, (e: any) => e.tag === 'input' && e.attrs.id === 'pickRef')[0].value, 'https://github.com/orgs/acme/projects/7', 'the typed text survives the redraw');
find(body, (e: any) => e.tag === 'button' && text(e) === 'Cancel')[0].fire('click');
assert.deepEqual(posted.at(-1), { type: 'pickCancel' });


g.setTimeout = realTimeout;
});

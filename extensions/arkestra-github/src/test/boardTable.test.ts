/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Table view's logic: field roles, filters and search, grouping by Line,
 *  default and chosen columns, cell text and tones, sorting; and that it runs on its own.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { boardModel, fieldRoles, tableLogic, type BoardModel } from '../board';
import type { ProjectItem, ProjectSnapshot } from '../project';

const item = (id: string, n: number, over: Partial<ProjectItem> = {}): ProjectItem => ({
	id, type: 'issue', contentId: `C${n}`, number: n, title: `Task ${n}`, url: `https://github.com/o/r/issues/${n}`, state: 'OPEN', repository: 'o/r',
	labels: [], assignees: [], fields: {}, blockedBy: [], pullRequests: [], ...over,
});
const opt = (optionId: string, name: string) => ({ kind: 'option' as const, optionId, name });
const text = (t: string) => ({ kind: 'text' as const, text: t });

const snap: ProjectSnapshot = {
	id: 'P1', owner: 'csorbar', number: 1, title: 'Tenark', url: 'https://github.com/users/csorbar/projects/1', fetchedAt: 0,
	fields: [
		{ id: 'S', name: 'Status', type: 'single_select', options: [{ id: 'w', name: 'Waiting' }, { id: 'p', name: 'In progress' }, { id: 'd', name: 'Done' }] },
		{ id: 'L', name: 'Line', type: 'single_select', options: [{ id: 'l3', name: '3.2.n' }, { id: 'lb', name: 'Binance' }, { id: 'lr', name: 'release candidate' }] },
		{ id: 'V', name: 'Végrehajtó', type: 'single_select', options: [{ id: 'cx', name: 'Codex' }, { id: 'cl', name: 'Claude' }] },
		{ id: 'R', name: 'Reviewer agent', type: 'single_select', options: [{ id: 'rcx', name: 'Codex' }, { id: 'rcl', name: 'Claude' }] },
		{ id: 'EM', name: 'Executor modell', type: 'text' },
		{ id: 'E', name: 'Előfeltétel', type: 'text' },
		{ id: 'N', name: 'Size', type: 'number' },
		{ id: 'T', name: 'Title', type: 'other' },
	],
	items: [
		item('I2189', 2189, { title: 'T560 · Számlahatókör igazolása', fields: { L: opt('lb', 'Binance'), V: opt('cx', 'Codex'), R: opt('rcl', 'Claude'), E: text('Hiányzik a natív válasz'), N: { kind: 'number', number: 3 } } }),
		item('I2188', 2188, { title: 'T560 · Díjas kiutalás', fields: { L: opt('lb', 'Binance'), V: opt('cx', 'Codex'), E: text('Hiányzik az azonosító'), N: { kind: 'number', number: 5 } }, labels: ['bug'] }),
		item('I3215', 3215, { title: 'T586 · BTC kézi feloldás', fields: { L: opt('l3', '3.2.n'), V: opt('cl', 'Claude'), R: opt('rcx', 'Codex') } }),
		item('I629', 629, { title: 'T266 · Többnyelvű Console', fields: { S: opt('w', 'Waiting'), L: opt('lr', 'release candidate'), E: text('✓ 1.3.x kiadva') } }),
		item('I633', 633, { title: 'T267 · Telepítő', fields: { S: opt('w', 'Waiting'), L: opt('lr', 'release candidate'), E: text('T272, T273') }, blockedBy: [{ id: 'C634', number: 634, repository: 'o/r' }] }),
		item('I634', 634, { title: 'T268 · Telepítési dokumentáció', fields: { S: opt('p', 'In progress') } }),
		item('I1', 1, { title: 'Old', state: 'CLOSED', fields: { S: opt('d', 'Done'), L: opt('l3', '3.2.n') } }),
	],
};

const model = (over: Partial<Parameters<typeof boardModel>[0]> = {}): BoardModel => boardModel({ snapshot: snap, rooms: [], status: { kind: 'synced', at: 0, live: true }, live: true, journal: [], clock: () => '23:28', ...over });
const T = tableLogic();

test('field roles: the lane by its name (or the usual names), executor, reviewer, prerequisite note', () => {
	assert.deepEqual(model().roles, { line: 'L', executor: 'V', reviewer: 'R', prereq: 'E' });
	assert.deepEqual(fieldRoles(snap.fields, 'Végrehajtó').line, 'V');
	assert.deepEqual(fieldRoles([{ id: 'X', name: 'Executor', type: 'text' }, { id: 'Y', name: 'Review', type: 'single_select' }, { id: 'Z', name: 'Release', type: 'iteration' }]), { line: 'Z', executor: 'X', reviewer: 'Y' });
	assert.deepEqual(fieldRoles([{ id: 'M', name: 'Executor modell', type: 'text' }]), {}, 'a model field is not the executor');
});

test('filters: not done, a field value, labels; search by title or #N', () => {
	const m = model();
	const rows = T.rows(m);
	const ids = (list: readonly { card: { number?: number } }[]) => list.map(r => r.card.number).sort((a, b) => a! - b!);
	assert.equal(rows.length, 7);
	assert.deepEqual(ids(T.filter(rows, { status: '!done' }, '')), [629, 633, 634, 2188, 2189, 3215]);
	assert.deepEqual(ids(T.filter(rows, { status: '!done', 'f:L': 'Binance' }, '')), [2188, 2189]);
	assert.deepEqual(ids(T.filter(rows, { status: '', labels: 'bug' }, '')), [2188]);
	assert.deepEqual(ids(T.filter(rows, { status: 'No status' }, '')), [2188, 2189, 3215]);
	assert.deepEqual(ids(T.filter(rows, {}, '#633')), [633]);
	assert.deepEqual(ids(T.filter(rows, {}, '633')), [633]);
	assert.deepEqual(ids(T.filter(rows, {}, 'telep')), [633, 634]);
	assert.deepEqual(ids(T.filter(rows, {}, '  ')), ids(rows));
});

test('grouping: by Line in the option order, the empty group last; Status in column order', () => {
	const m = model();
	const rows = T.filter(T.rows(m), { status: '!done' }, '');
	assert.equal(T.defaultGroup(m), 'f:L');
	const g = T.groups(m, rows, 'f:L');
	assert.deepEqual(g.map(x => [x.value, x.rows.length]), [['3.2.n', 1], ['Binance', 2], ['release candidate', 2], ['', 1]]);
	assert.deepEqual(T.groups(m, rows, 'status').map(x => x.value), ['No status', 'Waiting', 'In progress']);
	assert.deepEqual(T.groups(m, rows, '').map(x => x.rows.length), [6]);
	assert.deepEqual(T.groupChoices(m).map(c => c.key), ['status', 'f:L', 'f:V', 'f:R', 'f:E']);
	const noLine = model({ snapshot: { ...snap, fields: snap.fields.filter(f => f.id !== 'L') } });
	assert.equal(T.defaultGroup(noLine), '');
});

test('columns: the default set, the grouped column hidden, a chosen set kept and toggled', () => {
	const m = model();
	assert.deepEqual(T.defaultKeys(m), ['num', 'title', 'status', 'f:L', 'f:V', 'f:R', 'f:E']);
	assert.deepEqual(T.visible(m, null, 'f:L').map(c => c.name), ['#', 'Title', 'Status', 'Végrehajtó', 'Reviewer agent', 'Előfeltétel']);
	assert.deepEqual(T.visible(m, null, '').map(c => c.key), ['num', 'title', 'status', 'f:L', 'f:V', 'f:R', 'f:E']);
	const more = T.toggle(m, null, 'f:N');
	assert.deepEqual(more, ['num', 'title', 'status', 'f:L', 'f:V', 'f:R', 'f:E', 'f:N']);
	assert.deepEqual(T.toggle(m, more, 'f:V'), ['num', 'title', 'status', 'f:L', 'f:R', 'f:E', 'f:N']);
	assert.deepEqual(T.toggle(m, more, 'title'), more, '# and Title stay');
	assert.deepEqual(T.toggle(m, more, 'f:nope'), more);
	// A saved choice: unknown keys dropped, # and Title put back first.
	assert.deepEqual(T.columnKeys(m, ['f:gone', 'labels', 'num']), ['num', 'title', 'labels']);
	assert.deepEqual(T.columnKeys(m, []), T.defaultKeys(m));
	assert.ok(!T.columns(m).some(c => c.key === 'f:T'), 'no column for an "other" field');
	assert.equal(T.columns(m).find(c => c.key === 'f:E')?.type, 'note');
	// Without executor / reviewer fields the card fields fill in; without a note field the blockers show.
	const plain = model({ snapshot: { ...snap, fields: snap.fields.filter(f => !['V', 'R', 'E'].includes(f.id)) } });
	assert.deepEqual(T.defaultKeys(plain), ['num', 'title', 'status', 'f:L', 'f:EM', 'f:N', 'prereq']);
});

test('cells: plain text; status and prerequisite tones; empty dim', () => {
	const m = model();
	const rows = T.rows(m);
	const row = (n: number) => rows.find(r => r.card.number === n)!;
	assert.deepEqual(T.cell(m, row(2189), 'num'), { text: '2189' });
	assert.deepEqual(T.cell(m, row(2189), 'status'), { text: '—', tone: 'none' });
	assert.deepEqual(T.cell(m, row(629), 'status'), { text: 'Waiting', tone: 'warn' });
	assert.deepEqual(T.cell(m, row(634), 'status'), { text: 'In progress', tone: 'run' });
	assert.deepEqual(T.cell(m, row(1), 'status'), { text: 'Done', tone: 'ok' });
	assert.deepEqual(T.cell(m, row(2189), 'f:V'), { text: 'Codex' });
	assert.deepEqual(T.cell(m, row(2188), 'f:R'), { text: '—', tone: 'none' });
	assert.deepEqual(T.cell(m, row(2189), 'f:E'), { text: 'Hiányzik a natív válasz', tone: 'warn' });
	assert.deepEqual(T.cell(m, row(629), 'f:E'), { text: '✓ 1.3.x kiadva', tone: 'ok' });
	assert.deepEqual(T.cell(m, row(633), 'f:E'), { text: 'T272, T273', tone: 'warn' }, 'an open blocker makes the note a warning');
	assert.deepEqual(T.cell(m, row(3215), 'f:E'), { text: '—', tone: 'none' });
	assert.deepEqual(T.cell(m, row(633), 'prereq'), { text: '#634', tone: 'warn' });
	assert.deepEqual(T.cell(m, row(2188), 'labels'), { text: 'bug' });
});

test('sorting: numbers, option order, text; stable; none keeps the board order', () => {
	const m = model();
	const rows = T.filter(T.rows(m), { status: '!done' }, '');
	const nums = (list: readonly { card: { number?: number } }[]) => list.map(r => r.card.number);
	assert.deepEqual(nums(T.sortRows(m, rows, null)), nums(rows));
	assert.deepEqual(nums(T.sortRows(m, rows, { key: 'num', dir: 1 })), [629, 633, 634, 2188, 2189, 3215]);
	assert.deepEqual(nums(T.sortRows(m, rows, { key: 'num', dir: -1 })), [3215, 2189, 2188, 634, 633, 629]);
	assert.deepEqual(nums(T.sortRows(m, rows, { key: 'f:N', dir: -1 })).slice(0, 2), [2188, 2189]);
	assert.deepEqual(nums(T.sortRows(m, rows, { key: 'f:L', dir: 1 })), [3215, 2189, 2188, 629, 633, 634]);
	assert.deepEqual(nums(T.sortRows(m, rows, { key: 'status', dir: 1 })), [2189, 2188, 3215, 629, 633, 634]);
	assert.deepEqual(nums(T.sortRows(m, rows, { key: 'title', dir: 1 })).slice(0, 2), [629, 633]);
});

test('the logic runs from its own source, as the page embeds it', () => {
	const again = new Function('return (' + tableLogic.toString() + ')()')() as ReturnType<typeof tableLogic>;
	const m = JSON.parse(JSON.stringify(model())) as BoardModel;
	assert.deepEqual(again.groups(m, again.filter(again.rows(m), { status: '!done' }, ''), again.defaultGroup(m)).map(g => g.value), ['3.2.n', 'Binance', 'release candidate', '']);
});

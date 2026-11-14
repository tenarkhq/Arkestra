/*---------------------------------------------------------------------------------------------
 *  Arkestra. Mozaik layouts: the default grid, capture and stored-layout checks.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PULT_MAX_LANES, capture, leafCount, mosaic, pult, readLayout, tileFromTab } from '../layout';

test('the default Mozaik has four tiles: room, agents, code, terminal', () => {
	const m = mosaic();
	assert.equal(leafCount(m.layout), 4);
	assert.equal(m.tiles.length, 4);
	assert.deepEqual(m.tiles.map(t => t.map(x => x.kind)), [['room'], ['agents'], [], ['terminal']]);
});

test('capturing keeps the grid and every restorable tab, in grid order', () => {
	const grid = { orientation: 1 as const, groups: [{ size: 0.5 }, { size: 0.5, groups: [{}, {}] }] };
	const saved = capture('Review', grid, [
		[{ type: 'chat' }, { type: 'other' }],
		[{ type: 'text', uri: 'file:///srv/app/state.py' }, { type: 'text', uri: 'untitled:Untitled-1' }],
		[{ type: 'webview', viewType: 'mainThreadWebview-arkestra.agents' }, { type: 'terminal' }],
	]);
	assert.equal(saved.tiles.length, 3);
	assert.deepEqual(saved.tiles, [
		[{ kind: 'room' }],
		[{ kind: 'file', uri: 'file:///srv/app/state.py' }],
		[{ kind: 'agents' }, { kind: 'terminal' }],
	]);
});

test('a stored layout is checked: bad grids are refused, tiles fit the grid', () => {
	assert.equal(readLayout(null), undefined);
	assert.equal(readLayout({ name: 'x', layout: { orientation: 2, groups: [{}] }, tiles: [] }), undefined);
	assert.equal(readLayout({ name: 'x', layout: { orientation: 0, groups: [] }, tiles: [] }), undefined);
	const ok = readLayout({ name: ' Két oszlop ', layout: { orientation: 0, groups: [{ size: 0.5 }, {}] }, tiles: [[{ kind: 'room' }, { kind: 'bogus' }]] });
	assert.deepEqual(ok, { name: 'Két oszlop', layout: { orientation: 0, groups: [{ size: 0.5 }, {}] }, tiles: [[{ kind: 'room' }], []] });
	assert.deepEqual(readLayout(JSON.parse(JSON.stringify(mosaic()))), mosaic());
});

test('tabs that a layout cannot bring back are left out', () => {
	assert.equal(tileFromTab({ type: 'other' }), undefined);
	assert.equal(tileFromTab({ type: 'webview', viewType: 'mainThreadWebview-markdown.preview' }), undefined);
	assert.deepEqual(tileFromTab({ type: 'diff', original: 'git:/a', modified: 'file:///a' }), { kind: 'diff', original: 'git:/a', modified: 'file:///a' });
});

test('Pult: one lane per agent on top, then room, code and terminal; one to four lanes', () => {
	const p = pult(3);
	assert.equal(p.layout.orientation, 1);
	assert.equal(leafCount(p.layout), 6);
	assert.deepEqual(p.tiles, [[{ kind: 'lane', slot: 0 }], [{ kind: 'lane', slot: 1 }], [{ kind: 'lane', slot: 2 }], [{ kind: 'room' }], [], [{ kind: 'terminal' }]]);
	assert.equal(leafCount(pult(0).layout), 4, 'an empty room still gets one lane to invite into');
	assert.equal(leafCount(pult(9).layout), PULT_MAX_LANES + 3);
	assert.deepEqual(readLayout(JSON.parse(JSON.stringify(pult(2)))), pult(2));
});

test('lanes are captured in grid order and a bad lane slot is dropped', () => {
	const grid = { orientation: 0 as const, groups: [{}, {}, {}] };
	const lane = { type: 'webview' as const, viewType: 'mainThreadWebview-arkestra.lane' };
	assert.deepEqual(capture('x', grid, [[lane], [{ type: 'chat' }], [lane]]).tiles, [[{ kind: 'lane', slot: 0 }], [{ kind: 'room' }], [{ kind: 'lane', slot: 1 }]]);
	assert.deepEqual(readLayout({ name: 'x', layout: grid, tiles: [[{ kind: 'lane', slot: -1 }], [{ kind: 'lane', slot: 1.5 }], [{ kind: 'lane', slot: 2 }]] })?.tiles, [[], [], [{ kind: 'lane', slot: 2 }]]);
});

/*---------------------------------------------------------------------------------------------
 *  Arkestra. Mozaik layouts: the default grid, capture and stored-layout checks.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { capture, leafCount, mosaic, readLayout, tileFromTab } from '../layout';

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

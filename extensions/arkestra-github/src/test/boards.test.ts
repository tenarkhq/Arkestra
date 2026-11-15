/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Boards page's model: keys, the boards added before the page had its own list,
 *  and a tile's counts, lines and read state.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { boardKey, boardTile, cacheKey, seedBoards } from '../boards';
import { sampleSnapshot } from './boardsSample';


test('board keys: owner/number or a project URL, lower case; anything else is none', () => {
	assert.equal(boardKey('TenarkHQ/3'), 'tenarkhq/3');
	assert.equal(boardKey(' https://github.com/orgs/TenarkHQ/projects/12 '), 'tenarkhq/12');
	assert.equal(boardKey('https://github.com/users/csorbar/projects/7/views/1'), 'csorbar/7');
	assert.equal(boardKey('tenarkhq/arkestra'), undefined, 'a repository is no project');
	assert.equal(boardKey(''), undefined);
	assert.equal(cacheKey('TenarkHQ/3'), 'arkestra.github.project:tenarkhq/3');
});

test('boards added before the page: the pinned ones, then every project read here once', () => {
	const keys = ['arkestra.github.pinnedProjects', 'arkestra.github.project:tenarkhq/3', 'arkestra.github.project:csorbar/7', 'arkestra.github.project:junk', 'arkestra.artifacts.pinned'];
	assert.deepEqual(seedBoards(['Csorbar/7', 'x/1'], keys), ['csorbar/7', 'x/1', 'tenarkhq/3']);
	assert.deepEqual(seedBoards([], []), []);
});

test('a tile: items, open and done, the lines with their %, the last read', () => {
	const entry = { key: 'tenarkhq/3', title: 'tenarkhq/3', workspace: true, pinned: true };
	const t = boardTile(entry, sampleSnapshot(), { kind: 'synced', at: 1_700_000_100_000, live: true });
	assert.equal(t.title, 'Arkestra');
	assert.equal(t.ref, 'TenarkHQ/3', 'the owner as GitHub spells it');
	assert.deepEqual([t.items, t.open, t.done, t.percent], [4, 1, 3, 75], 'a Done status counts as done even while the issue is open');
	assert.equal(t.state, 'synced');
	assert.equal(t.readAt, 1_700_000_100_000);
	assert.equal(t.url, 'https://github.com/orgs/TenarkHQ/projects/3');
	assert.deepEqual(t.lanes.map(l => `${l.name} ${l.percent}% ${l.done}/${l.total}${l.released ? ' released' : ''}`), ['0.9 100% 2/2 released', '1.0 50% 1/2']);
	assert.ok(t.workspace && t.pinned);
});

test('a tile without a lane field has no lines; one never read, one reading, one failed', () => {
	const entry = { key: 'o/1', title: '', workspace: false, pinned: false };
	const snap = sampleSnapshot();
	const noLane = boardTile(entry, { ...snap, fields: snap.fields.slice(0, 1) }, undefined);
	assert.deepEqual(noLane.lanes, []);
	assert.equal(noLane.readAt, snap.fetchedAt, 'the cached snapshot\'s read time');
	const unread = boardTile(entry, undefined, undefined);
	assert.deepEqual([unread.state, unread.title, unread.ref, unread.items, unread.readAt], ['unread', 'o/1', 'o/1', 0, undefined]);
	assert.equal(boardTile(entry, undefined, { kind: 'loading' }).state, 'reading');
	const failed = boardTile(entry, snap, { kind: 'error', message: 'Bad credentials', at: 1 });
	assert.deepEqual([failed.state, failed.error, failed.items], ['error', 'Bad credentials', 4], 'the last counts stay beside the error');
	assert.equal(boardTile(entry, { ...snap, items: [] }, undefined).percent, 0);
});

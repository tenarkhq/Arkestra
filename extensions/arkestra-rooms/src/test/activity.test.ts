/*---------------------------------------------------------------------------------------------
 *  Arkestra. Agent activity through a round, as the Agents tile shows it.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ActivityBoard } from '../activity';

test('a round: everyone queued, then each answers in turn with its tool line, then idle', () => {
	let t = 0;
	const board = new ActivityBoard(() => new Date(Date.UTC(2026, 10, 14, 15, 0, t++)));
	const changes: string[] = [];
	board.onDidChange(room => changes.push(room));

	board.queue('r', ['claude', 'codex']);
	assert.equal(board.get('r', 'claude').state, 'queued');
	assert.equal(board.get('r', 'codex').state, 'queued');

	board.start('r', 'claude');
	board.tool('r', 'claude', 'Edit src/advisor/state.py');
	assert.deepEqual({ ...board.get('r', 'claude'), since: '' }, { state: 'answering', tool: 'Edit src/advisor/state.py', since: '' });
	board.end('r', 'claude');
	assert.equal(board.get('r', 'claude').state, 'idle');
	assert.equal(board.get('r', 'claude').tool, 'Edit src/advisor/state.py', 'the last tool line stays visible');

	board.start('r', 'codex');
	board.error('r', 'codex', 'usage limit reached');
	board.end('r', 'codex');
	assert.equal(board.get('r', 'codex').error, 'usage limit reached');

	board.start('r', 'codex');
	assert.equal(board.get('r', 'codex').error, undefined, 'a new turn starts clean');
	assert.ok(changes.length >= 8 && changes.every(c => c === 'r'));
});

test('a cancelled round leaves nobody waiting', () => {
	const board = new ActivityBoard();
	board.queue('r', ['claude', 'codex']);
	board.start('r', 'claude');
	board.settle('r');
	assert.equal(board.get('r', 'claude').state, 'idle');
	assert.equal(board.get('r', 'codex').state, 'idle');
	assert.equal(board.get('other', 'claude').state, 'idle');
});

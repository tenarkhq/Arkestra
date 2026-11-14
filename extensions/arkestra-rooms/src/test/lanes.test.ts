/*---------------------------------------------------------------------------------------------
 *  Arkestra. Pult lanes: each lane shows one agent's own messages.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LANE_ENTRY_LIMIT, laneAgent, laneEntries } from '../lanes';
import type { Message } from '../room';

const msg = (id: string, kind: 'user' | 'agent' | 'system', author: string, text: string): Message =>
	({ id, at: `2026-11-14T14:0${id}:00Z`, author: { kind, id: author, name: author }, text });

test('a lane shows only its own agent, newest entries kept, long answers shortened', () => {
	const messages = [
		msg('1', 'user', 'me', 'plan it'),
		msg('2', 'agent', 'claude', 'three steps'),
		msg('3', 'agent', 'codex', 'editing state.py'),
		msg('4', 'system', 'room', 'codex joined'),
		msg('5', 'agent', 'claude', 'x'.repeat(LANE_ENTRY_LIMIT + 50)),
	];
	assert.deepEqual(laneEntries(messages, 'codex'), [{ at: '2026-11-14T14:03:00Z', text: 'editing state.py' }]);
	const claude = laneEntries(messages, 'claude');
	assert.equal(claude.length, 2);
	assert.equal(claude[1].text.length, LANE_ENTRY_LIMIT + 1);
	assert.ok(claude[1].text.endsWith('…'));
	assert.deepEqual(laneEntries(messages, 'claude', 1).map(e => e.at), ['2026-11-14T14:05:00Z']);
	assert.deepEqual(laneEntries(messages, 'gpt'), []);
});

test('lane slots follow the room order; a slot past the roster is empty', () => {
	assert.equal(laneAgent(['claude', 'codex'], 1), 'codex');
	assert.equal(laneAgent(['claude', 'codex'], 2), undefined);
	assert.equal(laneAgent(['claude'], -1), undefined);
	assert.equal(laneAgent(['claude'], 0.5), undefined);
});

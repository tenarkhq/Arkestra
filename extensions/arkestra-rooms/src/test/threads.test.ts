/*---------------------------------------------------------------------------------------------
 *  Arkestra. Chat threads find their room again from the history.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ROOM_ID_KEY, roomIdFromHistory, titleFrom } from '../threads';

test('a thread finds its room in the newest answer that carries one; a new thread has none', () => {
	assert.equal(roomIdFromHistory([]), undefined);
	const history = [
		{ prompt: 'hi' },
		{ result: { metadata: { [ROOM_ID_KEY]: 'old-1' } } },
		{ prompt: '/new other' },
		{ result: { metadata: { [ROOM_ID_KEY]: 'new-2' } } },
		{ prompt: 'go on' },
		{ result: {} },
	];
	assert.equal(roomIdFromHistory(history), 'new-2');
	assert.equal(roomIdFromHistory([{ result: { metadata: { [ROOM_ID_KEY]: '../etc' } } }]), undefined);
});

test('a room is named after the first line of the thread', () => {
	assert.equal(titleFrom('  fix the stop state\nmore', 'Room'), 'fix the stop state');
	assert.equal(titleFrom('', 'Room'), 'Room');
	assert.equal(titleFrom('x'.repeat(60), 'Room').length, 48);
});

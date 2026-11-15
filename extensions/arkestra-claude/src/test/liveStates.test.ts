/*---------------------------------------------------------------------------------------------
 *  Arkestra. The live state of a session out of the end of its file.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { liveLine, shownState, stateOfTail, STALE_S, WATCH_SCRIPT } from '../liveStates';

const line = (o: unknown) => JSON.stringify(o);

test('the latest user or assistant line tells whether the turn runs', () => {
	const user = line({ type: 'user', message: { role: 'user', content: 'mehet' } });
	const working = line({ type: 'assistant', message: { stop_reason: 'tool_use' } });
	const streaming = line({ type: 'assistant', message: { stop_reason: null } });
	const done = line({ type: 'assistant', message: { stop_reason: 'end_turn' } });
	const toolResult = line({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
	const title = line({ type: 'custom-title', customTitle: 'x' });
	assert.equal(stateOfTail([user].join('\n')), 'run');
	assert.equal(stateOfTail([user, working].join('\n')), 'run');
	assert.equal(stateOfTail([user, working, toolResult].join('\n')), 'run');
	assert.equal(stateOfTail([user, streaming].join('\n')), 'run');
	assert.equal(stateOfTail([user, done].join('\n')), 'idle');
	// Lines that are not a turn's (a title, a bridge line, a cut first line) are passed over.
	assert.equal(stateOfTail(['{"cut', user, done, title, line({ type: 'bridge-session' })].join('\n')), 'idle');
	assert.equal(stateOfTail([done, line({ type: 'user', isMeta: true, message: { content: 'x' } })].join('\n')), 'idle');
	assert.equal(stateOfTail(title), undefined);
});

test('a run that wrote nothing for a long time is shown ended', () => {
	assert.equal(shownState('run', 1000, 1000 + STALE_S - 1), 'run');
	assert.equal(shownState('run', 1000, 1000 + STALE_S + 1), 'idle');
	assert.equal(shownState('idle', 1000, 1001), 'idle');
});

test('the watch\'s lines; the script runs Python only where it is, quoted for sh', () => {
	assert.deepEqual(liveLine('{"id":"abc","state":"run","at":12.5}'), { id: 'abc', state: 'run', at: 12.5 });
	assert.equal(liveLine('{"ready":true}'), 'ready');
	assert.equal(liveLine('{"id":"abc","state":"weird","at":1}'), undefined);
	assert.equal(liveLine('nem json'), undefined);
	assert.ok(WATCH_SCRIPT.startsWith('command -v python3 >/dev/null 2>&1 || exit 0\nexec python3 -u -c \''));
	assert.ok(!/[^'"]'[^"']/.test(WATCH_SCRIPT.split('-c ')[1].slice(1, -1).replace(/'"'"'/g, '')), 'no bare quote inside the script');
});

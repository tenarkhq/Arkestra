/*---------------------------------------------------------------------------------------------
 *  Arkestra. The live state of a session out of the end of its file.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BackgroundTracker, liveLine, shownState, stateOfTail, STALE_S, WATCH_SCRIPT } from '../liveStates';

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

test('background tasks: a command started in the background runs until its notification or its stop; output that only quotes the words is not one', () => {
	const t = new BackgroundTracker();
	const use = (id: string, description: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { description, run_in_background: true } }] } });
	const result = (id: string, text: string, ts = '2026-11-15T20:00:00Z') => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
	t.line(use('t1', 'Wait for the build'));
	t.line(result('t1', 'Command running in background with ID: b715msxlq. Output is being written to: /x'));
	t.line(use('t2', 'Run the long tests'));
	t.line(result('t2', 'Command did not complete within its 120s timeout and was moved to the background (ID: bfb70zjf5). Output…', '2026-11-15T20:05:00Z'));
	t.line(use('t3', 'Grep the transcript'));
	t.line(result('t3', 'line: Command running in background with ID: zzzzzzzz'));
	assert.deepEqual(t.tasks.map(b => [b.id, b.name, b.since]), [['b715msxlq', 'Wait for the build', '2026-11-15T20:00:00Z'], ['bfb70zjf5', 'Run the long tests', '2026-11-15T20:05:00Z']]);
	t.line(JSON.stringify({ type: 'user', message: { content: '<task-notification>\n<task-id>b715msxlq</task-id>\n<status>completed</status>\n</task-notification>' } }));
	t.line(result('t9', '{"message":"Successfully stopped task: bfb70zjf5 (sleep 9)"}'));
	assert.deepEqual(t.tasks, []);
	assert.equal(t.done, 2);
});

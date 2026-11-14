/*---------------------------------------------------------------------------------------------
 *  Arkestra. Rooms working on a task: references, phase, progress list.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { RoomState } from '../room';
import { progressFromMarkdown, roomPhase, taskRefs, taskRooms } from '../tasks';

const room = (over: Omit<Partial<RoomState>, 'template'> & { template?: any }): RoomState => ({ id: 'r1', title: 'Thread', roster: ['a', 'b'], messages: [], ...over } as RoomState);
const coding = (code: any, extra: any = {}) => ({ type: 'coding', members: {}, folder: '/f', rounds: 0, max: 60, briefed: {}, waiting: {}, code, ...extra });

test('task references come from the template and the title', () => {
	assert.deepEqual(taskRefs(room({ title: 'Coding · #41 strategy import', template: coding({ issue: 'https://github.com/o/r/issues/41' }) })), ['https://github.com/o/r/issues/41', '#41']);
	assert.deepEqual(taskRefs(room({ title: 'Coding · T27', template: coding({ issue: 'T27' }) })), ['T27']);
	assert.deepEqual(taskRefs(room({ title: 'plain chat about colours' })), []);
	assert.deepEqual(taskRefs(room({ title: 'see a#1 and x/#2' })), []);
});

test('phase: coding, plan approval, verifying, waiting for the user, ended, round limit', () => {
	assert.deepEqual(roomPhase(room({ template: coding({}) }), true), { type: 'coding', status: 'running', phase: 'coding' });
	assert.deepEqual(roomPhase(room({ template: coding({ planState: 'waiting' }, { waiting: { A: 'szeletterv' } }) }), false), { type: 'coding', status: 'waiting', phase: 'waits for you · slice plan waits for approval' });
	assert.equal(roomPhase(room({ template: coding({ verifying: 'abc' }) }), false).phase, 'verifying');
	assert.deepEqual(roomPhase(room({ template: coding({}, { ended: 'kész · main @ abc' }) }), false), { type: 'coding', status: 'ended', phase: 'kész · main @ abc' });
	assert.equal(roomPhase(room({ template: coding({}, { pending: { to: 'A', text: 'x' } }) }), false).status, 'waiting');
	assert.equal(roomPhase(room({ template: { type: 'audit', waiting: {}, audit: { phase: 'merge' } } }), true).phase, 'merging the audits');
	assert.deepEqual(roomPhase(room({}), false), { type: 'chat', status: 'idle', phase: 'thread' });
});

test('progress list: ticked of all checklist items', () => {
	assert.deepEqual(progressFromMarkdown('# Szeletek\n- [x] A\n- [ ] B\n  * [X] C\nnot an item [x]'), { done: 2, total: 3 });
	assert.equal(progressFromMarkdown('no list'), undefined);
});

test('task rooms: only rooms with a reference, with progress', () => {
	const rooms = taskRooms([room({ id: 'a', title: 'Coding · #5', template: coding({ issue: '#5' }) }), room({ id: 'b', title: 'chat' })], id => id === 'a', id => id === 'a' ? { done: 1, total: 4 } : undefined);
	assert.equal(rooms.length, 1);
	assert.deepEqual([rooms[0].roomId, rooms[0].refs, rooms[0].status, rooms[0].progress], ['a', ['#5'], 'running', { done: 1, total: 4 }]);
});

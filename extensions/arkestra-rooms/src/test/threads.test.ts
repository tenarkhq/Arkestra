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

import { groupThreads, historyTurns, projectName, roomIdFromSessionPath, summarize } from '../threads';
import type { Message, RoomState } from '../room';

const m = (kind: 'user' | 'agent' | 'system', name: string, text: string, at = '2026-11-14T10:00:00Z'): Message =>
	({ id: Math.random().toString(36), at, author: { kind, id: name.toLowerCase(), name }, text });

test('a room becomes chat history: requests with every answer after them in one response', () => {
	const turns = historyTurns([
		m('system', 'Arkestra', 'Claude joined and received the thread from the beginning.'),
		m('user', 'You', 'fix the stop state'),
		m('agent', 'Claude', 'Plan: a stopped_by field.'),
		m('agent', 'Codex', 'Done, 14 tests green.'),
		m('user', 'You', 'and the manual start?'),
		m('agent', 'Claude', 'It clears the flag.'),
	]);
	assert.deepEqual(turns, [
		{ kind: 'request', prompt: 'fix the stop state' },
		{ kind: 'response', markdown: '_Claude joined and received the thread from the beginning._\n\n**Claude**\n\nPlan: a stopped_by field.\n\n**Codex**\n\nDone, 14 tests green.' },
		{ kind: 'request', prompt: 'and the manual start?' },
		{ kind: 'response', markdown: '**Claude**\n\nIt clears the flag.' },
	]);
	assert.deepEqual(historyTurns([]), []);
});

test('session paths carry the room id', () => {
	assert.equal(roomIdFromSessionPath('/room/m3k2-1a'), 'm3k2-1a');
	assert.equal(roomIdFromSessionPath('/room/../x'), undefined);
	assert.equal(roomIdFromSessionPath('/untitled-1'), undefined);
});

test('the left column: this project first, pinned on top, then categories, newest first; other projects after', () => {
	const state = (id: string, project: string | undefined, extra: Partial<RoomState> = {}, at = '2026-11-14T10:00:00Z'): RoomState =>
		({ id, title: id, ...(project ? { project } : {}), roster: ['claude'], messages: [m('user', 'You', 'x', at)], ...extra });
	const X = 'file:///srv/tenark-x', A = 'file:///home/r/ArkadeOS';
	const threads = [
		state('old', X, {}, '2026-11-13T09:00:00Z'),
		state('new', X, {}, '2026-11-14T12:00:00Z'),
		state('pin', X, { pinned: true }),
		state('audit', X, { category: 'Audit' }),
		state('brief', X, { category: 'Brief' }),
		state('ark', A),
		state('loose', undefined),
	].map(summarize);
	const { current, others } = groupThreads(threads, X);
	assert.deepEqual(current.pinned.map(t => t.id), ['pin']);
	assert.deepEqual(current.uncategorized.map(t => t.id), ['new', 'old']);
	assert.deepEqual(current.categories.map(c => [c.name, c.threads.map(t => t.id)]), [['Audit', ['audit']], ['Brief', ['brief']]]);
	assert.equal(current.count, 5);
	assert.deepEqual(others.map(o => [projectName(o.project), o.count]), [['ArkadeOS', 1], ['', 1]]);
});

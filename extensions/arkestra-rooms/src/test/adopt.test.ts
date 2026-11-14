/*---------------------------------------------------------------------------------------------
 *  Arkestra. A thread that continues an existing CLI session (AR39).
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentRegistry, type Agent, type TurnInput } from '../agent';
import { Room, importedRoomState, seenBy, type Message } from '../room';

const session = { id: 's-1', title: 'Stop loss fix', cwd: '/home/r/tenark', updatedAt: '2026-11-14T10:00:00Z' };
const entries = [
	{ role: 'user' as const, text: 'fix the stop', at: '2026-11-14T09:00:00Z' },
	{ role: 'agent' as const, text: 'Fixed.', at: 'not a time' },
];

test('import: the session\'s messages under the agent, a note first, the session bound to the agent', () => {
	const now = () => new Date('2026-11-14T12:00:00Z');
	const state = importedRoomState({ id: 'claude@prd', name: 'Claude · prd' }, session, entries, undefined, now);
	assert.equal(state.title, 'Stop loss fix');
	assert.deepEqual(state.roster, ['claude@prd']);
	assert.deepEqual(state.messages.map(m => [m.author.kind, m.author.id, m.text]), [
		['system', 'system', 'Claude · prd session continued here (/home/r/tenark).'],
		['user', 'user', 'fix the stop'],
		['agent', 'claude@prd', 'Fixed.'],
	]);
	assert.deepEqual([state.messages[1].at, state.messages[2].at], ['2026-11-14T09:00:00.000Z', '2026-11-14T12:00:00.000Z']);
	assert.deepEqual(state.adopted, { 'claude@prd': { session: 's-1', cwd: '/home/r/tenark', upTo: state.messages[2].id } });
	assert.equal(importedRoomState({ id: 'codex', name: 'Codex' }, { id: 't', title: 'x', updatedAt: '' }, [], 'file:///p').project, 'file:///p');
});

test('seen: up to the imported messages, or later when the agent answered here since', () => {
	const m = (id: string, author: string): Message => ({ id, at: '', author: { kind: author === 'user' ? 'user' : 'agent', id: author, name: author }, text: id });
	const list = [m('a', 'user'), m('b', 'claude'), m('c', 'user'), m('d', 'claude'), m('e', 'user')];
	assert.deepEqual(seenBy(list, 'claude', 'b'), ['a', 'b', 'c', 'd']);
	assert.deepEqual(seenBy(list, 'codex', 'c'), ['a', 'b', 'c']);
	assert.deepEqual(seenBy(list, 'codex', 'gone'), []);
});

test('a turn in an imported thread first binds the agent to its session', async () => {
	const registry = new AgentRegistry();
	const adopted: unknown[] = [];
	let input: TurnInput | undefined;
	const agent: Agent = {
		id: 'claude', name: 'Claude', detail: 'test',
		readiness: async () => ({ ready: true }),
		turn: async (i, onEvent) => { input = i; onEvent({ kind: 'text', text: 'Deployed.' }); },
		adoptSession: (roomId, s, seen) => { adopted.push({ roomId, s, seen }); },
	};
	registry.register(agent);
	const room = new Room(importedRoomState(agent, session, entries), registry);
	const imported = room.messages.map(m => m.id);
	await room.say('now deploy', () => { }, new AbortController().signal);
	assert.deepEqual(adopted, [{ roomId: room.id, s: { id: 's-1', cwd: '/home/r/tenark' }, seen: imported }]);
	assert.equal(input?.transcript.at(-1)?.text, 'now deploy');
	assert.equal(room.messages.at(-1)?.text, 'Deployed.');
});

test('registry: the Agents section hears when an agent comes or goes', () => {
	const registry = new AgentRegistry();
	let changes = 0;
	const sub = registry.onDidChange(() => changes++);
	const reg = registry.register({ id: 'x', name: 'X', detail: '', readiness: async () => ({ ready: true }), turn: async () => '' } as never);
	reg.dispose();
	sub.dispose();
	registry.register({ id: 'y', name: 'Y', detail: '', readiness: async () => ({ ready: true }), turn: async () => '' } as never);
	assert.equal(changes, 2);
});

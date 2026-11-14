/*---------------------------------------------------------------------------------------------
 *  Arkestra. A thread that continues a CLI session follows it live (AR39).
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentRegistry, type Agent, type SessionEntry } from '../agent';
import { Room, importedRoomState, seenBy, type Message } from '../room';
import { SessionFollow } from '../sessionFollow';

const session = { id: 's-1', title: 'Stop loss fix', cwd: '/home/r/tenark', updatedAt: '2026-11-14T10:00:00Z' };
const imported: SessionEntry[] = [
	{ role: 'user', text: 'fix the stop', id: 'u1' },
	{ role: 'agent', text: 'Fixed.', id: 'a1' },
];

type Watcher = { id: string; cursor?: string; emit: (entries: SessionEntry[], cursor: string) => void; disposed: boolean };

function fakeAgent(id = 'claude', watchers?: Watcher[], extra: Partial<Agent> = {}): Agent {
	return {
		id, name: id === 'claude' ? 'Claude · prd' : id, detail: 'test',
		readiness: async () => ({ ready: true }),
		turn: async (_i, onEvent) => { onEvent({ kind: 'text', text: 'Deployed.' }); },
		...(watchers ? {
			watchSession: (sessionId: string, onEntries: (e: readonly SessionEntry[], c: string) => void, cursor?: string) => {
				const w: Watcher = { id: sessionId, ...(cursor !== undefined ? { cursor } : {}), emit: (e, c) => onEntries(e, c), disposed: false };
				watchers.push(w);
				return { dispose: () => { w.disposed = true; } };
			},
		} : {}),
		...extra,
	};
}

const view = (room: Room) => room.messages.slice(1).map(m => [m.author.kind, m.author.name, m.text]);

test('followed: new entries appended under their authors, a grown answer updated in place, what the thread has not added twice', () => {
	const registry = new AgentRegistry();
	registry.register(fakeAgent());
	const now = () => new Date('2026-11-14T12:00:00Z');
	const room = new Room(importedRoomState({ id: 'claude', name: 'Claude · prd' }, session, imported, undefined, now), registry, now);
	let changes = 0;
	room.onDidChange(() => changes++);
	assert.deepEqual(room.messages[1].source, { agent: 'claude', entry: 'u1' });

	// A reopen reads from the start again: the imported entries are known by id.
	room.followed('claude', [...imported, { role: 'user', text: 'now the tests', id: 'u2', at: '2026-11-14T11:00:00Z' }, { role: 'agent', text: 'Running', id: 'a2' }], '120');
	room.followed('claude', [{ role: 'agent', text: 'Running\n\nAll green.', id: 'a2' }, { role: 'system', text: 'Background command "npm test" completed', id: 'n1' }], '200m');
	assert.deepEqual(view(room), [
		['user', 'You', 'fix the stop'],
		['agent', 'Claude · prd', 'Fixed.'],
		['user', 'You', 'now the tests'],
		['agent', 'Claude · prd', 'Running\n\nAll green.'],
		['system', 'Claude · prd', 'Background command "npm test" completed'],
	]);
	assert.equal(room.messages[3].at, '2026-11-14T11:00:00.000Z');
	assert.equal(room.messages[4].at, '2026-11-14T12:00:00.000Z');
	assert.equal(room.state.adopted?.claude.cursor, '200m');
	assert.equal(room.state.adopted?.claude.upTo, room.messages[2].id, 'the import point stays');
	assert.equal(changes, 2);

	// Nothing new and the same cursor: no change, nothing saved.
	room.followed('claude', [{ role: 'agent', text: 'Running\n\nAll green.', id: 'a2' }], '200m');
	room.followed('codex', [{ role: 'user', text: 'not adopted', id: 'x' }], '1');
	assert.equal(changes, 2);
	assert.equal(room.messages.length, 6);
	// Only the cursor moved (the room's own turn, left out by the agent): saved, nothing added.
	room.followed('claude', [], '260');
	assert.equal(changes, 3);
	assert.equal(room.state.adopted?.claude.cursor, '260');
});

test('seen: what came in live counts as in the session, even after another agent\'s message it never got', () => {
	const m = (id: string, author: string, source?: string): Message => ({ id, at: '', author: { kind: author === 'user' ? 'user' : 'agent', id: author, name: author }, text: id, ...(source ? { source: { agent: 'claude', entry: source } } : {}) });
	const list = [m('a', 'user'), m('b', 'claude'), m('c', 'codex'), m('d', 'user', 'u9'), m('e', 'user')];
	assert.deepEqual(seenBy(list, 'claude', 'b'), ['a', 'b', 'd']);
	assert.deepEqual(seenBy(list, 'codex', 'b'), ['a', 'b', 'c']);
});

test('a turn after live entries tells the agent they are in its session; its own answer stays the room\'s', async () => {
	const registry = new AgentRegistry();
	const adopted: string[][] = [];
	registry.register(fakeAgent('claude', undefined, { adoptSession: (_r, _s, seen) => { adopted.push([...seen]); } }));
	const room = new Room(importedRoomState({ id: 'claude', name: 'Claude · prd' }, session, imported), registry);
	room.followed('claude', [{ role: 'user', text: 'typed in the app', id: 'u2' }, { role: 'agent', text: 'Noted.', id: 'a2' }], '90');
	await room.say('now deploy', () => { }, new AbortController().signal);
	assert.deepEqual(adopted[0], room.messages.slice(0, 5).map(m => m.id));
	assert.deepEqual(view(room).slice(-2), [['user', 'You', 'now deploy'], ['agent', 'Claude · prd', 'Deployed.']]);
});

test('follow: a loaded thread follows its session from the kept cursor, catches up, starts again with the agent, stops when detached', async () => {
	const registry = new AgentRegistry();
	const watchers: Watcher[] = [];
	const reg = registry.register(fakeAgent('claude', watchers));
	const state = importedRoomState({ id: 'claude', name: 'Claude · prd' }, session, imported);
	state.adopted = { claude: { ...state.adopted!.claude, cursor: '40' } };
	const room = new Room(state, registry);
	const follow = new SessionFollow(registry);
	follow.attach(room);
	follow.attach(room); // once per room
	assert.deepEqual(watchers.map(w => [w.id, w.cursor]), [['s-1', '40']]);

	const caught = follow.caughtUp(room.id, 2000);
	watchers[0].emit([{ role: 'user', text: 'from the terminal', id: 'u2' }], '80');
	await caught;
	assert.equal(room.messages.at(-1)?.text, 'from the terminal');

	// The agent registered again (its machine's settings changed): a new follow from the latest cursor.
	reg.dispose();
	assert.equal(watchers[0].disposed, true);
	registry.register(fakeAgent('claude', watchers));
	assert.deepEqual(watchers.map(w => w.cursor), ['40', '80']);
	watchers[0].emit([{ role: 'user', text: 'late from the old follow', id: 'u3' }], '99');
	assert.equal(room.messages.at(-1)?.text, 'from the terminal');

	follow.detach(room.id);
	assert.equal(watchers[1].disposed, true);
	follow.dispose();
});

test('follow: rooms without a session, and agents that cannot follow, are left alone; catching up gives up in time', async () => {
	const registry = new AgentRegistry();
	registry.register(fakeAgent('claude'));
	const watchers: Watcher[] = [];
	registry.register(fakeAgent('codex', watchers, { watchSession: () => { throw new Error('not a Codex thread id'); } }));
	const follow = new SessionFollow(registry);
	const plain = new Room({ id: 'p', title: 'x', roster: [], messages: [] }, registry);
	follow.attach(plain);
	const room = new Room(importedRoomState({ id: 'claude', name: 'Claude · prd' }, session, imported), registry);
	follow.attach(room);
	const codex = new Room(importedRoomState({ id: 'codex', name: 'codex' }, { ...session, id: 'bad id' }, []), registry);
	follow.attach(codex);
	const started = Date.now();
	await follow.caughtUp(room.id, 50);
	await follow.caughtUp('nobody', 50);
	assert.ok(Date.now() - started < 1000);
	assert.equal(watchers.length, 0);
	follow.dispose();
});

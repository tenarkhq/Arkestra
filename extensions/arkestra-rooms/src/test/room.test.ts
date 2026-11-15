/*---------------------------------------------------------------------------------------------
 *  Arkestra. Room behaviour: mid-run join, readiness gate, invite list, storage.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentRegistry, type Agent, type Readiness, type TurnInput } from '../agent';
import { AgentNotReadyError, Room, RoomOpener, followSessionName, newRoomState, type Message, type RoomState } from '../room';
import { RoomStore } from '../store';

function fakeAgent(id: string, opts: { readiness?: Readiness; gate?: Promise<void>; seen?: Message[][] } = {}): Agent & { aborted: boolean } {
	const agent = {
		id, name: id.toUpperCase(), detail: 'test', aborted: false,
		readiness: async () => opts.readiness ?? { ready: true },
		turn: async (input: TurnInput, onEvent: (e: { kind: 'text'; text: string }) => void, signal: AbortSignal) => {
			opts.seen?.push([...input.transcript]);
			signal.addEventListener('abort', () => { agent.aborted = true; });
			await opts.gate;
			onEvent({ kind: 'text', text: `${id} answer` });
		},
	};
	return agent;
}

test('an agent invited during a running turn answers in the same round with the whole thread, and the running agent is not stopped', async () => {
	const registry = new AgentRegistry();
	let release!: () => void;
	const gate = new Promise<void>(r => { release = r; });
	const claude = fakeAgent('claude', { gate });
	const seenByGpt: Message[][] = [];
	registry.register(claude);
	registry.register(fakeAgent('gpt', { seen: seenByGpt }));
	const room = new Room(newRoomState('t'), registry);
	await room.invite('claude');

	const round = room.say('fix the stop state', () => { }, new AbortController().signal);
	await new Promise(r => setImmediate(r));
	await room.invite('gpt');
	release();
	await round;

	assert.equal(claude.aborted, false);
	assert.deepEqual(room.messages.filter(m => m.author.kind === 'agent').map(m => m.author.id), ['claude', 'gpt']);
	assert.equal(seenByGpt.length, 1);
	assert.deepEqual(seenByGpt[0].map(m => m.author.kind), ['system', 'user', 'system', 'agent']);
	assert.equal(seenByGpt[0][1].text, 'fix the stop state');
});

test('an agent that is not ready cannot join, and the reason is kept', async () => {
	const registry = new AgentRegistry();
	registry.register(fakeAgent('copilot', { readiness: { ready: false, reason: 'not installed', fix: 'install' } }));
	const room = new Room(newRoomState('t'), registry);
	await assert.rejects(room.invite('copilot'), (e: unknown) => e instanceof AgentNotReadyError && e.readiness.fix === 'install');
	assert.deepEqual(room.roster, []);
});

test('the invite list shows ready agents first and leaves out the ones in the room', async () => {
	const registry = new AgentRegistry();
	registry.register(fakeAgent('aider', { readiness: { ready: false, reason: 'machine unreachable', fix: 'retry' } }));
	registry.register(fakeAgent('gpt'));
	registry.register(fakeAgent('claude'));
	const list = await registry.inviteList(['claude']);
	assert.deepEqual(list.map(e => [e.agent.id, e.readiness.ready]), [['gpt', true], ['aider', false]]);
});

test('a message to named agents runs only their turns', async () => {
	const registry = new AgentRegistry();
	registry.register(fakeAgent('claude'));
	registry.register(fakeAgent('codex'));
	const room = new Room(newRoomState('t'), registry);
	await room.invite('claude');
	await room.invite('codex');
	await room.say('only codex', () => { }, new AbortController().signal, ['codex']);
	assert.deepEqual(room.messages.filter(m => m.author.kind === 'agent').map(m => m.author.id), ['codex']);
});

test('a room survives a save and load', async () => {
	const store = new RoomStore(path.join(await mkdtemp(path.join(tmpdir(), 'arkestra-')), 'rooms'));
	const registry = new AgentRegistry();
	registry.register(fakeAgent('claude'));
	const room = new Room(newRoomState('Kódolás'), registry);
	await room.invite('claude');
	await room.say('hello', () => { }, new AbortController().signal);
	await store.save(room.state);
	const loaded = await store.load(room.id);
	assert.deepEqual(loaded, room.state);
	assert.deepEqual((await store.list()).map(r => r.id), [room.id]);
});

test('Plan mode reaches every agent\'s turn while it is on, and stops when it is off', async () => {
	const registry = new AgentRegistry();
	const modes: (string | undefined)[] = [];
	registry.register({ id: 'a', name: 'A', detail: 'test', readiness: async () => ({ ready: true }), turn: async input => { modes.push(input.mode); } });
	const room = new Room(newRoomState('t'), registry);
	await room.invite('a');
	room.state.mode = 'plan';
	await room.say('plan it', () => { }, new AbortController().signal);
	room.state.mode = undefined;
	await room.say('go', () => { }, new AbortController().signal);
	assert.deepEqual(modes, ['plan', undefined]);
});

test('one Room per thread: overlapping opens share the load; a Room made meanwhile is the one; a missing thread is none', async () => {
	const loaded = new Map<string, { id: string; n: number }>();
	let loads = 0;
	let made = 0;
	let release!: () => void;
	const gate = new Promise<void>(r => { release = r; });
	const opener = new RoomOpener(loaded, async id => { loads++; await gate; return id === 'gone' ? undefined : { id } as unknown as RoomState; }, state => { const r = { id: state.id, n: ++made }; loaded.set(r.id, r); return r; });
	const a = opener.open('t1');
	const b = opener.open('t1');
	release();
	const [ra, rb] = await Promise.all([a, b]);
	assert.equal(ra, rb);
	assert.equal(loads, 1);
	assert.equal(made, 1);
	assert.equal(await opener.open('t1'), ra, 'the loaded one, no load');
	assert.equal(loads, 1);
	assert.equal(await opener.open('gone'), undefined);
	assert.equal(await opener.open(undefined), undefined);
	// A Room made elsewhere while the store loaded (an import) wins over a second one.
	let free!: () => void;
	const later = new Promise<void>(r => { free = r; });
	const racing = new RoomOpener(loaded, async id => { await later; return { id } as unknown as RoomState; }, () => { throw new Error('made twice'); });
	const c = racing.open('t2');
	loaded.set('t2', { id: 't2', n: 99 });
	free();
	assert.equal((await c)?.n, 99);
});

test('a thread that continues a session carries the session\'s name until the user names it here', () => {
	const sid = '11111111-1111-4111-8111-111111111111';
	const state = newRoomState('first words');
	state.adopted = { claude: { session: sid, upTo: 'm1' } };
	assert.equal(followSessionName(state, [{ id: 'other', title: 'Nope' }]), false);
	assert.equal(followSessionName(state, [{ id: sid, title: '11111111' }]), false, 'the id\'s start is no name');
	assert.equal(followSessionName(state, [{ id: sid, title: 'Arkestra' }]), true);
	assert.equal(state.title, 'Arkestra');
	assert.equal(followSessionName(state, [{ id: sid, title: 'Arkestra' }]), false, 'no change, no save');
	state.renamed = true;
	assert.equal(followSessionName(state, [{ id: sid, title: 'Renamed in the CLI' }]), false);
	assert.equal(state.title, 'Arkestra');
});

/*---------------------------------------------------------------------------------------------
 *  Arkestra. Room behaviour: mid-run join, readiness gate, invite list, storage.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentRegistry, type Agent, type Readiness, type TurnInput } from '../agent';
import { AgentNotReadyError, Room, newRoomState, type Message } from '../room';
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

/*---------------------------------------------------------------------------------------------
 *  Arkestra. Shared rules and memory: the block and its version, the limit, [EMLÉK] lines
 *  and memory entries without repeats; every agent's turn gets the block.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentRegistry, type TurnInput } from '../agent';
import { Room, newRoomState } from '../room';
import { MEMORY_HOWTO, SHARED_LIMIT, extractMemories, memoryEntry, newEntries, sharedBlock } from '../shared';

test('the block: rules first, memory after, empty sources left out; a change makes a new version', () => {
	const a = sharedBlock([
		{ kind: 'memory', label: 'Memória · projekt', text: '- 2026-11-14 · Claude: a tesztek a tests/ alatt' },
		{ kind: 'rules', label: 'Szabályok · projekt (AGENTS.md)', text: 'Magyar commit üzenet.\n' },
		{ kind: 'rules', label: 'Szabályok · felhasználó', text: '  ' },
	]);
	assert.equal(a.text, `Közös szabályok és memória (Arkestra; minden agent ugyanezt kapja):\n\n## Szabályok · projekt (AGENTS.md)\n\nMagyar commit üzenet.\n\n## Memória · projekt\n\n- 2026-11-14 · Claude: a tesztek a tests/ alatt\n\n${MEMORY_HOWTO}`);
	assert.equal(a.version, sharedBlock([{ kind: 'rules', label: 'Szabályok · projekt (AGENTS.md)', text: 'Magyar commit üzenet.' }, { kind: 'memory', label: 'Memória · projekt', text: '- 2026-11-14 · Claude: a tesztek a tests/ alatt' }]).version);
	assert.notEqual(a.version, sharedBlock([{ kind: 'rules', label: 'Szabályok · projekt (AGENTS.md)', text: 'Angol commit üzenet.' }]).version);
	const empty = sharedBlock([]);
	assert.match(empty.text, /\[EMLÉK\]/, 'even with nothing shared the agents learn how to remember');
});

test('a long memory keeps its newest entries; rules are cut at the limit', () => {
	const memory = Array.from({ length: 5000 }, (_, i) => `- 2026-11-14 · A: bejegyzés ${i}`).join('\n');
	const b = sharedBlock([{ kind: 'rules', label: 'R', text: 'szabály' }, { kind: 'memory', label: 'M', text: memory }]);
	assert.ok(b.text.length <= SHARED_LIMIT + 1000);
	assert.match(b.text, /bejegyzés 4999\n/);
	assert.doesNotMatch(b.text, /bejegyzés 0\n/);
});

test('[EMLÉK] lines outside code blocks become memory entries, each once, never repeated', () => {
	const answer = 'Kész.\n[EMLÉK] A migrációk a db/migrations alatt vannak.\n```\n[EMLÉK] ez csak példa\n```\n- [MEMORY]: Use pnpm, not npm.\n[EMLÉK] A migrációk a db/migrations alatt vannak.\nszöveg [EMLÉK] nem sor elején';
	assert.deepEqual(extractMemories(answer), ['A migrációk a db/migrations alatt vannak.', 'Use pnpm, not npm.']);
	assert.equal(memoryEntry('  két\n sor ', 'Codex', new Date('2026-11-14T20:00:00Z')), '- 2026-11-14 · Codex: két sor');
	const memory = '# Közös memória\n\n- 2026-11-13 · Claude: Use pnpm, not npm.\n';
	assert.deepEqual(newEntries(memory, ['use pnpm,  not npm.', 'Új dolog']), ['Új dolog']);
});

test('every agent\'s turn gets the shared block, and the turn\'s reply goes to afterTurn', async () => {
	const registry = new AgentRegistry();
	const got: (string | undefined)[] = [];
	registry.register({ id: 'a', name: 'A', detail: 't', readiness: async () => ({ ready: true }), turn: async (input: TurnInput, onEvent) => { got.push(input.shared?.version); onEvent({ kind: 'text', text: '[EMLÉK] x' }); } });
	const room = new Room(newRoomState('t'), registry);
	await room.invite('a');
	room.shared = async () => ({ text: 'T', version: 'v1' });
	const replies: string[] = [];
	room.afterTurn = async (_agent, reply) => { replies.push(reply); };
	await room.say('hi', () => { }, new AbortController().signal);
	assert.deepEqual(got, ['v1']);
	assert.deepEqual(replies, ['[EMLÉK] x']);
});

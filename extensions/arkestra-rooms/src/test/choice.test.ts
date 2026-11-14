/*---------------------------------------------------------------------------------------------
 *  Arkestra. Model and effort per agent and thread: labels, efforts per model, fitting, and
 *  the room passing the choice to the agent's turn.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { choiceLabel, effortsFor, fitChoice } from '../choice';
import { AgentRegistry, type Agent, type AgentChoices, type TurnInput } from '../agent';
import { Room, newRoomState } from '../room';

const choices: AgentChoices = { models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high', 'max'] }, { id: 'mini', label: 'Mini' }] };

test('labels, efforts per model, and a choice fitted to what the agent offers', () => {
	assert.equal(choiceLabel({ model: 'opus', effort: 'high' }, choices), 'Opus · high');
	assert.equal(choiceLabel({ effort: 'max' }, choices), 'default model · max');
	assert.equal(choiceLabel({ model: 'gpt-x' }), 'gpt-x');
	assert.equal(choiceLabel(undefined, choices), '');
	assert.deepEqual(effortsFor(choices, 'mini'), []);
	assert.deepEqual(effortsFor(choices, undefined), ['low', 'high', 'max']);
	assert.deepEqual(fitChoice({ model: 'mini', effort: 'high' }, choices), { model: 'mini' });
	assert.deepEqual(fitChoice({ model: 'opus', effort: 'max' }, choices), { model: 'opus', effort: 'max' });
});

test('the room gives each agent its own choice for the thread', async () => {
	const seen: TurnInput[] = [];
	const agent = (id: string): Agent => ({ id, name: id, detail: '', readiness: async () => ({ ready: true }), turn: async input => { seen.push(input); } });
	const registry = new AgentRegistry();
	registry.register(agent('claude'));
	registry.register(agent('codex'));
	const state = { ...newRoomState('t', undefined), roster: ['claude', 'codex'], choices: { claude: { model: 'opus', effort: 'max' } } };
	const room = new Room(state, registry);
	await room.say('go', () => { }, new AbortController().signal);
	const claude = seen.find(s => s.roomId === room.id && s.model);
	assert.deepEqual([claude?.model, claude?.effort], ['opus', 'max']);
	assert.equal(seen.filter(s => !s.model && !s.effort).length, 1, 'the other agent keeps its default');
});

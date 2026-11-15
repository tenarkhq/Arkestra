/*---------------------------------------------------------------------------------------------
 *  Arkestra. Model and effort per agent and thread: labels, efforts per model, fitting, and
 *  the room passing the choice to the agent's turn.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chipLabel, choiceLabel, effortName, effortsFor, fitChoice, modelMenu, modelName } from '../choice';
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

test('the composer chip: model and effort as the vendors\' apps name them, Default when nothing is chosen', () => {
	assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
	assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
	assert.equal(modelName('claude-3-5-haiku-20241022'), 'Haiku 3.5');
	assert.equal(modelName('claude-opus-5-5[1m]'), 'Opus 5.5');
	assert.equal(modelName('gpt-5.1-codex-max'), 'GPT-5.1-Codex-Max');
	assert.equal(modelName('opus', 'Opus'), 'Opus');
	assert.equal(modelName('o3'), 'o3');
	assert.equal(effortName('high'), 'High');
	assert.equal(effortName('xhigh'), 'Extra high');
	assert.equal(effortName('ultracode'), 'Ultracode');
	assert.equal(chipLabel({ model: 'claude-opus-5-5', effort: 'high' }, undefined, 'Default'), 'Opus 5.5 · High');
	assert.equal(chipLabel({ model: 'opus' }, choices, 'Default'), 'Opus');
	assert.equal(chipLabel({ effort: 'max' }, choices, 'Default'), 'Default · Max');
	assert.equal(chipLabel(undefined, choices, 'Default'), 'Default');
});

test('the model menu: models with the chosen one checked, then the chosen model\'s efforts; each row says what it sets', () => {
	const t = { model: 'Model', effort: 'Effort', default: 'Default', agentDefault: 'its own', modelDefault: 'the model\'s own' };
	const menu = modelMenu('claude@tenark', { model: 'opus', effort: 'high' }, choices, t);
	assert.deepEqual(menu.map(i => i.kind ?? `${i.checked ? '✓' : ' '}${i.label}`), ['header', ' Default', '✓Opus', ' Mini', 'sep', 'header', ' Default', ' Low', '✓High', ' Max']);
	// A model keeps the effort (the room drops it when the new model does not know it); an effort keeps the model.
	assert.deepEqual(menu[3].action, { type: 'choose', agentId: 'claude@tenark', model: 'mini', effort: 'high' });
	assert.deepEqual(menu[1].action, { type: 'choose', agentId: 'claude@tenark', effort: 'high' });
	assert.deepEqual(menu[9].action, { type: 'choose', agentId: 'claude@tenark', model: 'opus', effort: 'max' });
	assert.deepEqual(menu[6].action, { type: 'choose', agentId: 'claude@tenark', model: 'opus' });
	// A model without efforts: no effort part; nothing chosen: Default checked.
	assert.deepEqual(modelMenu('codex', { model: 'mini' }, choices, t).map(i => i.kind ?? i.label), ['header', 'Default', 'Opus', 'Mini']);
	assert.equal(modelMenu('codex', undefined, choices, t)[1].checked, true);
});

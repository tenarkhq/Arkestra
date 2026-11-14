/*---------------------------------------------------------------------------------------------
 *  Arkestra. A thread for another screen (AR36): last messages, agent states, work, choices.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AgentActivity } from '../activity';
import type { RoomState } from '../room';
import { threadListItem, threadSnapshot } from '../threadSnapshot';
import { EMPTY_WORK } from '../work';

const msg = (i: number, text = `m${i}`) => ({ id: `m${i}`, at: `2026-11-14T10:${String(i % 60).padStart(2, '0')}:00Z`, author: { kind: i % 2 ? 'agent' : 'user', name: i % 2 ? 'Claude' : 'You', id: 'x' }, text });
const room = (over: Partial<RoomState> = {}): RoomState => ({ id: 'r1', title: 'Thread', roster: ['claude', 'codex'], messages: [], ...over } as RoomState);
const act = (over: Partial<AgentActivity> = {}): AgentActivity => ({ state: 'idle', since: '2026-11-14T10:00:00Z', ...over });

test('snapshot: the last messages, long text cut, each agent with its state, work and choice', () => {
	const messages = Array.from({ length: 70 }, (_, i) => msg(i, i === 69 ? 'x'.repeat(13_000) : undefined));
	const acts: Record<string, AgentActivity> = {
		claude: act({ state: 'answering', tool: 'Bash: npm test', ran: true, work: { ...EMPTY_WORK, waiting: 'permission: Bash', todos: [{ text: 'Write tests', status: 'in_progress' }], subagents: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `sub ${i}`, status: 'running' as const, since: 'x' })) } }),
		codex: act({ state: 'idle', error: 'quota', ran: true }),
	};
	const choices = { models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }] };
	const s = threadSnapshot(room({ messages: messages as any, choices: { claude: { model: 'opus', effort: 'high' } } }), id => ({ name: id === 'claude' ? 'Claude' : 'Codex', activity: acts[id], ...(id === 'claude' ? { choices } : {}) }));
	assert.equal(s.messages.length, 60);
	assert.equal(s.messages[0].id, 'm10');
	assert.equal(s.messages.at(-1)!.text.length, 12_000);
	assert.ok(s.messages.at(-1)!.text.endsWith('…'));
	assert.equal(s.busy, true);
	const [c, x] = s.agents;
	assert.deepEqual([c.turn, c.turnText, c.waiting, c.tool], ['waiting', 'waits for you', 'permission: Bash', 'Bash: npm test']);
	assert.equal(c.subagents.length, 8, 'the last eight sub-agents');
	assert.equal(c.subagents[0].name, 'sub 2');
	assert.deepEqual(c.todos, [{ text: 'Write tests', status: 'in_progress' }]);
	assert.deepEqual(c.choice, { model: 'opus', effort: 'high' });
	assert.deepEqual(c.choices, choices);
	assert.deepEqual([x.turn, x.error, x.choice, 'choices' in x], ['error', 'quota', {}, false]);
});

test('list item: last message time, agent count, busy and waiting', () => {
	const r = room({ messages: [msg(1), msg(2)] as any });
	assert.deepEqual(threadListItem(r, () => act()), { id: 'r1', title: 'Thread', lastAt: msg(2).at, agents: 2, busy: false, waiting: false });
	assert.deepEqual(threadListItem(r, id => id === 'codex' ? act({ state: 'queued' }) : act()), { id: 'r1', title: 'Thread', lastAt: msg(2).at, agents: 2, busy: true, waiting: false });
	const w = threadListItem(r, () => act({ state: 'answering', work: { ...EMPTY_WORK, waiting: 'approval' } }));
	assert.deepEqual([w.busy, w.waiting], [true, true]);
	assert.equal(threadListItem(room(), () => act()).lastAt, '');
});

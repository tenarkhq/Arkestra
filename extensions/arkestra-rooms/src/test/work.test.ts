/*---------------------------------------------------------------------------------------------
 *  Arkestra. Agent work beside the answer: task list, sub-agents, background commands with
 *  polls, chapters, waiting, turn state, totals, and the Agents tile's part.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ActivityBoard } from '../activity';
import { EMPTY_WORK, applyWork, polledStatus, totalsText, turnState, workHtml, workTotals, type AgentWork } from '../work';

const T = '2026-11-14T18:00:00.000Z';

test('sub-agents run until their result comes back', () => {
	let w: AgentWork = applyWork(EMPTY_WORK, { type: 'subagent', id: 't1', name: 'Explore', task: 'find the board code', status: 'running' }, T);
	assert.equal(w.subagents[0].status, 'running');
	w = applyWork(w, { type: 'finished', id: 't1', ok: true, text: 'found in board.ts' }, T);
	assert.deepEqual([w.subagents[0].status, w.subagents[0].result, w.subagents[0].detail], ['done', 'found in board.ts', 'find the board code']);
	assert.equal(applyWork(w, { type: 'finished', id: 'unknown', ok: true }, T), w);
});

test('background commands: started, polled by the shell id, finished or killed', () => {
	let w = applyWork(EMPTY_WORK, { type: 'background', id: 'b1', command: 'npm run watch', status: 'running' }, T);
	w = applyWork(w, { type: 'finished', id: 'b1', ok: true, text: 'Command running in background with ID: shell_7' }, T);
	assert.equal(w.background[0].status, 'running');
	assert.equal(w.aliases.shell_7, 'b1');
	w = applyWork(w, { type: 'poll', id: 'p1', target: 'shell_7' }, T);
	w = applyWork(w, { type: 'finished', id: 'p1', ok: true, text: '<status>running</status>\nwatching…' }, T);
	assert.equal(w.background[0].status, 'running');
	w = applyWork(w, { type: 'poll', id: 'p2', target: 'shell_7' }, T);
	w = applyWork(w, { type: 'finished', id: 'p2', ok: true, text: '<status>failed</status><exit_code>1</exit_code>' }, T);
	assert.equal(w.background[0].status, 'error');
	assert.deepEqual(w.polls, {});
	let k = applyWork(EMPTY_WORK, { type: 'background', id: 'b2', command: 'sleep 100', status: 'running' }, T);
	k = applyWork(k, { type: 'poll', id: 'k', target: 'b2', kill: true }, T);
	k = applyWork(k, { type: 'finished', id: 'k', ok: true, text: 'killed' }, T);
	assert.equal(k.background[0].status, 'done');
	assert.equal(polledStatus('status: completed'), 'done');
	assert.equal(polledStatus('exit code 0'), 'done');
	assert.equal(polledStatus('nothing'), undefined);
});

test('task list, chapters, waiting; a new turn clears only the waiting', () => {
	const board = new ActivityBoard(() => new Date(T));
	board.start('r', 'claude');
	board.work('r', 'claude', { type: 'todos', items: [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'in_progress' }] });
	board.work('r', 'claude', { type: 'chapter', title: 'Implementation' });
	board.work('r', 'claude', { type: 'waiting', reason: 'asks to run a command' });
	let a = board.get('r', 'claude');
	assert.equal(turnState(a.state, a.work, a.error, !!a.ran), 'waiting');
	board.work('r', 'claude', { type: 'waiting' });
	a = board.get('r', 'claude');
	assert.equal(turnState(a.state, a.work, a.error, !!a.ran), 'working');
	board.work('r', 'claude', { type: 'background', id: 'b', command: 'npm test', status: 'running' });
	board.end('r', 'claude');
	a = board.get('r', 'claude');
	assert.equal(turnState(a.state, a.work, a.error, !!a.ran), 'done');
	assert.equal(a.work?.todos.length, 2);
	assert.equal(a.work?.background[0].status, 'running'); // background work outlives the turn
	board.start('r', 'claude');
	assert.equal(board.get('r', 'claude').work?.chapters.length, 1);
	board.error('r', 'claude', 'boom');
	board.end('r', 'claude');
	a = board.get('r', 'claude');
	assert.equal(turnState(a.state, a.work, a.error, !!a.ran), 'error');
	assert.equal(board.all().length, 1);
});

test('totals and the Agents tile part', () => {
	const w = applyWork(applyWork(EMPTY_WORK, { type: 'subagent', id: 's', name: 'Plan', status: 'running' }, T), { type: 'background', id: 'b', command: 'npm run <watch>', status: 'running' }, T);
	const t = workTotals([{ state: 'working', work: w }, { state: 'waiting' }, { state: 'error' }, { state: 'done' }]);
	assert.deepEqual(t, { working: 1, waiting: 1, background: 1, subagents: 1, errors: 1 });
	assert.equal(totalsText(t), '1 working · 1 waiting for you · 1 sub-agent · 1 in the background · 1 error');
	assert.equal(totalsText(workTotals([])), 'nothing running');
	const html = workHtml(applyWork(w, { type: 'todos', items: [{ text: 'A & B', status: 'in_progress' }] }, T), s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
	assert.match(html, /Tasks 0\/1/);
	assert.match(html, /A &amp; B/);
	assert.match(html, /npm run &lt;watch&gt;/);
	assert.match(html, /Sub-agents · 1 running/);
});

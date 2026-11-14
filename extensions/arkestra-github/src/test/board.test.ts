/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Board and Table model: columns, cards, prerequisites, PR chips, rooms, filters.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { boardModel, roomFor, toCard, type RoomInfo } from '../board';
import { boardHtml } from '../boardHtml';
import type { ProjectItem, ProjectSnapshot } from '../project';

const item = (id: string, n: number, over: Partial<ProjectItem> = {}): ProjectItem => ({
	id, type: 'issue', contentId: `C${n}`, number: n, title: `Task ${n}`, url: `https://github.com/o/r/issues/${n}`, state: 'OPEN', repository: 'o/r',
	labels: [], assignees: [], fields: {}, blockedBy: [], pullRequests: [], ...over,
});
const opt = (optionId: string, name: string) => ({ kind: 'option' as const, optionId, name });

const snap: ProjectSnapshot = {
	id: 'P1', owner: 'o', number: 3, title: 'Arkestra', url: 'https://github.com/orgs/o/projects/3', fetchedAt: 0,
	fields: [
		{ id: 'S', name: 'Status', type: 'single_select', options: [{ id: 'b', name: 'Backlog' }, { id: 'r', name: 'Ready', color: 'BLUE' }, { id: 'p', name: 'In progress' }, { id: 'd', name: 'Done' }] },
		{ id: 'L', name: 'Line', type: 'text' },
		{ id: 'E', name: 'Executor', type: 'single_select', options: [{ id: 'cx', name: 'Codex' }, { id: 'cl', name: 'Claude' }] },
		{ id: 'T', name: 'Title', type: 'other' },
	],
	items: [
		item('I41', 41, { fields: { S: opt('p', 'In progress'), L: { kind: 'text', text: '0.9' }, E: opt('cx', 'Codex') }, labels: ['feature'], pullRequests: [{ number: 212, url: 'https://github.com/o/r/pull/212', state: 'OPEN', repository: 'o/r', ci: 'pending' }] }),
		item('I42', 42, { fields: { S: opt('r', 'Ready'), L: { kind: 'text', text: '0.9' } }, blockedBy: [{ id: 'C41', number: 41, repository: 'o/r' }] }),
		item('I49', 49, { fields: { S: opt('r', 'Ready'), L: { kind: 'text', text: '1.x' } }, labels: ['feature'] }),
		item('I33', 33, { state: 'CLOSED', fields: { S: opt('d', 'Done') }, blockedBy: [] }),
		item('I50', 50, { fields: {}, assignees: ['dev'] }),
		item('PR7', 7, { type: 'pr', isDraft: true, url: 'https://github.com/o/r/pull/7', pullRequests: [{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', repository: 'o/r', ci: 'failure' }], reviewDecision: 'CHANGES_REQUESTED', fields: { S: opt('p', 'In progress') } }),
	],
};

const room = (over: Partial<RoomInfo>): RoomInfo => ({ roomId: 'r', title: 'Coding · #41', refs: ['#41'], type: 'coding', status: 'running', phase: 'coding', agents: 2, ...over });

test('rooms are found by link, #N or a task code; a running room wins over an ended one', () => {
	const i41 = snap.items[0];
	assert.equal(roomFor(i41, [room({ roomId: 'a', status: 'ended' }), room({ roomId: 'b' })])?.roomId, 'b');
	assert.equal(roomFor(i41, [room({ refs: ['https://github.com/O/R/issues/41'] })])?.roomId, 'r');
	assert.equal(roomFor(i41, [room({ refs: ['https://github.com/o/r/pull/212'] })])?.roomId, 'r');
	assert.equal(roomFor(item('x', 1, { title: 'AR30 · Board' }), [room({ refs: ['AR30'] })])?.roomId, 'r');
	assert.equal(roomFor(i41, [room({ refs: ['#4'] })]), undefined);
});

test('cards: prerequisites decide startable; PR and review chips; a room on it', () => {
	const rooms = [room({ progress: { done: 2, total: 5 } })];
	const c41 = toCard(snap.items[0], snap, 'S', rooms);
	assert.equal(c41.status, 'In progress');
	assert.deepEqual(c41.prs, [{ label: 'PR #212 · CI running', tone: 'run', url: 'https://github.com/o/r/pull/212' }]);
	assert.equal(c41.room?.progress?.done, 2);
	assert.equal(c41.startable, false); // a room is on it
	const c42 = toCard(snap.items[1], snap, 'S', rooms);
	assert.deepEqual(c42.blockers, [{ label: '#41', open: true, itemId: 'I41' }]);
	assert.equal(c42.startable, false);
	assert.equal(toCard(snap.items[2], snap, 'S', rooms).startable, true);
	assert.equal(toCard(snap.items[3], snap, 'S', rooms).startable, false); // done and closed
	const pr = toCard(snap.items[5], snap, 'S', rooms);
	assert.deepEqual([pr.prs[0].label, pr.review?.label], ['PR #7 · draft', 'changes requested']);
	// The blocker closed: the task can start.
	const closed = { ...snap, items: snap.items.map(i => i.id === 'I41' ? { ...i, state: 'CLOSED' } : i) };
	assert.equal(toCard(closed.items[1], closed, 'S', []).startable, true);
});

test('board: columns in Status order, no-status column, card fields, filters, repositories, sync line', () => {
	const m = boardModel({ snapshot: snap, rooms: [], status: { kind: 'synced', at: 0, live: true }, live: true, journal: [{ at: 0, direction: 'out', item: '#42', text: 'Status: Backlog → Ready' }], clock: () => '14:12:08' });
	assert.deepEqual(m.columns.map(c => [c.name, c.cards.length]), [['No status', 1], ['Backlog', 0], ['Ready', 2], ['In progress', 2], ['Done', 1]]);
	assert.equal(m.columns.find(c => c.name === 'Done')!.done, true);
	assert.deepEqual(m.cardFields, ['L', 'E']);
	assert.deepEqual(m.fields.map(f => f.name), ['Line', 'Executor', 'Title']);
	assert.deepEqual(m.filters.map(f => [f.name, f.values]), [['Status', ['No status', 'Backlog', 'Ready', 'In progress', 'Done']], ['Line', ['0.9', '1.x']], ['Executor', ['Codex']], ['Label', ['feature']], ['Assignee', ['dev']]]);
	assert.deepEqual(m.repositories, ['o/r']);
	assert.deepEqual(m.sync, { text: 'in sync · 14:12:08', tone: 'ok' });
	assert.equal(m.journal[0].text, 'Status: Backlog → Ready');

	const chosen = boardModel({ snapshot: snap, rooms: [], cardFields: ['executor'], status: { kind: 'synced', at: 0, live: false }, live: false, journal: [], clock: () => '1' });
	assert.deepEqual(chosen.cardFields, ['E']);
	assert.equal(chosen.sync.tone, 'warn');
});

test('the page: script and style only with the nonce', () => {
	const html = boardHtml('NONCE', 'vscode-resource:');
	assert.match(html, /script-src 'nonce-NONCE'/);
	assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
	assert.equal((html.match(/<script nonce="NONCE">/g) ?? []).length, 1);
	assert.doesNotMatch(html, /innerHTML/);
});

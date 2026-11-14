/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Graph view: nodes, prerequisite / loose / release edges, critical path,
 *  layout (auto and saved), loop check.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NODE, graphModel, wouldCycle } from '../graph';
import { planModel } from '../plan';
import type { RoomInfo } from '../board';
import type { ProjectItem, ProjectSnapshot } from '../project';

const opt = (optionId: string, name: string) => ({ kind: 'option' as const, optionId, name });
const it = (n: number, status: string, line: string, over: Partial<ProjectItem> = {}): ProjectItem => ({
	id: `I${n}`, type: 'issue', contentId: `C${n}`, number: n, title: `Task ${n}`, url: `https://github.com/o/r/issues/${n}`, state: status === 'Done' ? 'CLOSED' : 'OPEN', repository: 'o/r',
	labels: [], assignees: [], blockedBy: [], pullRequests: [], fields: { S: opt(status[0], status), L: { kind: 'text', text: line } }, ...over,
});
const dep = (n: number) => ({ id: `C${n}`, number: n, repository: 'o/r' });
const snap: ProjectSnapshot = {
	id: 'P', owner: 'o', number: 3, title: 'X', url: '', fetchedAt: 0,
	fields: [{ id: 'S', name: 'Status', type: 'single_select', options: [{ id: 'R', name: 'Ready' }, { id: 'I', name: 'In progress' }, { id: 'D', name: 'Done' }] }, { id: 'L', name: 'Line', type: 'text' }],
	items: [
		it(33, 'Done', '0.9'),
		it(41, 'In progress', '0.9', { blockedBy: [dep(33)] }),
		it(42, 'Ready', '0.9', { blockedBy: [dep(41)] }),
		it(49, 'Ready', '0.9'),
		it(7, 'Ready', '0.9', { type: 'pr', contentId: 'CP7', pullRequests: [{ number: 7, url: '', state: 'OPEN', repository: 'o/r', ci: 'failure' }] }),
	],
};
const room: RoomInfo = { roomId: 'r41', title: 'Coding · #41', refs: ['#41'], type: 'coding', status: 'running', phase: 'coding', agents: 3 };

test('nodes: state lines, the release milestone, linkable only for issues', () => {
	const plan = planModel({ snapshot: snap, rooms: [room] });
	const g = graphModel(snap, [room], plan);
	const n = (id: string) => g.nodes.find(x => x.id === id)!;
	assert.equal(n('I33').sub, 'done');
	assert.equal(n('I41').sub, 'coding room · running · 3 agents');
	assert.equal(n('I41').roomId, 'r41');
	assert.equal(n('I42').sub, 'blocked · #41');
	assert.equal(n('I49').sub, 'startable now');
	assert.equal(n('I7').sub, 'CI failed');
	assert.equal(n('I7').linkable, false);
	const m = n('milestone:0.9');
	assert.deepEqual([m.kind, m.title, m.sub], ['milestone', 'Release 0.9', '4 open prerequisites']);
});

test('edges: prerequisites, release links from the lane\'s last tasks, the critical chain', () => {
	const plan = planModel({ snapshot: snap, rooms: [room] });
	const g = graphModel(snap, [room], plan, { loose: [['I49', 'I42'], ['I49', 'gone']] });
	const pairs = g.edges.map(e => `${e.kind}:${e.from}>${e.to}${e.critical ? '!' : ''}`);
	assert.ok(pairs.includes('blocks:I33>I41'));
	assert.ok(pairs.includes('blocks:I41>I42!'));
	assert.ok(pairs.includes('loose:I49>I42'));
	assert.ok(!pairs.some(p => p.includes('gone')));
	assert.ok(pairs.includes('release:I42>milestone:0.9!'));
	assert.ok(pairs.includes('release:I49>milestone:0.9'));
	assert.ok(!pairs.includes('release:I41>milestone:0.9'));
	assert.deepEqual(g.critical, [{ lane: '0.9', path: ['#41', '#42', 'Release 0.9'] }]);
});

test('layout: columns by level, the release after the last column; saved places win', () => {
	const plan = planModel({ snapshot: snap, rooms: [] });
	const g = graphModel(snap, [], plan);
	const n = (id: string) => g.nodes.find(x => x.id === id)!;
	assert.equal(n('I33').x, NODE.pad);
	assert.equal(n('I41').x, NODE.pad + NODE.dx);
	assert.equal(n('I42').x, NODE.pad + 2 * NODE.dx);
	assert.equal(n('milestone:0.9').x, NODE.pad + 3 * NODE.dx);
	assert.notEqual(n('I33').y, n('I49').y); // both on level 0: one under the other
	const moved = graphModel(snap, [], plan, { positions: { I49: [900, 500] } });
	assert.deepEqual([moved.nodes.find(x => x.id === 'I49')!.x, moved.nodes.find(x => x.id === 'I49')!.y], [900, 500]);
	assert.ok(moved.width >= 900 + NODE.w && moved.height >= 500 + NODE.h);
});

test('a link that would close a loop is caught', () => {
	const g = graphModel(snap, [], planModel({ snapshot: snap, rooms: [] }));
	assert.equal(wouldCycle(g.edges, 'I42', 'I33'), true); // 33 → 41 → 42, so 42 → 33 loops
	assert.equal(wouldCycle(g.edges, 'I49', 'I42'), false);
	assert.equal(wouldCycle(g.edges, 'I49', 'I49'), true);
});

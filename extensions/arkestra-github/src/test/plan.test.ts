/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Plan view: lanes with weighted progress, dependency levels, the critical
 *  path, branch rails, and the git output parsers.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { criticalPath, levels, parseCounts, parseLog, parseRefs, planModel, versionCompare, type GitInfo } from '../plan';
import type { RoomInfo } from '../board';
import type { ProjectItem, ProjectSnapshot } from '../project';

const opt = (optionId: string, name: string) => ({ kind: 'option' as const, optionId, name });
const it = (n: number, status: string, line: string | undefined, over: Partial<ProjectItem> = {}): ProjectItem => ({
	id: `I${n}`, type: 'issue', contentId: `C${n}`, number: n, title: `Task ${n}`, url: `https://github.com/o/r/issues/${n}`, state: status === 'Done' ? 'CLOSED' : 'OPEN', repository: 'o/r',
	labels: [], assignees: [], blockedBy: [], pullRequests: [],
	fields: { S: opt(status[0], status), ...(line ? { L: { kind: 'text' as const, text: line } } : {}) }, ...over,
});
const dep = (n: number) => ({ id: `C${n}`, number: n, repository: 'o/r' });

const items: ProjectItem[] = [
	it(33, 'Done', '0.9'),
	it(27, 'In progress', '0.9', { fields: { S: opt('I', 'In progress'), L: { kind: 'text', text: '0.9' }, W: { kind: 'number', number: 3 } }, pullRequests: [{ number: 208, url: 'https://github.com/o/r/pull/208', state: 'OPEN', repository: 'o/r', headRef: 'x/leverage', ci: 'pending' }] }),
	it(41, 'In progress', '0.9', { blockedBy: [dep(33)] }),
	it(42, 'Ready', '0.9', { blockedBy: [dep(41)] }),
	it(49, 'Ready', '0.9'),
	it(55, 'Backlog', '1.0', { blockedBy: [dep(42)] }),
	it(61, 'Backlog', undefined),
	it(20, 'Done', '0.8'),
];
const snap: ProjectSnapshot = {
	id: 'P', owner: 'o', number: 3, title: 'X', url: '', fetchedAt: 0, items,
	fields: [
		{ id: 'S', name: 'Status', type: 'single_select', options: [{ id: 'B', name: 'Backlog' }, { id: 'R', name: 'Ready' }, { id: 'I', name: 'In progress' }, { id: 'D', name: 'Done' }] },
		{ id: 'L', name: 'Line', type: 'text' },
		{ id: 'W', name: 'Estimate', type: 'number' },
	],
};
const room: RoomInfo = { roomId: 'r41', title: 'Coding · #41', refs: ['#41'], type: 'coding', status: 'running', phase: 'coding', agents: 3, progress: { done: 2, total: 5 }, items: [{ text: 'Schema check', done: true }, { text: 'Version field', done: true }, { text: 'Tests for bad JSON', done: false }], base: 'main', branches: ['x/strategy-import'] };

test('version order: numbers first, then words', () => {
	assert.deepEqual(['1.x', '0.10', 'backlog', '1.0', '0.9'].sort(versionCompare), ['0.9', '0.10', '1.0', '1.x', 'backlog']);
});

test('levels: one after the latest prerequisite; a cycle does not hang', () => {
	const lv = levels(items);
	assert.deepEqual([33, 41, 42, 55, 49].map(n => lv.get(`I${n}`)), [0, 1, 2, 3, 0]);
	const a = it(1, 'Ready', 'x', { blockedBy: [dep(2)] });
	const b = it(2, 'Ready', 'x', { blockedBy: [dep(1)] });
	assert.equal(levels([a, b]).size, 2);
	assert.equal(criticalPath([a, b], [a, b], () => 1).length > 0, true);
});

test('lanes: states in version order, weighted progress, Backlog last', () => {
	const p = planModel({ snapshot: snap, rooms: [room] });
	assert.deepEqual(p.lanes.map(l => [l.name, l.state, l.done, l.total]), [['0.8', 'released', 1, 1], ['0.9', 'development', 1, 5], ['1.0', 'next', 0, 1], ['Backlog', 'later', 0, 1]]);
	// 0.9: #33 done (1×1), #27 in progress (3×0.5), #41 room 2/5 (1×0.4), #42 and #49 nothing → 2.9 / 7
	assert.equal(p.lanes[1].percent, Math.round(100 * 2.9 / 7));
	assert.equal(p.laneField, 'Line');
	assert.equal(p.weightField, 'Estimate');
});

test('critical path follows the most remaining work to the release', () => {
	const p = planModel({ snapshot: snap, rooms: [room] });
	const c09 = p.critical.find(c => c.lane === '0.9')!;
	assert.deepEqual(c09.path, ['#41', '#42', 'Release 0.9']);
	const stairs09 = p.stairs.find(s => s.lane === '0.9')!;
	assert.deepEqual(stairs09.cells.filter(c => c.critical).map(c => c.label), ['#41', '#42']);
	assert.equal(stairs09.cells.find(c => c.label === '#49')!.startable, true);
	assert.equal(stairs09.cells.find(c => c.label === '#42')!.startable, false);
	const c41 = stairs09.cells.find(c => c.label === '#41')!;
	assert.deepEqual([c41.running, c41.roomId, c41.level], [true, 'r41', 1]);
	assert.equal(p.levels, 4);
});

test('rails: the base branch with what landed and the open PRs in order; branches with the room list', () => {
	const git: GitInfo = {
		base: 'main', baseHead: 'a41c09e', tags: ['v0.8.2', 'v0.8.1'],
		log: parseLog('a41c09e\tLeverage prep (#204)\t\nf00\tRelease 0.8.2\ttag: v0.8.2\nabc\tDry run (#33)\t'),
		branches: new Map([['x/strategy-import', { sha: '7be20d4', ahead: 4, behind: 1 }], ['x/leverage', { sha: '9c1', ahead: 2, behind: 0 }]]),
	};
	const p = planModel({ snapshot: snap, rooms: [room], git });
	assert.equal(p.live, 'v0.8.2');
	const main = p.rails[0];
	assert.deepEqual([main.name, main.head, main.kind], ['main', 'a41c09e', 'base']);
	assert.deepEqual(main.steps.map(s => s.label), ['#33', 'v0.8.2', '#204', 'now', '#27 → main', '0.9 tag']);
	assert.equal(main.steps.find(s => s.label === '#27 → main')!.sub, 'PR #208 · CI running');
	const branch = p.rails.find(r => r.name === 'x/strategy-import')!;
	assert.equal(branch.head, '7be20d4');
	assert.match(branch.note, /#41 Task 41 · coding room · coding · 3 agents · 4 ahead · 1 behind/);
	assert.deepEqual(branch.steps.map(s => s.label), ['Schema check', 'Version field', 'now', '01 Tests for bad JSON', 'merge → main']);
	assert.equal(branch.steps.find(s => s.now)!.roomId, 'r41');
	assert.ok(p.rails.some(r => r.name === 'x/leverage'));
});

test('git output parsers', () => {
	assert.deepEqual(parseLog('abc\tFix (#1)\ttag: v1, origin/main'), [{ sha: 'abc', subject: 'Fix (#1)', refs: ['tag: v1', 'origin/main'] }]);
	const refs = parseRefs('origin/HEAD\tz\norigin/main\t111\nmain\t222\norigin/feature\t333');
	assert.deepEqual([...refs.entries()], [['main', '222'], ['feature', '333']]);
	assert.deepEqual(parseCounts('1\t4\n'), { behind: 1, ahead: 4 });
	assert.equal(parseCounts(''), undefined);
});

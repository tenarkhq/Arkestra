/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar's sections: made, renamed, ordered and filled by the user only.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { addSection, deleteSection, keepThreads, layoutThreads, matches, moveSection, moveThread, parseSections, renameSection, sectionOf, sectionsFromCategories, shiftSection, type Section } from '../sections';
import type { ThreadSummary } from '../threads';

const thread = (id: string, lastAt: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({ id, title: id, pinned: false, archived: false, lastAt, agents: 1, ...extra });
const ids = (list: readonly { id: string }[]) => list.map(x => x.id);

test('stored sections are cleaned: bad entries go, a thread stays in its first section only', () => {
	assert.deepEqual(parseSections(undefined), []);
	assert.deepEqual(parseSections({}), []);
	const parsed = parseSections([
		{ id: 'a', name: ' Tenark X ', threadIds: ['t1', 't2', 't1', 7] },
		{ id: 'a', name: 'dup id', threadIds: [] },
		{ id: 'b', name: '   ', threadIds: [] },
		null,
		{ id: 'c', name: 'WoW', threadIds: ['t2', 't3'] },
		{ id: 'd', name: 'No list' },
	]);
	assert.deepEqual(parsed, [
		{ id: 'a', name: 'Tenark X', threadIds: ['t1', 't2'] },
		{ id: 'c', name: 'WoW', threadIds: ['t3'] },
		{ id: 'd', name: 'No list', threadIds: [] },
	]);
});

test('sections are added at the end, renamed and deleted; deleting frees its threads', () => {
	let list: Section[] = [];
	list = addSection(list, 's1', ' Tenark X ');
	list = addSection(list, 's2', 'ArkadeOS');
	list = addSection(list, 's3', '  ');
	list = addSection(list, 's1', 'taken id');
	assert.deepEqual(list.map(s => s.name), ['Tenark X', 'ArkadeOS']);
	list = renameSection(list, 's2', ' WoW ');
	list = renameSection(list, 's1', '   ');
	assert.deepEqual(list.map(s => s.name), ['Tenark X', 'WoW']);
	list = moveThread(list, 't1', 's2');
	list = deleteSection(list, 's2');
	assert.deepEqual(ids(list), ['s1']);
	assert.equal(sectionOf(list, 't1'), undefined);
});

test('a thread lives in one section at a time and can go back to none', () => {
	let list: Section[] = [{ id: 'a', name: 'A', threadIds: ['t1'] }, { id: 'b', name: 'B', threadIds: [] }];
	list = moveThread(list, 't1', 'b');
	list = moveThread(list, 't2', 'b');
	assert.deepEqual(list.map(s => s.threadIds), [[], ['t2', 't1']]);
	assert.equal(sectionOf(list, 't1'), 'b');
	list = moveThread(list, 't1', undefined);
	assert.equal(sectionOf(list, 't1'), undefined);
	list = moveThread(list, 't2', 'missing');
	assert.equal(sectionOf(list, 't2'), undefined, 'an unknown section means no section');
});

test('sections are reordered by drag (before another, or to the end) and by one step', () => {
	const list: Section[] = ['a', 'b', 'c'].map(id => ({ id, name: id, threadIds: [] }));
	assert.deepEqual(ids(moveSection(list, 'c', 'a')), ['c', 'a', 'b']);
	assert.deepEqual(ids(moveSection(list, 'a', undefined)), ['b', 'c', 'a']);
	assert.deepEqual(ids(moveSection(list, 'a', 'a')), ['a', 'b', 'c']);
	assert.deepEqual(ids(moveSection(list, 'x', 'a')), ['a', 'b', 'c']);
	assert.deepEqual(ids(shiftSection(list, 'b', -1)), ['b', 'a', 'c']);
	assert.deepEqual(ids(shiftSection(list, 'b', 1)), ['a', 'c', 'b']);
	assert.deepEqual(ids(shiftSection(list, 'a', -1)), ['a', 'b', 'c']);
	assert.deepEqual(ids(shiftSection(list, 'c', 1)), ['a', 'b', 'c']);
});

test('deleted threads leave their sections; nothing deleted keeps the same list', () => {
	const list: Section[] = [{ id: 'a', name: 'A', threadIds: ['t1', 'gone'] }, { id: 'b', name: 'B', threadIds: ['t2'] }];
	const kept = keepThreads(list, new Set(['t1', 't2']));
	assert.deepEqual(kept.map(s => s.threadIds), [['t1'], ['t2']]);
	assert.equal(keepThreads(kept, new Set(['t1', 't2'])), kept);
});

test('the categories given before become sections on the first run', () => {
	const threads = [thread('t1', '1', { category: 'WoW' }), thread('t2', '2', { category: 'Tenark X' }), thread('t3', '3', { category: 'WoW' }), thread('t4', '4')];
	assert.deepEqual(sectionsFromCategories(threads, i => `s${i}`), [
		{ id: 's0', name: 'Tenark X', threadIds: ['t2'] },
		{ id: 's1', name: 'WoW', threadIds: ['t1', 't3'] },
	]);
});

test('every thread shows once: pinned, its section, no section or archived, newest first', () => {
	const threads = [
		thread('old', '2026-11-01'),
		thread('new', '2026-11-14'),
		thread('filed-old', '2026-11-02'),
		thread('filed-new', '2026-11-13'),
		thread('pinned-filed', '2026-11-10', { pinned: true }),
		thread('archived-filed', '2026-11-12', { archived: true }),
		thread('archived', '2026-11-11', { archived: true }),
		thread('just-opened', ''),
	];
	const sections: Section[] = [
		{ id: 'b', name: 'B', threadIds: [] },
		{ id: 'a', name: 'A', threadIds: ['filed-old', 'filed-new', 'pinned-filed', 'archived-filed'] },
	];
	const layout = layoutThreads(threads, sections);
	assert.deepEqual(ids(layout.pinned), ['pinned-filed']);
	assert.deepEqual(layout.sections.map(s => s.section.id), ['b', 'a'], 'the user\'s order');
	assert.deepEqual(layout.sections.map(s => ids(s.threads)), [[], ['filed-new', 'filed-old']]);
	assert.deepEqual(ids(layout.unsectioned), ['new', 'old', 'just-opened'], 'nothing is filed on its own');
	assert.deepEqual(ids(layout.archived), ['archived-filed', 'archived']);
});

test('search keeps the matching threads in their places, ignoring case and accents', () => {
	assert.ok(matches('Átadó beolvasása', 'atado'));
	assert.ok(matches('WoW addon írása', 'addon wow'));
	assert.ok(!matches('WoW addon', 'landing'));
	assert.ok(matches('anything', '  '));
	const threads = [thread('Landing page', '2'), thread('WoW addon', '1'), thread('Landing old', '0', { archived: true })];
	const layout = layoutThreads(threads, [{ id: 'a', name: 'A', threadIds: ['WoW addon'] }], 'landing');
	assert.deepEqual(ids(layout.unsectioned), ['Landing page']);
	assert.deepEqual(layout.sections.map(s => ids(s.threads)), [[]]);
	assert.deepEqual(ids(layout.archived), ['Landing old']);
});

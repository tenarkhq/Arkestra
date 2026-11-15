/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar's default listing: every session of every machine once, by agent,
 *  a continued session as its thread's row, sections and Pinned first, 30 days then "older".
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { agentGroups, groupOrder, machineCount, sessionRowId, threadGroup, uniqueSessions, type AgentListing, type GroupItem } from '../leftBar';
import { layoutThreads } from '../sections';
import type { ListedSession } from '../sessionHome';
import type { ThreadSummary } from '../threads';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const DAY = 24 * 60;
const session = (id: string, title: string, minutes: number, extra: Partial<ListedSession> = {}): ListedSession => ({ id, title, updatedAt: ago(minutes), cwd: '/home/tenark-claude/tenark-dev', ...extra });
const thread = (id: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({ id, title: id, pinned: false, archived: false, lastAt: ago(60), agents: 1, roster: ['claude'], ...extra });
const titles = (items: readonly GroupItem[]) => items.map(i => i.kind === 'thread' ? i.thread.title : i.entry.session.title);
const groups = (threads: readonly ThreadSummary[], listings: readonly AgentListing[], extra: { query?: string; busy?: (id: string) => boolean; all?: readonly ThreadSummary[] } = {}) =>
	agentGroups({ threads, all: extra.all ?? threads, listings, query: extra.query ?? '', now: NOW, busy: extra.busy ?? (() => false) });

test('a session listed by an SSH machine and as a copy here shows once, as the SSH machine\'s', () => {
	const listings: AgentListing[] = [
		{ agentId: 'claude', sessions: [session('s1', 'Tenark X', 5, { elsewhere: true }), session('mac', 'Mac only', 10, { cwd: '/Users/r/x' })] },
		{ agentId: 'claude@tenark-claude', sessions: [session('s1', 'Tenark X', 5)] },
	];
	const unique = uniqueSessions(listings);
	assert.deepEqual(unique.map(e => `${e.agentId}:${e.session.id}`).sort(), ['claude:mac', 'claude@tenark-claude:s1']);
});

test('a copy here that no SSH machine lists stays out while its CLI has an SSH agent, and shows when none has', () => {
	const copy = session('old', 'Old server thread', 50, { elsewhere: true });
	assert.deepEqual(uniqueSessions([{ agentId: 'claude', sessions: [copy] }, { agentId: 'claude@tenark-claude', sessions: [] }]), []);
	assert.equal(uniqueSessions([{ agentId: 'claude', sessions: [copy] }, { agentId: 'codex@tenark-codex', sessions: [] }]).length, 1);
});

test('every session of every machine is listed by agent kind, newest first, without importing by hand', () => {
	const listings: AgentListing[] = [
		{ agentId: 'claude@tenark-claude', sessions: [session('a', 'ArkadeOS', 30), session('b', 'Tenark X', 2 * DAY)] },
		{ agentId: 'claude@tenark', sessions: [session('c', 'SlimARK-UI', 10)] },
		{ agentId: 'codex@tenark-codex', sessions: [session('d', 'Board sync', 20)] },
	];
	const out = groups([], listings);
	assert.deepEqual(out.map(g => g.id), ['claude', 'codex']);
	assert.deepEqual(titles(out[0].items), ['SlimARK-UI', 'ArkadeOS', 'Tenark X']);
	assert.deepEqual(titles(out[1].items), ['Board sync']);
	const first = out[0].items[0];
	assert.equal(first.kind, 'session');
	assert.equal(first.kind === 'session' && sessionRowId(first.entry.agentId, first.entry.session.id), 'claude@tenark\nc');
	assert.equal(first.machine, 'tenark');
	assert.equal(machineCount(out), 3, 'three machines: each row names its machine');
	assert.equal(machineCount(groups([], [listings[0]])), 1, 'one machine: no machine label needed');
});

test('a continued session shows as its thread\'s row, also when the thread followed this machine\'s copy', () => {
	const listings: AgentListing[] = [{ agentId: 'claude@tenark-claude', sessions: [session('s1', 'Tenark X', 1), session('s2', 'ArkadeOS', 30)] }];
	const room = thread('Tenark X thread', { adopted: [{ agent: 'claude', session: 's1' }], lastAt: ago(3 * DAY) });
	const out = groups([room], listings);
	assert.deepEqual(titles(out[0].items), ['Tenark X thread', 'ArkadeOS']);
	const row = out[0].items[0];
	assert.equal(row.kind, 'thread');
	assert.equal(row.at, ago(1), 'sorted by what the session wrote last');
	assert.equal(row.running, true, 'its session file changed within two minutes');
});

test('sections override the agent listing: a thread put into a section (or pinned, or archived) leaves the agent group and its session does not come back', () => {
	const listings: AgentListing[] = [{ agentId: 'claude@tenark-claude', sessions: [session('s1', 'GUARDARK', 5), session('s2', '2ARK', 6), session('s3', 'Kripto', 7)] }];
	const all = [
		thread('GUARDARK', { adopted: [{ agent: 'claude@tenark-claude', session: 's1' }] }),
		thread('2ARK', { adopted: [{ agent: 'claude@tenark-claude', session: 's2' }], pinned: true }),
		thread('Kripto', { adopted: [{ agent: 'claude@tenark-claude', session: 's3' }], archived: true }),
		thread('Plain chat', { roster: ['claude'] }),
	];
	const layout = layoutThreads(all, [{ id: 'sec', name: 'Trading', threadIds: ['GUARDARK'] }]);
	const out = groups(layout.unsectioned, listings, { all });
	assert.deepEqual(out.map(g => [g.id, titles(g.items)]), [['claude', ['Plain chat']]]);
	assert.deepEqual(layout.sections[0].threads.map(t => t.title), ['GUARDARK']);
	assert.deepEqual(layout.pinned.map(t => t.title), ['2ARK']);
});

test('Arkestra\'s own threads fold into the group of their agent; several kinds of agents and none have their own groups, last', () => {
	assert.equal(threadGroup(thread('a', { roster: ['codex@tenark-codex'] })), 'codex');
	assert.equal(threadGroup(thread('b', { roster: ['claude', 'claude@tenark-claude'] })), 'claude');
	assert.equal(threadGroup(thread('c', { roster: ['claude', 'codex'] })), 'several');
	assert.equal(threadGroup(thread('d', { roster: [] })), 'other');
	assert.equal(threadGroup(thread('e', { roster: ['claude', 'codex'], adopted: [{ agent: 'codex@x', session: 's' }] })), 'codex', 'a continued session decides');
	assert.deepEqual(['other', 'several', 'openai', 'codex', 'claude'].sort((a, b) => groupOrder(a, b)), ['claude', 'codex', 'openai', 'several', 'other']);
});

test('the last 30 days show; older ones wait behind "Show older"; a search finds them all, and finds session rows', () => {
	const listings: AgentListing[] = [{ agentId: 'claude@tenark-claude', sessions: [session('n', 'Ezek plusz usage', 60), session('o', 'Tőkeáttételes kalkulátor', 40 * DAY)] }];
	const out = groups([thread('Ancient chat', { lastAt: ago(90 * DAY) }), thread('Empty chat', { lastAt: '' })], listings);
	assert.deepEqual(titles(out[0].items), ['Ezek plusz usage', 'Empty chat']);
	assert.deepEqual(titles(out[0].older), ['Tőkeáttételes kalkulátor', 'Ancient chat']);
	const found = groups([thread('Ancient chat', { lastAt: ago(90 * DAY) })], listings, { query: 'tokeattet' });
	assert.deepEqual(titles(found[0].items), ['Tőkeáttételes kalkulátor'], 'accents ignored, older rows found too');
	assert.deepEqual(found[0].older, []);
});

test('running: a busy thread, or a session whose file changed in the last two minutes', () => {
	const listings: AgentListing[] = [{ agentId: 'codex@tenark-codex', sessions: [session('live', 'Live', 1), session('idle', 'Idle', 3)] }];
	const out = groups([thread('Busy', { roster: ['codex'] })], listings, { busy: id => id === 'Busy' });
	assert.deepEqual(out[0].items.map(i => [titles([i])[0], i.running]), [['Live', true], ['Idle', false], ['Busy', true]]);
});

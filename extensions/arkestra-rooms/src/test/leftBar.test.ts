/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar's default listing: every session of every machine once, by agent,
 *  a continued session as its thread's row, sections and Pinned first, 30 days then "older".
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { agentGroups, groupOrder, machineCount, sessionRowId, threadGroup, uniqueSessions, type AgentListing, type GroupItem, rowState } from '../leftBar';
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

test('a thread outside the agent groups knows its agent and machine: its continued session first, else its only agent', async () => {
	const { threadMachine } = await import('../leftBar');
	const t = (roster: string[], adopted?: { agent: string; session: string }[]) => ({ id: 'x', title: 'x', pinned: false, archived: false, lastAt: '', agents: roster.length, roster, ...(adopted ? { adopted } : {}) });
	assert.deepEqual([threadGroup(t(['claude@tenark-claude'], [{ agent: 'claude@tenark-claude', session: 's' }])), threadMachine(t(['claude@tenark-claude'], [{ agent: 'claude@tenark-claude', session: 's' }]))], ['claude', 'tenark-claude']);
	assert.deepEqual([threadGroup(t(['codex'])), threadMachine(t(['codex']))], ['codex', 'local']);
	assert.deepEqual([threadGroup(t(['claude', 'codex'])), threadMachine(t(['claude', 'codex']))], ['several', undefined]);
});

test('the status dot: waiting for you beats stuck, stuck beats running; done only for an answer not seen', () => {
	assert.equal(rowState({ running: true, cloud: { worker: 'requires_action' } }), 'wait');
	assert.equal(rowState({ running: false, planWaiting: true }), 'wait');
	assert.equal(rowState({ running: true, failed: true }), 'err');
	assert.equal(rowState({ running: false, cloud: { worker: 'running' } }), 'run');
	assert.equal(rowState({ running: false, cloud: { worker: 'idle', unread: true } }), 'done');
	assert.equal(rowState({ running: false, cloud: { worker: 'idle', unread: true }, selected: true }), undefined, 'the open thread is being seen');
	assert.equal(rowState({ running: false, answeredAt: '2026-11-15T14:00:00Z', viewedAt: '2026-11-15T13:00:00Z' }), 'done');
	assert.equal(rowState({ running: false, answeredAt: '2026-11-15T12:00:00Z', viewedAt: '2026-11-15T13:00:00Z' }), undefined);
	assert.equal(rowState({ running: false, cloud: { worker: 'idle' }, answeredAt: '2026-11-15T14:00:00Z', viewedAt: '2026-11-15T13:00:00Z' }), undefined, 'the Claude app\'s account knows its sessions');
});

// ---- sub-threads ----------------------------------------------------------------------------
import { learnHosts, nestRows, parentOf, sessionFamily, starters, threadFamily, type Family } from '../leftBar';

interface Row { readonly key: string; readonly children?: readonly Row[] }
const r = (key: string): Row => ({ key });
const shape = (rows: readonly Row[]): string[] => rows.map(x => x.children?.length ? `${x.key}[${shape(x.children).join(',')}]` : x.key);
const fam = (map: Record<string, { self: string; parent?: string }>) => (row: Row): Family | undefined => {
	const f = map[row.key];
	return f ? { self: [f.self], ...(f.parent ? { parent: f.parent } : {}) } : undefined;
};

test('sub-threads: a started thread shows under its starter, in the order listed', () => {
	const f = fam({ a: { self: 'claude\nA' }, b: { self: 'claude\nB', parent: 'claude\nA' }, c: { self: 'claude\nC', parent: 'claude\nA' }, d: { self: 'claude\nD' } });
	const out = nestRows([{ rows: [r('b'), r('c'), r('a'), r('d')] }], f);
	assert.deepEqual(shape(out[0]), ['a[b,c]', 'd']);
});

test('sub-threads: in a section, in Pinned and across lists alike; the starter keeps its place', () => {
	const f = fam({ p: { self: 'claude\nP' }, k: { self: 'claude\nK', parent: 'claude\nP' }, s: { self: 'codex\nS' }, t: { self: 'codex\nT', parent: 'codex\nS' } });
	// p is in a section, its sub-thread in the agent list; s in Pinned, its sub-thread in Archived.
	const out = nestRows([{ rows: [r('s')] }, { rows: [r('p')] }, { rows: [r('k')] }, { rows: [r('t')] }], f);
	assert.deepEqual(out.map(shape), [['s[t]'], ['p[k]'], [], []]);
});

test('sub-threads: nested twice, a starter that does not show leaves the row where it is, a loop stays flat', () => {
	const f = fam({ a: { self: 'x\nA' }, b: { self: 'x\nB', parent: 'x\nA' }, c: { self: 'x\nC', parent: 'x\nB' }, o: { self: 'x\nO', parent: 'x\nGONE' }, l1: { self: 'x\nL1', parent: 'x\nL2' }, l2: { self: 'x\nL2', parent: 'x\nL1' } });
	const out = nestRows([{ rows: [r('c'), r('b'), r('a'), r('o'), r('l1'), r('l2')] }], f);
	assert.deepEqual(shape(out[0]), ['a[b[c]]', 'o', 'l1', 'l2']);
});

test('sub-threads: a starter under "Show older" with a recent sub-thread moves up, in that sub-thread\'s place', () => {
	const f = fam({ new1: { self: 'x\nN1' }, kid: { self: 'x\nK', parent: 'x\nOLD' }, new2: { self: 'x\nN2' }, old: { self: 'x\nOLD' }, old2: { self: 'x\nO2' } });
	const out = nestRows([{ rows: [r('new1'), r('kid'), r('new2')] }, { rows: [r('old'), r('old2')], recent: 0 }], f);
	assert.deepEqual(out.map(shape), [['new1', 'old[kid]', 'new2'], ['old2']]);
});

test('sub-threads: nothing started anything: the lists as they were', () => {
	const out = nestRows([{ rows: [r('a'), r('b')] }, { rows: [r('c')], recent: 0 }], () => undefined);
	assert.deepEqual(out.map(shape), [['a', 'b'], ['c']]);
});

test('sub-threads: Codex names the parent thread; a Claude linked session its starter\'s desktop-app id', () => {
	const listings: AgentListing[] = [
		{ agentId: 'codex', sessions: [session('t1', 'main', 1), session('t2', 'explorer', 1, { parent: 't1' })] },
		{ agentId: 'claude@tenarkprd', sessions: [session('p1', 'parent', 5, { host: 'local_aaa' }), session('c1', 'child', 2, { parentHost: 'local_aaa' }), session('c2', 'orphan', 2, { parentHost: 'local_zzz' })] },
	];
	assert.equal(parentOf(listings[0].sessions[1], {}, listings), 't1');
	assert.equal(parentOf(listings[1].sessions[1], {}, listings), 'p1');
	assert.equal(parentOf(listings[1].sessions[2], {}, listings), undefined);
	// Learned once while the parent ran: it still resolves after the app closed it.
	assert.equal(parentOf(listings[1].sessions[2], { local_zzz: 'p9' }, listings), 'p9');
	const started = starters(listings, {});
	assert.deepEqual(sessionFamily('codex', 't2', started), { self: ['codex\nt2'], parent: 'codex\nt1' });
	assert.deepEqual(sessionFamily('claude@tenarkprd', 'c1', started), { self: ['claude\nc1'], parent: 'claude\np1' });
	// A thread continuing a session takes that session's starter.
	assert.deepEqual(threadFamily(thread('room', { adopted: [{ agent: 'claude@tenarkprd', session: 'c1' }] } as Partial<ThreadSummary>), started), { self: ['claude\nc1'], parent: 'claude\np1' });
});

test('sub-threads: the desktop-app ids are learned and kept, the same map when nothing is new', () => {
	const listings: AgentListing[] = [{ agentId: 'claude', sessions: [session('p1', 'parent', 5, { host: 'local_aaa' }), session('x', 'plain', 5)] }];
	const once = learnHosts({}, listings);
	assert.deepEqual(once, { local_aaa: 'p1' });
	assert.equal(learnHosts(once, listings), once);
	assert.deepEqual(learnHosts({ local_old: 'o' }, listings), { local_old: 'o', local_aaa: 'p1' });
});

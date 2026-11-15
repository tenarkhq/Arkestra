/*---------------------------------------------------------------------------------------------
 *  Arkestra. Where a CLI session lives (a copy here of an SSH machine's session goes on there),
 *  a thread read again with a newer reader, the session's model and context fill (AR39).
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentRegistry, type Agent, type ExistingSession, type SessionEntry, type SessionMeta, type TurnInput } from '../agent';
import { currentModelLabel, sessionModelLabel } from '../choice';
import { Room, importedRoomState, mergeHistory, newRoomState, withMeta, type Message, type RoomState } from '../room';
import { SessionFollow } from '../sessionFollow';
import { COMPACTED, agentKind, cleanSessionMessages, healAdopted, homeOf, isForeign, placeLocalSessions, rehome, sessionContext } from '../sessionHome';

const S = (id: string, cwd?: string): ExistingSession => ({ id, title: id, ...(cwd ? { cwd } : {}), updatedAt: '2026-11-15T08:00:00Z' });
const here = (cwd: string) => cwd.startsWith('/Users/roland');

test('a session this machine only holds a copy of: listed under the SSH machine that has it; a copy nobody has stays, marked', () => {
	const local = [S('mine', '/Users/roland/p'), S('server', '/home/tenark-claude/tenark-dev'), S('orphan', '/home/other/x'), S('nofolder')];
	assert.deepEqual(placeLocalSessions('claude', local, here, [[S('server', '/home/tenark-claude/tenark-dev')], []]).map(s => [s.id, !!s.elsewhere]), [
		['mine', false], ['orphan', true], ['nofolder', false],
	]);
	// An SSH machine's own list is not this machine's business.
	assert.deepEqual(placeLocalSessions('claude@tenark', local, here, []).map(s => s.id), ['mine', 'server', 'orphan', 'nofolder']);
	assert.equal(agentKind('codex@prd'), 'codex');
	assert.equal(agentKind('claude'), 'claude');
	assert.ok(isForeign('claude', '/home/x', here));
	assert.ok(!isForeign('claude', '/Users/roland/p', here));
	assert.ok(!isForeign('claude@tenark', '/home/x', here));
	assert.ok(!isForeign('claude', undefined, here));
});

test('the home of a copy: an SSH agent of the same CLI that lists the session; nothing for a session of this machine', () => {
	const candidates = [
		{ agent: { id: 'codex@tenark' }, sessions: [S('s1', '/home/t')] },
		{ agent: { id: 'claude@other' }, sessions: [S('s2')] },
		{ agent: { id: 'claude@tenark' }, sessions: [S('s1', '/home/t')] },
	];
	assert.equal(homeOf('claude', { id: 's1', cwd: '/home/t' }, here, candidates)?.agent.id, 'claude@tenark');
	assert.equal(homeOf('codex', { id: 's1', cwd: '/home/t' }, here, candidates)?.agent.id, 'codex@tenark');
	assert.equal(homeOf('claude', { id: 's1', cwd: '/Users/roland/p' }, here, candidates), undefined, 'its folder is here: this machine\'s own');
	assert.equal(homeOf('claude', { id: 's9', cwd: '/home/t' }, here, candidates), undefined, 'no machine has it');
	assert.equal(homeOf('claude@x', { id: 's1', cwd: '/home/t' }, here, candidates), undefined);
});

test('a thread that followed the copy moves to the SSH agent: roster, session (its follow starts again), choice, messages; the copy\'s folder is no project', () => {
	const state = importedRoomState({ id: 'claude', name: 'Claude' }, S('s1', '/home/tenark-claude/tenark-dev'), { entries: [{ role: 'user', text: 'go', id: 'u1' }, { role: 'agent', text: 'Going.', id: 'a1' }], cursor: '900' }, 'file:///home/tenark-claude/tenark-dev');
	state.choices = { claude: { effort: 'high' } };
	state.messages.push({ id: 'own', at: '', author: { kind: 'agent', id: 'codex', name: 'Codex' }, text: 'mine' });
	assert.ok(rehome(state, 'claude', { id: 'claude@tenark', name: 'Claude · tenark' }));
	assert.deepEqual(state.roster, ['claude@tenark']);
	assert.deepEqual(Object.keys(state.adopted!), ['claude@tenark']);
	assert.equal(state.adopted!['claude@tenark'].cursor, undefined);
	assert.equal(state.adopted!['claude@tenark'].session, 's1');
	assert.deepEqual(state.choices, { 'claude@tenark': { effort: 'high' } });
	assert.deepEqual(state.messages.slice(1).map(m => [m.author.id, m.author.name, m.source?.agent]), [
		['user', 'You', 'claude@tenark'], ['claude@tenark', 'Claude · tenark', 'claude@tenark'], ['codex', 'Codex', undefined],
	]);
	assert.equal(state.project, undefined);
	assert.ok(!rehome(state, 'claude', { id: 'claude@tenark', name: 'x' }), 'once');
});

test('read again with a newer reader: what the old import missed goes in at its place, a split answer and a task line are fixed, the room\'s own messages stay', () => {
	const now = () => new Date('2026-11-15T09:00:00Z');
	const agent = { id: 'claude@tenark', name: 'Claude · tenark' };
	// What an older build imported: the message sent mid-turn missing (the answer around it in one), a task report as raw XML, a compaction summary as a user message.
	const state = importedRoomState(agent, S('s1'), [
		{ role: 'user', text: 'first', id: 'u1' },
		{ role: 'agent', text: 'Part one.\n\nPart two.', id: 'a1' },
		{ role: 'user', text: '<task-notification>\n<summary>npm test done</summary>\n</task-notification>', id: 'n1' },
		{ role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.', id: 'c2' },
	], undefined, now);
	state.messages.push({ id: 'r1', at: '', author: { kind: 'user', id: 'user', name: 'You' }, text: 'asked in the room' });
	assert.ok(mergeHistory(state, agent, [
		{ role: 'user', text: 'first', id: 'u1' },
		{ role: 'agent', text: 'Part one.', id: 'a1' },
		{ role: 'user', text: 'sent while it worked', id: 'q1' },
		{ role: 'agent', text: 'Part two.', id: 'a2' },
		{ role: 'system', text: 'npm test done', id: 'n1' },
		{ role: 'system', text: COMPACTED, id: 'c1' },
		{ role: 'user', text: 'later', id: 'u3' },
	], now));
	cleanSessionMessages(state);
	assert.deepEqual(state.messages.slice(1).map(m => [m.author.kind, m.text]), [
		['user', 'first'],
		['agent', 'Part one.'],
		['user', 'sent while it worked'],
		['agent', 'Part two.'],
		['system', 'npm test done'],
		['system', COMPACTED],
		['user', 'later'],
		['system', COMPACTED],
		['user', 'asked in the room'],
	]);
	assert.ok(!mergeHistory(state, agent, [{ role: 'user', text: 'first', id: 'u1' }], now), 'nothing new: no change');
	// A session with nothing of it in the thread yet: after what is there.
	const fresh = newRoomState('x');
	mergeHistory(fresh, agent, [{ role: 'user', text: 'a', id: 'x1' }, { role: 'agent', text: 'b' }], now);
	assert.deepEqual(fresh.messages.map(m => m.text), ['a'], 'an entry without an id cannot be placed');
});

test('old threads heal: a compaction summary and a task report the user never wrote become short lines', () => {
	const m = (text: string, kind: 'user' | 'agent' = 'user'): Message => ({ id: text.slice(0, 5), at: '', author: { kind, id: kind === 'user' ? 'user' : 'claude', name: kind }, text });
	const state: RoomState = { ...newRoomState('t'), messages: [
		m('<artifact-content-authored-by-others/>\nThis session is being continued from a previous conversation that ran out of context. Summary: …'),
		m('<task-notification>\n<task-id>b1</task-id>\n<summary>Build done</summary>\n<summary>Tests green</summary>\n</task-notification>'),
		m('<task-notification><status>killed</status></task-notification>'),
		m('fix the stop'),
		m('This session is being continued from a previous conversation', 'agent'),
	] };
	assert.ok(cleanSessionMessages(state));
	assert.deepEqual(state.messages.map(x => [x.author.kind, x.text]), [
		['system', COMPACTED], ['system', 'Build done · Tests green'], ['system', 'Background task finished'], ['user', 'fix the stop'], ['agent', 'This session is being continued from a previous conversation'],
	]);
	assert.ok(!cleanSessionMessages(state));
	// The summary right after the compaction's own line (read again from the session): one line.
	const twice: RoomState = { ...newRoomState('t'), messages: [{ ...m('x'), author: { kind: 'system', id: 'system', name: 'Claude' }, text: COMPACTED }, m('This session is being continued from a previous conversation. …'), m('go on')] };
	assert.ok(cleanSessionMessages(twice));
	assert.deepEqual(twice.messages.map(x => x.text), [COMPACTED, 'go on']);
});

test('the session\'s model and context fill: kept from the import and the follow; the next turn runs on that model unless one is chosen', async () => {
	const registry = new AgentRegistry();
	const inputs: TurnInput[] = [];
	registry.register({ id: 'claude@tenark', name: 'Claude · tenark', detail: 't', readiness: async () => ({ ready: true }), turn: async i => { inputs.push(i); } });
	const state = importedRoomState({ id: 'claude@tenark', name: 'Claude · tenark', historyVersion: 2 }, S('s1'), { entries: [], cursor: '10', meta: { model: 'claude-opus-5-5', context: 191_675 } });
	assert.deepEqual(state.adopted!['claude@tenark'], { session: 's1', upTo: state.messages[0].id, cursor: '10', version: 2, model: 'claude-opus-5-5', context: 191_675 });
	const room = new Room(state, registry);
	let changes = 0;
	room.onDidChange(() => changes++);
	room.followed('claude@tenark', [], '10', { model: 'claude-opus-5-5', context: 191_675 });
	assert.equal(changes, 0, 'the same: nothing saved');
	room.followed('claude@tenark', [], '10', { context: 211_556 });
	assert.equal(changes, 1);
	assert.equal(room.state.adopted!['claude@tenark'].context, 211_556);
	assert.equal(sessionContext(room.state, room.roster), 211_556);
	assert.equal(sessionContext(newRoomState('x'), ['claude']), undefined);

	await room.say('go on', () => { }, new AbortController().signal);
	assert.equal(inputs.at(-1)?.model, 'claude-opus-5-5');
	room.state.choices = { 'claude@tenark': { model: 'sonnet' } };
	await room.say('and now', () => { }, new AbortController().signal);
	assert.equal(inputs.at(-1)?.model, 'sonnet');

	const link = room.state.adopted!['claude@tenark'];
	assert.equal(withMeta(link, undefined), link);
	assert.equal(withMeta(link, { model: link.model }), link);
	assert.equal(withMeta(link, { model: 'claude-sonnet-4-5' }).model, 'claude-sonnet-4-5');
});

test('the composer\'s model: the one chosen here, else the session\'s, said the way people say it', () => {
	assert.equal(sessionModelLabel('claude-opus-5-5'), 'Opus 5.5');
	assert.equal(sessionModelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
	assert.equal(sessionModelLabel('claude-opus-4-20250514'), 'Opus 4');
	assert.equal(sessionModelLabel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
	assert.equal(sessionModelLabel('claude-opus-4-6[1m]'), 'Opus 4.6 (1M)');
	assert.equal(sessionModelLabel('gpt-5-codex'), 'gpt-5-codex');
	const choices = { models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] };
	assert.equal(currentModelLabel(undefined, choices, 'claude-opus-5-5'), 'Opus 5.5');
	assert.equal(currentModelLabel({ effort: 'high' }, choices, 'claude-opus-5-5'), 'Opus 5.5 · high');
	assert.equal(currentModelLabel({ model: 'sonnet' }, choices, 'claude-opus-5-5'), 'Sonnet');
	assert.equal(currentModelLabel(undefined, choices, undefined), '');
});

test('a thread opened on this machine\'s copy moves to the server once, reads the session there and catches up; an older import reads again once', async () => {
	const registry = new AgentRegistry();
	const reads: string[] = [];
	const server: Agent = {
		id: 'claude@tenark', name: 'Claude · tenark', detail: 't', historyVersion: 2, readiness: async () => ({ ready: true }), turn: async () => { },
		sessionHistory: async id => {
			reads.push(`server:${id}`);
			return { entries: [{ role: 'user', text: 'go', id: 'u1' }, { role: 'agent', text: 'Going.', id: 'a1' }, { role: 'user', text: 'sent while it worked', id: 'q1' }, { role: 'agent', text: 'Done.', id: 'a2' }], cursor: '88238704', meta: { model: 'claude-opus-5-5', context: 211_556 } };
		},
	};
	const local: Agent = { ...server, id: 'claude', name: 'Claude', sessionHistory: async () => { reads.push('local'); return []; } };
	registry.register(local);
	registry.register(server);
	// Imported by an older build from the Mac's copy: the folder is the server's, the message sent mid-turn is missing.
	const state = importedRoomState({ id: 'claude', name: 'Claude' }, S('s1', '/home/tenark-claude/tenark-dev'), [{ role: 'user', text: 'go', id: 'u1' }, { role: 'agent', text: 'Going.', id: 'a1' }], 'file:///home/tenark-claude/tenark-dev');
	const home = async (agentId: string, s: { id: string; cwd?: string }) => homeOf(agentId, s, here, [{ agent: server, sessions: [S('s1', '/home/tenark-claude/tenark-dev')] }]);
	assert.ok(await healAdopted(state, registry, home));
	assert.deepEqual(reads, ['server:s1']);
	assert.deepEqual(state.roster, ['claude@tenark']);
	assert.deepEqual(state.adopted!['claude@tenark'], { session: 's1', cwd: '/home/tenark-claude/tenark-dev', upTo: state.messages[2].id, cursor: '88238704', version: 2, model: 'claude-opus-5-5', context: 211_556 });
	assert.deepEqual(state.messages.slice(1).map(m => [m.author.id, m.text]), [['user', 'go'], ['claude@tenark', 'Going.'], ['user', 'sent while it worked'], ['claude@tenark', 'Done.']]);
	assert.equal(state.project, undefined);
	// The next open: nothing to do.
	assert.ok(!await healAdopted(state, registry, home));
	assert.deepEqual(reads, ['server:s1']);

	// A thread of the server's own agent imported by reader 1: read again once; a failed read is tried on the next open.
	let fail = true;
	const flaky: Agent = { ...server, id: 'claude@prd', sessionHistory: async () => { if (fail) { throw new Error('unreachable'); } return { entries: [{ role: 'user', text: 'x', id: 'x1' }] }; } };
	registry.register(flaky);
	const old = importedRoomState({ id: 'claude@prd', name: 'Claude · prd' }, S('s2', '/srv'), []);
	const none = async () => undefined;
	assert.ok(!await healAdopted(old, registry, none));
	fail = false;
	assert.ok(await healAdopted(old, registry, none));
	assert.equal(old.adopted!['claude@prd'].version, 2);
	assert.deepEqual(old.messages.slice(1).map(m => m.text), ['x']);
	assert.ok(!await healAdopted(old, registry, none));
});

test('the follow hands the session\'s model and fill to the room; a thread moved to another agent follows there', async () => {
	const registry = new AgentRegistry();
	const watched: { agent: string; cursor?: string; emit: (e: SessionEntry[], c: string, m?: SessionMeta) => void; disposed: boolean }[] = [];
	const agent = (id: string): Agent => ({
		id, name: id, detail: 't', readiness: async () => ({ ready: true }), turn: async () => { },
		watchSession: (_s, onEntries, cursor) => {
			const w = { agent: id, ...(cursor !== undefined ? { cursor } : {}), emit: (e: SessionEntry[], c: string, m?: SessionMeta) => onEntries(e, c, m), disposed: false };
			watched.push(w);
			return { dispose: () => { w.disposed = true; } };
		},
	});
	registry.register(agent('claude'));
	registry.register(agent('claude@tenark'));
	const room = new Room(importedRoomState({ id: 'claude', name: 'claude' }, S('s1', '/home/t'), { entries: [], cursor: '50' }), registry);
	const follow = new SessionFollow(registry);
	follow.attach(room);
	assert.deepEqual(watched.map(w => [w.agent, w.cursor]), [['claude', '50']]);
	watched[0].emit([], '50', { model: 'claude-opus-5-5' });
	assert.equal(room.state.adopted?.claude.model, 'claude-opus-5-5');

	rehome(room.state, 'claude', { id: 'claude@tenark', name: 'Claude · tenark' });
	follow.refresh(room);
	assert.ok(watched[0].disposed);
	assert.deepEqual(watched.slice(1).map(w => [w.agent, w.cursor]), [['claude@tenark', undefined]]);
	watched[1].emit([{ role: 'user', text: 'from the server', id: 'u9' }], '70');
	assert.equal(room.messages.at(-1)?.text, 'from the server');
	follow.dispose();
});

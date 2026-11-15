/*---------------------------------------------------------------------------------------------
 *  Arkestra. What the agents' raw lines and failed turns bring into a thread: a thread read by an
 *  older reader gets its artifacts once, a CLI that is not installed says so in plain words (and
 *  where the session can go on), and the composer's label follows the session's model.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentRegistry, type Agent, type AgentEvent, type ExistingSession } from '../agent';
import { productOf, readableAgentError, splitError } from '../agentErrors';
import { Room, importedRoomState, newRoomState } from '../room';
import { continueOn, elsewhere, healAdopted, readAgain } from '../sessionHome';
import { rowHtml, type ThreadStrings } from '../threadHtml';
import { LabelCache, threadRows } from '../threadModel';

const S = (id: string, cwd?: string): ExistingSession => ({ id, title: id, ...(cwd ? { cwd } : {}), updatedAt: '2026-11-15T08:00:00Z' });
const STR: ThreadStrings = { local: 'this machine', attached: n => `+${n} attached`, tasksDone: n => `${n} finished`, tasks: n => `${n} tasks`, other: n => `${n} other`, working: 'working…', copy: 'Copy' };
const write = (id: string, file: string, content: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-15T09:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content } }] } });
const agentOf = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id.includes('@') ? `Claude · ${id.split('@')[1]}` : 'Claude', detail: 't', readiness: async () => ({ ready: true }), turn: async () => { }, ...extra });

const NOT_HERE = 'Claude Code is not installed on this computer. Install it or connect a machine that has it.';

test('an agent\'s error in plain words: a CLI not installed (or not allowed to run) here or on the SSH machine; the rest as it was', () => {
	assert.deepEqual(readableAgentError('spawn claude ENOENT', 'claude'), { text: NOT_HERE, missing: true });
	assert.deepEqual(readableAgentError('spawn /usr/local/bin/codex EACCES', 'codex'), { text: 'Codex could not be started on this computer: it is not allowed to run. Reinstall it or connect a machine that has it.', missing: true });
	assert.deepEqual(readableAgentError('sh: 1: claude: not found', 'claude@tenark-claude', 'tenark-claude'), { text: 'Claude Code is not installed on tenark-claude. Install it there or choose another machine.', missing: true });
	assert.deepEqual(readableAgentError('bash: codex: command not found', 'codex@tenark-codex'), { text: 'Codex is not installed on tenark-codex. Install it there or choose another machine.', missing: true });
	// The agents say it plainly now: kept, still known as a missing CLI.
	assert.deepEqual(readableAgentError(NOT_HERE, 'claude'), { text: NOT_HERE, missing: true });
	// An SSH agent's spawn error is ssh's own on this computer: not "Claude Code is missing".
	assert.deepEqual(readableAgentError('spawn ssh ENOENT', 'claude@tenark'), { text: 'spawn ssh ENOENT' });
	assert.deepEqual(readableAgentError('Invalid API key', 'claude'), { text: 'Invalid API key' });
	assert.equal(productOf('C:\\Tools\\claude.exe'), 'Claude Code');
	assert.equal(productOf('gemini'), undefined);
	assert.deepEqual(splitError('[error] spawn claude ENOENT'), { answer: '', error: 'spawn claude ENOENT' });
	assert.deepEqual(splitError('Half done.\n\n[error] quota'), { answer: 'Half done.', error: 'quota' });
	assert.deepEqual(splitError('I wrote [error] in the log'), { answer: 'I wrote [error] in the log' });
});

test('a failed turn stores and streams the plain message, not "spawn claude ENOENT"', async () => {
	const registry = new AgentRegistry();
	registry.register(agentOf('claude', { turn: async () => { throw new Error('spawn claude ENOENT'); } }));
	const room = new Room(newRoomState('t'), registry);
	room.state.roster.push('claude');
	const events: (AgentEvent | { kind: string })[] = [];
	await room.turnOf('claude', (_a, e) => events.push(e), new AbortController().signal);
	assert.equal(room.messages.at(-1)!.text, `[error] ${NOT_HERE}`);
	assert.deepEqual(events.filter(e => e.kind === 'error'), [{ kind: 'error', text: NOT_HERE }]);
});

test('the thread shows an error as an error row: an old raw text in plain words, what was written before it as the answer', () => {
	const at = '2026-11-15T09:00:00Z';
	const rows = threadRows([
		{ id: 'm1', at, author: { kind: 'agent', id: 'claude', name: 'Claude' }, text: '[error] spawn claude ENOENT' },
		{ id: 'm2', at, author: { kind: 'agent', id: 'codex@prd', name: 'Codex · prd' }, text: 'Started.\n\n[error] usage limit reached' },
	]);
	assert.deepEqual(rows, [
		{ type: 'error', id: 'm1:error', agentId: 'claude', name: 'Claude', text: NOT_HERE, missing: true },
		{ type: 'agent', id: 'm2', at, agentId: 'codex@prd', name: 'Codex · prd', text: 'Started.' },
		{ type: 'error', id: 'm2:error', agentId: 'codex@prd', name: 'Codex · prd', text: 'usage limit reached' },
	]);
});

test('an error row: the notice in the error tone; with the session on an SSH machine, where it runs and a button to go on there', () => {
	const plain = rowHtml({ type: 'error', id: 'e', agentId: 'claude', name: 'Claude', text: '<b>quota</b>' }, STR);
	assert.equal(plain, '<div class="notice error" role="alert"><div class="eh">Claude · this machine</div><div>&lt;b&gt;quota&lt;/b&gt;</div></div>');
	const missing = rowHtml({ type: 'error', id: 'e', agentId: 'claude', name: 'Claude', text: NOT_HERE, missing: true }, STR);
	assert.ok(missing.includes(`<div>${NOT_HERE}</div>`) && !missing.includes('data-continue'));
	const there = rowHtml({ type: 'error', id: 'e', agentId: 'claude', name: 'Claude', text: NOT_HERE, missing: true, home: { id: 'claude@tenark-claude', machine: 'tenark-claude' } }, STR);
	assert.ok(there.includes('<div>Claude Code is not installed on this computer. This session runs on tenark-claude: open it from there.</div>'), there);
	assert.ok(there.includes('<button class="chip" data-continue="claude" data-to="claude@tenark-claude">Continue on tenark-claude</button>'), there);
});

test('where a thread whose local CLI is missing can go on: the SSH agent of the same CLI that lists its session', () => {
	const candidates = [
		{ agent: { id: 'codex@tenark-codex' }, sessions: [S('s1')] },
		{ agent: { id: 'claude@tenark' }, sessions: [S('s2')] },
		{ agent: { id: 'claude@tenark-claude' }, sessions: [S('s1', '/home/tenark-claude/tenark-dev')] },
	];
	assert.equal(elsewhere('claude', 's1', candidates)?.id, 'claude@tenark-claude');
	assert.equal(elsewhere('claude', 's9', candidates), undefined);
	assert.equal(elsewhere('claude', undefined, candidates), undefined, 'a thread that continues no session');
	assert.equal(elsewhere('claude@tenark', 's1', candidates), undefined, 'already on a machine');
});

test('"Continue on tenark-claude": the thread moves to the SSH agent and reads the session there, its artifacts too', async () => {
	const server = agentOf('claude@tenark-claude', {
		historyVersion: 3,
		sessionHistory: async () => ({ entries: [{ role: 'user', text: 'go', id: 'u1' }, { role: 'agent', text: 'Wrote it.', id: 'a1' }], cursor: '900', meta: { model: 'claude-opus-5-5' }, lines: [write('t1', '/w/plan.md', '# Plan')] }),
	});
	const state = importedRoomState({ id: 'claude', name: 'Claude' }, S('s1', '/home/tenark-claude/tenark-dev'), [{ role: 'user', text: 'go', id: 'u1' }]);
	state.messages.push({ id: 'x', at: '2026-11-15T09:00:00Z', author: { kind: 'agent', id: 'claude', name: 'Claude' }, text: '[error] spawn claude ENOENT' });
	assert.ok(await continueOn(state, 'claude', server));
	assert.deepEqual(state.roster, ['claude@tenark-claude']);
	assert.deepEqual(state.adopted!['claude@tenark-claude'], { session: 's1', cwd: '/home/tenark-claude/tenark-dev', upTo: state.messages[1].id, cursor: '900', version: 3, model: 'claude-opus-5-5' });
	assert.deepEqual(state.produced?.map(p => [p.title, p.agentId, p.content]), [['plan.md', 'claude@tenark-claude', '# Plan']]);
	assert.ok(state.messages.some(m => m.text === 'Wrote it.'));
	assert.ok(!await continueOn(state, 'claude', server), 'nothing to move any more');
});

test('a thread read before the readers handed over tool lines reads its session once more and gets its artifacts, once', async () => {
	const registry = new AgentRegistry();
	let reads = 0;
	const lines = [write('t1', '/w/report.html', '<h1>R</h1>'), write('t2', '/w/main.ts', 'code')];
	registry.register(agentOf('claude@prd', { historyVersion: 3, sessionHistory: async () => { reads++; return { entries: [{ role: 'user', text: 'go', id: 'u1' }], cursor: '10', lines }; } }));
	// Imported by reader 2: no artifacts stored.
	const state = importedRoomState({ id: 'claude@prd', name: 'Claude · prd', historyVersion: 2 }, S('s2', '/srv'), [{ role: 'user', text: 'go', id: 'u1' }]);
	assert.equal(state.produced?.length ?? 0, 0, 'no artifacts stored');
	const none = async () => undefined;
	assert.ok(await healAdopted(state, registry, none));
	assert.deepEqual(state.produced?.map(p => p.title), ['report.html'], 'a page is kept, code is not an artifact');
	assert.equal(state.adopted!['claude@prd'].version, 3);
	assert.ok(!await healAdopted(state, registry, none), 'read once');
	assert.equal(reads, 1);
	// Read again by hand: the same tool use is not kept twice.
	assert.ok(await readAgain(state, 'claude@prd', registry.get('claude@prd')!));
	assert.equal(state.produced?.length, 1);
	// A Codex thread (no reader version before: 1) reads once when its agent says 2.
	const codex = importedRoomState({ id: 'codex@prd', name: 'Codex · prd' }, S('c1', '/srv'), []);
	registry.register({ ...agentOf('codex@prd'), name: 'Codex · prd', historyVersion: 2, sessionHistory: async () => ({ entries: [], lines: [JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: '*** Begin Patch\n*** Add File: docs/a.md\n+# A\n*** End Patch' } })] }) });
	assert.ok(await healAdopted(codex, registry, none));
	assert.deepEqual(codex.produced?.map(p => [p.title, p.content]), [['a.md', '# A']]);
});

test('the composer label is cached with the session\'s model: a session read again shows its model without a reload, no flicker meanwhile', async () => {
	const cache = new LabelCache();
	let model = 'claude-sonnet-4-5';
	let reads = 0;
	const read = async () => { reads++; return model === 'claude-opus-5-5' ? 'Opus 5.5' : 'Sonnet 4.5'; };
	let arrived = 0;
	const tick = () => new Promise(r => setTimeout(r, 0));
	assert.equal(cache.get('r', 'claude', undefined, { model }, read, () => arrived++), undefined, 'nothing known yet: the plain label');
	await tick();
	assert.equal(cache.get('r', 'claude', undefined, { model }, read, () => arrived++), 'Sonnet 4.5');
	assert.equal(reads, 1);
	// Healed: the session's model is known now.
	model = 'claude-opus-5-5';
	assert.equal(cache.get('r', 'claude', undefined, { model, context: 5000 }, read, () => arrived++), 'Sonnet 4.5', 'the last label stays while the new one is read');
	await tick();
	assert.equal(cache.get('r', 'claude', undefined, { model, context: 5000 }, read, () => arrived++), 'Opus 5.5');
	assert.equal(arrived, 2);
	// Another choice is its own label.
	assert.equal(cache.get('r', 'claude', { model: 'haiku' }, { model }, async () => 'Haiku', () => { }), undefined);
});

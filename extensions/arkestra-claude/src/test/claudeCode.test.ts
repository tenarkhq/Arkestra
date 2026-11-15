/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude Code adapter against a fake CLI that speaks stream-json.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAgent, permissionArgs, ROOM_PREAMBLE, parseLine, rateLimit, workOf } from '../claudeCode';
import type { AgentEvent, Message } from '../rooms';

const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.300 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: !process.env.FAKE_SIGNED_OUT })); process.exit(process.env.FAKE_SIGNED_OUT ? 1 : 0); }
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, key: process.env.ANTHROPIC_API_KEY ?? null }) + '\\n');
const prompt = args[args.indexOf('-p') + 1];
if (prompt.includes('FAIL')) {
  console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key', session_id: 's1' }));
  process.exit(1);
}
if (prompt.includes('HANG')) { setTimeout(() => {}, 60000); return; }
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }));
console.log(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [
  { type: 'tool_use', name: 'Edit', input: { file_path: 'src/advisor/state.py' } },
  { type: 'text', text: 'Done.' } ] } }));
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Done.', session_id: 's1' }));
`;

const msg = (kind: 'user' | 'agent' | 'system', id: string, text: string): Message =>
	({ id: Math.random().toString(36), at: new Date().toISOString(), author: { kind, id, name: id === 'user' ? 'You' : id.toUpperCase() }, text });

async function setup(apiKey?: string) {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-claude-'));
	const cli = path.join(dir, 'claude');
	await writeFile(cli, FAKE);
	await chmod(cli, 0o755);
	process.env.FAKE_LOG = path.join(dir, 'log');
	const agent = new ClaudeCodeAgent({ command: cli, permissionMode: 'acceptEdits', cwd: () => dir, apiKey: async () => apiKey });
	const calls = async () => (await readFile(process.env.FAKE_LOG!, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { args: string[]; key: string | null });
	return { agent, calls };
}

test('the first turn sends the preamble and the whole thread, the next resumes the session with only the new messages', async () => {
	const { agent, calls } = await setup();
	const events: AgentEvent[] = [];
	const t1 = [msg('user', 'user', 'fix the stop state'), msg('agent', 'codex', 'I edited state.py')];
	await agent.turn({ roomId: 'r', transcript: t1 }, e => events.push(e), new AbortController().signal);
	// The tool use's raw line goes first (what Claude produced, AR26); text-only lines are not handed on.
	const toolLine = JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/advisor/state.py' } }, { type: 'text', text: 'Done.' }] } });
	assert.deepEqual(events, [{ kind: 'line', line: toolLine }, { kind: 'tool', text: 'Edit src/advisor/state.py' }, { kind: 'text', text: 'Done.' }]);

	const t2 = [...t1, msg('agent', 'claude', 'Done.'), msg('user', 'user', 'now the test')];
	await agent.turn({ roomId: 'r', transcript: t2 }, () => { }, new AbortController().signal);

	const [first, second] = await calls();
	const p1 = first.args[first.args.indexOf('-p') + 1];
	assert.ok(p1.startsWith(ROOM_PREAMBLE) && p1.includes('fix the stop state') && p1.includes('[CODEX (agent)]'));
	assert.ok(!first.args.includes('--resume'));
	const p2 = second.args[second.args.indexOf('-p') + 1];
	assert.equal(p2, '[You]\nnow the test');
	assert.deepEqual(second.args.slice(second.args.indexOf('--resume'), second.args.indexOf('--resume') + 2), ['--resume', 's1']);
	const mode = (c: { args: string[] }) => c.args[c.args.indexOf('--permission-mode') + 1];
	assert.equal(mode(first), 'acceptEdits');

	await agent.turn({ roomId: 'r', transcript: [...t2, msg('user', 'user', 'plan it')], mode: 'plan' }, () => { }, new AbortController().signal);
	assert.equal(mode((await calls())[2]), 'plan', 'a Plan mode turn runs in Claude Code\'s own plan mode');
});

test('subscription leaves the API key out; a stored key is passed to the CLI', async () => {
	process.env.ANTHROPIC_API_KEY = 'from-shell';
	const sub = await setup(undefined);
	await sub.agent.turn({ roomId: 'r', transcript: [msg('user', 'user', 'hi')] }, () => { }, new AbortController().signal);
	assert.equal((await sub.calls())[0].key, null);
	const keyed = await setup('sk-ant-test');
	await keyed.agent.turn({ roomId: 'r', transcript: [msg('user', 'user', 'hi')] }, () => { }, new AbortController().signal);
	assert.equal((await keyed.calls())[0].key, 'sk-ant-test');
	delete process.env.ANTHROPIC_API_KEY;
});

test('a CLI error ends the turn with its message', async () => {
	const { agent } = await setup();
	await assert.rejects(agent.turn({ roomId: 'r', transcript: [msg('user', 'user', 'FAIL')] }, () => { }, new AbortController().signal), /Invalid API key/);
});

test('cancelling a turn stops the CLI', async () => {
	const { agent } = await setup();
	const abort = new AbortController();
	const turn = agent.turn({ roomId: 'r', transcript: [msg('user', 'user', 'HANG')] }, () => { }, abort.signal);
	setTimeout(() => abort.abort(), 200);
	await turn;
});

test('readiness: found CLI is ready, a missing one says install, a signed-out one says sign in unless a key is set', async () => {
	assert.deepEqual(await (await setup()).agent.readiness(), { ready: true });
	process.env.FAKE_SIGNED_OUT = '1';
	assert.deepEqual(await (await setup()).agent.readiness(), { ready: false, reason: 'Claude Code is not signed in', fix: 'signIn' });
	assert.deepEqual(await (await setup('sk-ant-test')).agent.readiness(), { ready: true });
	delete process.env.FAKE_SIGNED_OUT;
	const missing = new ClaudeCodeAgent({ command: '/nonexistent/claude', permissionMode: 'default', cwd: () => undefined, apiKey: async () => undefined });
	assert.deepEqual(await missing.readiness(), { ready: false, reason: 'Claude Code CLI not found', fix: 'install' });
});

test('stream-json lines map to text and tool events', () => {
	assert.deepEqual(parseLine('not json').events, []);
	assert.deepEqual(parseLine(JSON.stringify({ type: 'result', is_error: false, result: 'x', session_id: 'a' })), { events: [], sessionId: 'a', result: { isError: false, text: 'x' } });
});

test('permission lists go to Claude Code as its own flags, one argument per rule', () => {
	assert.deepEqual(permissionArgs(undefined), []);
	assert.deepEqual(permissionArgs({ allow: [], deny: [] }), []);
	assert.deepEqual(permissionArgs({ allow: ['Bash(npm test:*)', 'Bash(git log --format=%h,%s)', ' Read '], deny: ['Bash(rm:*)'] }),
		['--allowedTools', 'Bash(npm test:*)', 'Bash(git log --format=%h,%s)', 'Read', '--disallowedTools', 'Bash(rm:*)']);
	assert.deepEqual(permissionArgs({ allow: ['*'], deny: [] }).slice(0, 3), ['--allowedTools', 'Bash', 'Edit']);
});

test('the shared rules go to a session once per version: again only when they change', async () => {
	const { agent, calls } = await setup();
	const t1 = [msg('user', 'user', 'first')];
	await agent.turn({ roomId: 'r', transcript: t1, shared: { text: 'KÖZÖS v1', version: 'v1' } }, () => { }, new AbortController().signal);
	const t2 = [...t1, msg('user', 'user', 'second')];
	await agent.turn({ roomId: 'r', transcript: t2, shared: { text: 'KÖZÖS v1', version: 'v1' } }, () => { }, new AbortController().signal);
	const t3 = [...t2, msg('user', 'user', 'third')];
	await agent.turn({ roomId: 'r', transcript: t3, shared: { text: 'KÖZÖS v2', version: 'v2' } }, () => { }, new AbortController().signal);
	const prompts = (await calls()).map(c => c.args[c.args.indexOf('-p') + 1]);
	assert.ok(prompts[0].startsWith(ROOM_PREAMBLE) && prompts[0].includes('KÖZÖS v1\n\n[You]\nfirst'));
	assert.equal(prompts[1], '[You]\nsecond');
	assert.equal(prompts[2], 'KÖZÖS v2\n\n[You]\nthird');
});

test('usage: the result\'s totals and cost, the context fill of the last model call, rate limit windows', () => {
	const assistant = parseLine(JSON.stringify({ type: 'assistant', message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500, output_tokens: 300 } } }));
	assert.equal(assistant.contextUsed, 40_810);
	const result = parseLine(JSON.stringify({ type: 'result', is_error: false, result: 'ok', total_cost_usd: 0.42, usage: { input_tokens: 100, cache_creation_input_tokens: 900, cache_read_input_tokens: 80_000, output_tokens: 1200 }, modelUsage: { 'claude-x': { contextWindow: 200_000 } } }));
	assert.deepEqual(result.usage, { input: 1000, output: 1200, cached: 80_000, costUsd: 0.42, context: { used: 0, window: 200_000 } });
	const limit = parseLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.83, resetsAt: 1795000000 } }));
	assert.deepEqual(limit.events, [{ kind: 'usage', usage: { limits: [{ label: 'week', usedPercent: 83, resetsAt: new Date(1795000000 * 1000).toISOString() } ] } }]);
	assert.equal(rateLimit({ status: 'allowed' }), undefined, 'no utilization, no ring');
});

test('work beside the answer: task list, sub-agents, background commands, polls, chapters', () => {
	const tool = (name: string, input: unknown, id = 'tu1', parent: string | null = null) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } });
	const work = (line: string) => parseLine(line).events.filter(e => e.kind === 'work').map(e => (e as Extract<AgentEvent, { kind: 'work' }>).work);
	assert.deepEqual(work(tool('TodoWrite', { todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }, { content: 'Write', status: 'in_progress', activeForm: 'Writing the tests' }, { content: 'Ship', status: 'pending' }] })),
		[{ type: 'todos', items: [{ text: 'Read', status: 'completed' }, { text: 'Writing the tests', status: 'in_progress' }, { text: 'Ship', status: 'pending' }] }]);
	assert.deepEqual(work(tool('Task', { subagent_type: 'Explore', description: 'Find the board', prompt: '…' }, 't9')), [{ type: 'subagent', id: 't9', name: 'Explore', task: 'Find the board', status: 'running' }]);
	assert.deepEqual(work(tool('Bash', { command: 'npm run watch', run_in_background: true }, 'b1')), [{ type: 'background', id: 'b1', command: 'npm run watch', status: 'running' }]);
	assert.deepEqual(work(tool('Bash', { command: 'ls' })), []);
	assert.deepEqual(work(tool('BashOutput', { bash_id: 'shell_7' }, 'p1')), [{ type: 'poll', id: 'p1', target: 'shell_7' }]);
	assert.deepEqual(work(tool('KillShell', { shell_id: 'shell_7' }, 'k1')), [{ type: 'poll', id: 'k1', target: 'shell_7', kill: true }]);
	assert.deepEqual(workOf({ name: 'mcp__ccd_session__mark_chapter', input: { title: 'Tests', summary: 'all green' } }), { type: 'chapter', title: 'Tests', summary: 'all green' });
	// A sub-agent's own task list is not the agent's.
	assert.deepEqual(work(tool('TodoWrite', { todos: [{ content: 'x', status: 'pending' }] }, 'tu2', 't9')), []);
	const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', is_error: false, content: [{ type: 'text', text: 'found it' }] }] } });
	assert.deepEqual(work(result), [{ type: 'finished', id: 't9', ok: true, text: 'found it' }]);
});

test('the thread\'s model and effort go to the CLI; without a choice the setting\'s model, no effort', async () => {
	const { agent, calls } = await setup();
	await agent.turn({ roomId: 'm', transcript: [msg('user', 'user', 'hi')], model: 'opus', effort: 'max' }, () => { }, new AbortController().signal);
	await agent.turn({ roomId: 'm2', transcript: [msg('user', 'user', 'hi')] }, () => { }, new AbortController().signal);
	const [chosen, plain] = await calls();
	const after = (c: { args: string[] }, flag: string) => c.args.includes(flag) ? c.args[c.args.indexOf(flag) + 1] : undefined;
	assert.deepEqual([after(chosen, '--model'), after(chosen, '--effort')], ['opus', 'max']);
	assert.deepEqual([after(plain, '--model'), after(plain, '--effort')], [undefined, undefined]);
	const models = (await agent.choices()).models.map(m => m.id);
	assert.deepEqual(models, ['opus', 'sonnet', 'fable', 'haiku']);
});

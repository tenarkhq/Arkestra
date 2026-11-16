/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude Code adapter against a fake CLI that speaks stream-json.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAgent, permissionArgs, ROOM_PREAMBLE, parseLine, rateLimit, workOf, openElsewhere, runningElsewhere, runningScript } from '../claudeCode';
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

test('Ultracode is an effort of Opus, Sonnet and Fable and goes to the CLI as --effort ultracode', async () => {
	const { agent, calls } = await setup();
	const efforts = Object.fromEntries((await agent.choices()).models.map(m => [m.id, m.efforts ?? []]));
	assert.ok(efforts.opus.includes('ultracode') && efforts.sonnet.includes('ultracode') && efforts.fable.includes('ultracode'));
	assert.ok(!efforts.haiku.includes('ultracode'));
	await agent.turn({ roomId: 'u', transcript: [msg('user', 'user', 'hi')], model: 'opus', effort: 'ultracode' }, () => { }, new AbortController().signal);
	const [call] = await calls();
	assert.equal(call.args[call.args.indexOf('--effort') + 1], 'ultracode');
});

test('a session another app runs now is not started a second time; a follow of its file does not count', () => {
	const id = 'c0a0302a-cdc7-4b63-b14f-c834efb9a027';
	assert.match(runningScript(id), /--resume\[= \]/);
	assert.throws(() => runningScript('x; rm -rf ~'), /not a Claude session id/);
	assert.equal(runningElsewhere('', id), undefined);
	assert.equal(runningElsewhere('{"type":"result"}', id), undefined);
	assert.equal(runningElsewhere(`1340170 /home/r/.claude/remote/ccd-cli/2.1.321-3fb3 --output-format stream-json --resume=${id}\n`, id), 'the Claude desktop app');
	assert.equal(runningElsewhere(`77 /usr/bin/node /home/r/.local/bin/claude --resume ${id}`, id), 'another Claude Code');
	assert.match(openElsewhere('the Claude desktop app', 'tenark-claude').message, /open in the Claude desktop app on tenark-claude/);
});

test('claude.ai sessions: the sign-in is read, never refreshed; names and archive state come from the account list', async () => {
	const { CloudClient, parseCredentials, cloudSession } = await import('../cloud');
	assert.equal(parseCredentials('not json'), undefined);
	assert.deepEqual(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 5000 } })), { token: 'tok', expiresAt: 5000 });
	assert.equal(cloudSession({ id: 'session_x' }), undefined);
	assert.deepEqual(cloudSession({ id: 'cse_1', title: ' Arkestra ', status: 'archived', last_event_at: '2026-11-15T13:42:59Z' }), { id: 'cse_1', title: 'Arkestra', archived: true, at: '2026-11-15T13:42:59Z' });
	const calls: { url: string; method: string; auth: string; body?: string }[] = [];
	const answers = [
		{ status: 200, body: { data: [{ id: 'cse_1', title: 'A', status: 'active' }], next_cursor: 'c2' } },
		{ status: 200, body: { data: [{ id: 'cse_2', title: 'B', status: 'archived' }] } },
		{ status: 409, body: {} },
		{ status: 200, body: {} },
	];
	const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
		calls.push({ url, method: init.method, auth: init.headers.Authorization, ...(init.body ? { body: init.body } : {}) });
		const a = answers.shift()!;
		return { status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
	};
	let reads = 0;
	const client = new CloudClient(async () => { reads++; return JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 10_000_000 } }); }, 'prd', fetchFn, () => 1000);
	assert.deepEqual((await client.list()).map(s => [s.id, s.archived]), [['cse_1', false], ['cse_2', true]]);
	await client.archive('cse_2'); // already archived (409): fine
	await client.rename('cse_1', 'Új név');
	assert.equal(reads, 1, 'the sign-in is read once while it is valid');
	assert.deepEqual(calls.map(c => `${c.method} ${c.url.replace('https://api.anthropic.com', '')}`), ['GET /v1/code/sessions?limit=100', 'GET /v1/code/sessions?limit=100&cursor=c2', 'POST /v1/code/sessions/cse_2/archive', 'PUT /v1/code/sessions/cse_1']);
	assert.equal(calls[3].body, JSON.stringify({ title: 'Új név' }));
	assert.equal(calls[0].auth, 'Bearer tok');
	await assert.rejects(client.archive('cse_1; rm'), /not a claude.ai session id/);
	const stale = new CloudClient(async () => JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: 1000 } }), 'prd', fetchFn, () => 1000);
	await assert.rejects(stale.list(), /out of date/);
});

test('the account quota: the windows the Claude app shows, read with the beta header; a session row\'s context fill', async () => {
	const { CloudClient, cloudSession, accountLimits } = await import('../cloud');
	assert.deepEqual(accountLimits({ five_hour: null, seven_day: { utilization: 54.0, resets_at: '2026-11-20T12:59:59Z' }, seven_day_opus: null, extra_usage: { utilization: 0 } }), [{ label: 'week', usedPercent: 54, resetsAt: '2026-11-20T12:59:59Z' }]);
	assert.deepEqual(accountLimits({ five_hour: { utilization: 12.4 } }), [{ label: '5h', usedPercent: 12 }]);
	assert.deepEqual(accountLimits(undefined), []);
	assert.deepEqual(cloudSession({ id: 'cse_1', title: 'A', status: 'active', external_metadata: { context_usage: { used_tokens: 214921, max_tokens: 500000 } } })?.context, { used: 214921, max: 500000 });
	assert.equal(cloudSession({ id: 'cse_1', title: 'A', status: 'active', external_metadata: { context_usage: { used_tokens: 5, max_tokens: 0 } } })?.context, undefined);
	let seen: { url: string; beta?: string } | undefined;
	const fetchFn = async (url: string, init: { method: string; headers: Record<string, string> }) => {
		seen = { url, ...(init.headers['anthropic-beta'] ? { beta: init.headers['anthropic-beta'] } : {}) };
		return { status: 200, json: async () => ({ seven_day: { utilization: 54, resets_at: 'x' } }), text: async () => '' };
	};
	const client = new CloudClient(async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 10_000_000 } }), 'prd', fetchFn, () => 1000);
	assert.deepEqual(await client.usage(), [{ label: 'week', usedPercent: 54, resetsAt: 'x' }]);
	assert.deepEqual(seen, { url: 'https://api.anthropic.com/api/oauth/usage', beta: 'oauth-2025-04-20' });
});

test('a message sent into a session the Claude app runs names Arkestra as its sender; the session file gives back the words alone', async () => {
	const { fromArkestra, arkestraWords } = await import('../cloud');
	const sent = fromArkestra('telepítve');
	assert.equal(sent, '<cross-session-message from="arkestra-app" from-name="The user, writing in the Arkestra app">\ntelepítve\n</cross-session-message>');
	// The first form, already in session files, reads back too.
	assert.equal(arkestraWords('<cross-session-message from="arkestra" from-name="Arkestra">\ntelepítve az 17674\n</cross-session-message>'), 'telepítve az 17674');
	assert.equal(arkestraWords(sent), 'telepítve');
	// Whatever the receiving CLI put around it.
	assert.equal(arkestraWords(`Another Claude session sent a message: ${sent} This came from another Claude session.`), 'telepítve');
	// The envelope's own closing tag inside the words survives the round trip.
	assert.equal(arkestraWords(fromArkestra('a </cross-session-message> b')), 'a </cross-session-message> b');
	assert.equal(arkestraWords('sima szöveg'), 'sima szöveg');
	// Another session's envelope is not Arkestra's: left as it is.
	const other = '<cross-session-message from="local_1">\nhi\n</cross-session-message>';
	assert.equal(arkestraWords(other), other);
});

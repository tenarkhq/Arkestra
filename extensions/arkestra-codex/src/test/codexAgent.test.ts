/*---------------------------------------------------------------------------------------------
 *  Arkestra. Codex adapter against a fake `codex app-server` that speaks line JSON-RPC.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { appendFile, chmod, copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodexAgent, ROOM_PREAMBLE, codexHistory, codexSessions, codexLimits, codexModels, codexPlan, codexUsage, codexWork, describeItem, modelOverride, type CodexAuth } from '../codexAgent';
import type { AgentEvent, Message } from '../rooms';

const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); }
const log = m => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\\n');
log({ spawn: args, home: process.env.CODEX_HOME ?? null, key: process.env.OPENAI_API_KEY ?? null });
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
let account = process.env.FAKE_SIGNED_OUT ? null : { type: 'chatgpt', planType: 'pro' };
let n = 0;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) { handle(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
});
const waiting = new Map();
function handle(m) {
  log(m);
  if (m.method === undefined) { const cb = waiting.get(m.id); waiting.delete(m.id); return cb && cb(m); }
  const reply = result => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ userAgent: 'fake' });
    case 'account/read': return reply({ account, requiresOpenaiAuth: true });
    case 'account/login/start': account = { type: 'apiKey' }; return reply({ type: 'apiKey' });
    case 'thread/start': return reply({ thread: { id: 'th1' } });
    case 'thread/resume':
      if (m.params.threadId === 'gone') return out({ id: m.id, error: { code: -32600, message: 'no rollout found' } });
      return reply({ thread: { id: m.params.threadId } });
    case 'thread/read': return reply({ thread: { id: m.params.threadId, path: process.env.FAKE_ROLLOUT || null } });
    case 'turn/interrupt':
      reply({});
      return out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'tu' + n, status: 'interrupted', error: null } } });
    case 'turn/start': {
      const text = m.params.input[0].text;
      const turnId = 'tu' + (++n);
      reply({ turn: { id: turnId, status: 'inProgress' } });
      if (text.includes('HANG')) return;
      const ask = /ASK (.+)$/.exec(text);
      if (ask) {
        const id = 900 + n;
        waiting.set(id, resp => {
          out({ method: 'item/completed', params: { threadId: 'th1', turnId, item: { type: 'agentMessage', text: 'decision=' + (resp.result ? resp.result.decision : resp.error.message) } } });
          out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: turnId, status: 'completed', error: null } } });
        });
        return out({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'th1', turnId, itemId: 'i1', command: ask[1], startedAtMs: 0 } });
      }
      if (text.endsWith('DIE')) return process.exit(3);
      if (text.includes('FAIL')) {
        out({ method: 'error', params: { threadId: 'th1', turnId, willRetry: false, error: { message: 'usage limit reached' } } });
        return out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: turnId, status: 'failed', error: { message: 'usage limit reached' } } } });
      }
      out({ method: 'item/started', params: { threadId: 'other', item: { type: 'commandExecution', command: 'ls' } } });
      out({ method: 'item/started', params: { threadId: 'th1', turnId, item: { type: 'fileChange', changes: [{ path: 'src/advisor/state.py', kind: 'update' }] } } });
      out({ method: 'item/completed', params: { threadId: 'th1', turnId, item: { type: 'agentMessage', text: 'Done.' } } });
      return out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: turnId, status: 'completed', error: null } } });
    }
    default:
      if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: 'unknown' } });
  }
}
`;

const msg = (kind: 'user' | 'agent' | 'system', id: string, text: string): Message =>
	({ id: Math.random().toString(36), at: new Date().toISOString(), author: { kind, id, name: id === 'user' ? 'You' : id.toUpperCase() }, text });

const never = () => new AbortController().signal;

async function setup(auth: CodexAuth = { mode: 'subscription' }, remote = false) {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-codex-'));
	const cli = path.join(dir, 'codex');
	await writeFile(cli, FAKE);
	await chmod(cli, 0o755);
	process.env.FAKE_LOG = path.join(dir, 'log');
	// `remote`: through a spawn, as on an SSH machine (here the spawn runs on this machine).
	const agent = new CodexAgent({ command: cli, sandbox: 'workspace-write', cwd: () => dir, auth: async () => auth, apiKeyHome: path.join(dir, 'key-home'), ...(remote ? { spawn: nodeSpawn } : {}) });
	const log = async () => (await readFile(process.env.FAKE_LOG!, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
	const requests = async (method: string) => (await log()).filter(m => m.method === method);
	return { agent, dir, log, requests };
}

test('the first turn starts a thread with the room preamble and the whole thread, the next sends only the new messages', async () => {
	const { agent, dir, requests } = await setup();
	const events: AgentEvent[] = [];
	const t1 = [msg('user', 'user', 'fix the stop state'), msg('agent', 'claude', 'I looked at state.py')];
	await agent.turn({ roomId: 'r', transcript: t1 }, e => events.push(e), never());
	assert.deepEqual(events, [{ kind: 'tool', text: 'Edit src/advisor/state.py' }, { kind: 'text', text: 'Done.' }]);

	const t2 = [...t1, msg('agent', 'codex', 'Done.'), msg('user', 'user', 'now the test')];
	await agent.turn({ roomId: 'r', transcript: t2 }, () => { }, never());

	const [start] = await requests('thread/start');
	assert.equal(start.params.developerInstructions, ROOM_PREAMBLE);
	assert.equal(start.params.cwd, dir);
	assert.equal(start.params.sandbox, 'workspace-write');
	assert.equal(start.params.approvalPolicy, 'never');
	const [first, second] = await requests('turn/start');
	assert.ok(first.params.input[0].text.includes('fix the stop state') && first.params.input[0].text.includes('[CLAUDE (agent)]'));
	assert.equal(second.params.threadId, 'th1');
	assert.equal(second.params.input[0].text, '[You]\nnow the test');
	assert.equal((await requests('thread/start')).length, 1);
	assert.deepEqual(first.params.sandboxPolicy, { type: 'workspaceWrite' }, 'every turn sets the sandbox');

	await agent.turn({ roomId: 'r', transcript: [...t2, msg('user', 'user', 'plan the next step')], mode: 'plan' }, () => { }, never());
	await agent.turn({ roomId: 'r', transcript: [...t2, msg('user', 'user', 'plan the next step'), msg('user', 'user', 'go')] }, () => { }, never());
	const [, , plan, after] = await requests('turn/start');
	assert.deepEqual(plan.params.sandboxPolicy, { type: 'readOnly' }, 'a Plan mode turn is read-only');
	assert.deepEqual(after.params.sandboxPolicy, { type: 'workspaceWrite' }, 'and the next turn writes again');
	agent.dispose();
});

test('subscription uses the CLI login; an API key signs in under a separate CODEX_HOME', async () => {
	process.env.OPENAI_API_KEY = 'from-shell';
	const sub = await setup();
	await sub.agent.turn({ roomId: 'r', transcript: [msg('user', 'user', 'hi')] }, () => { }, never());
	const [subSpawn] = (await sub.log()).filter(m => m.spawn);
	assert.deepEqual(subSpawn, { spawn: ['app-server'], home: null, key: null });
	assert.equal((await sub.requests('account/login/start')).length, 0);
	sub.agent.dispose();

	const keyed = await setup({ mode: 'apiKey', key: 'sk-test' });
	await keyed.agent.turn({ roomId: 'r', transcript: [msg('user', 'user', 'hi')] }, () => { }, never());
	const [keySpawn] = (await keyed.log()).filter(m => m.spawn);
	assert.equal(keySpawn.home, path.join(keyed.dir, 'key-home'));
	assert.deepEqual((await keyed.requests('account/login/start')).map(m => m.params), [{ type: 'apiKey', apiKey: 'sk-test' }]);
	keyed.agent.dispose();
	delete process.env.OPENAI_API_KEY;
});

test('a failed turn ends with its error message', async () => {
	const { agent } = await setup();
	await assert.rejects(agent.turn({ roomId: 'r', transcript: [msg('user', 'user', 'FAIL')] }, () => { }, never()), /usage limit reached/);
	agent.dispose();
});

test('cancelling a turn interrupts it', async () => {
	const { agent, requests } = await setup();
	const abort = new AbortController();
	const turn = agent.turn({ roomId: 'r', transcript: [msg('user', 'user', 'HANG')] }, () => { }, abort.signal);
	setTimeout(() => abort.abort(), 300);
	await turn;
	assert.deepEqual((await requests('turn/interrupt')).map(m => m.params), [{ threadId: 'th1', turnId: 'tu1' }]);
	agent.dispose();
});

test('a server that dies mid-turn ends the turn; the next turn restarts it and resumes the room thread', async () => {
	const { agent, log, requests } = await setup();
	// The room keeps its messages (and their ids) from turn to turn.
	const t: Message[] = [msg('user', 'user', 'hello')];
	await agent.turn({ roomId: 'r', transcript: [...t] }, () => { }, never());
	t.push(msg('agent', 'codex', 'Done.'), msg('user', 'user', 'DIE'));
	await assert.rejects(agent.turn({ roomId: 'r', transcript: [...t] }, () => { }, never()), /exited with 3/);
	// The room keeps the failed request and records the error as Codex's reply.
	t.push(msg('agent', 'codex', '[error] codex app-server exited with 3'), msg('user', 'user', 'again'));
	await agent.turn({ roomId: 'r', transcript: [...t] }, () => { }, never());
	assert.equal((await log()).filter(m => m.spawn).length, 2);
	assert.deepEqual((await requests('thread/resume')).map(m => m.params.threadId), ['th1']);
	assert.equal((await requests('turn/start')).at(-1).params.input[0].text, '[You]\nDIE\n\n[You]\nagain');
	agent.dispose();
});

test('readiness: ready when signed in, sign-in when not, install when the CLI is missing', async () => {
	const ok = await setup();
	assert.deepEqual(await ok.agent.readiness(), { ready: true });
	ok.agent.dispose();

	process.env.FAKE_SIGNED_OUT = '1';
	const out = await setup();
	assert.deepEqual(await out.agent.readiness(), { ready: false, reason: 'Codex is not signed in', fix: 'signIn' });
	out.agent.dispose();
	delete process.env.FAKE_SIGNED_OUT;

	const noKey = await setup({ mode: 'apiKey', key: undefined });
	assert.deepEqual(await noKey.agent.readiness(), { ready: false, reason: 'No Codex API key stored', fix: 'signIn' });

	const missing = new CodexAgent({ command: '/nonexistent/codex', sandbox: 'read-only', cwd: () => undefined, auth: async () => ({ mode: 'subscription' }), apiKeyHome: '/nonexistent' });
	assert.deepEqual(await missing.readiness(), { ready: false, reason: 'Codex CLI not found', fix: 'install' });
});

test('thread items map to tool lines', () => {
	assert.equal(describeItem({ type: 'commandExecution', command: 'pytest -q' }), 'Run pytest -q');
	assert.equal(describeItem({ type: 'commandExecution', command: '/bin/bash -lc pwd' }), 'Run pwd');
	assert.equal(describeItem({ type: 'commandExecution', command: "/bin/bash -lc 'rg -n stop src'" }), 'Run rg -n stop src');
	assert.equal(describeItem({ type: 'mcpToolCall', server: 'github', tool: 'get_issue' }), 'github.get_issue');
	assert.equal(describeItem({ type: 'webSearch', query: 'codex app-server' }), 'Search codex app-server');
	assert.equal(describeItem({ type: 'reasoning' }), undefined);
});

test('permission lists: with rules Codex runs "untrusted" and the lists answer its approvals; without rules it never asks', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-codex-'));
	const cli = path.join(dir, 'codex');
	await writeFile(cli, FAKE);
	await chmod(cli, 0o755);
	process.env.FAKE_LOG = path.join(dir, 'log');
	let rules = true;
	const asked: string[] = [];
	const agent = new CodexAgent({
		command: cli, sandbox: 'workspace-write', cwd: () => dir, auth: async () => ({ mode: 'subscription' }), apiKeyHome: path.join(dir, 'key-home'),
		permissions: {
			active: () => rules,
			ask: async request => { asked.push(`${request.tool}:${request.command}`); return request.command?.startsWith('npm test') ? 'allow' : 'deny'; },
		},
	});
	const answers: string[] = [];
	const t1 = [msg('user', 'user', 'ASK npm test --watch')];
	await agent.turn({ roomId: 'r', transcript: t1 }, e => { if (e.kind === 'text') { answers.push(e.text); } }, never());
	const t2 = [...t1, msg('user', 'user', 'ASK rm -rf build')];
	await agent.turn({ roomId: 'r', transcript: t2 }, e => { if (e.kind === 'text') { answers.push(e.text); } }, never());
	rules = false;
	await agent.turn({ roomId: 'r', transcript: [...t2, msg('user', 'user', 'plain')] }, () => { }, never());
	assert.deepEqual(answers, ['decision=accept', 'decision=decline']);
	assert.deepEqual(asked, ['Bash:npm test --watch', 'Bash:rm -rf build']);
	const turns = (await readFile(process.env.FAKE_LOG!, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(m => m.method === 'turn/start');
	assert.deepEqual(turns.map(t => t.params.approvalPolicy), ['untrusted', 'untrusted', 'never']);
	agent.dispose();
});

test('usage: token reports add only what is new; the context is the last call; quota windows get labels', () => {
	const first = codexUsage({ total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50, totalTokens: 1050 }, last: { totalTokens: 1050 }, modelContextWindow: 272_000 }, undefined);
	assert.deepEqual(first, { input: 400, cached: 600, output: 50, context: { used: 1050, window: 272_000 } });
	const next = codexUsage({ total: { inputTokens: 1500, cachedInputTokens: 900, outputTokens: 80, totalTokens: 1580 }, last: { totalTokens: 1580 } }, { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50, totalTokens: 1050 });
	assert.deepEqual(next, { input: 200, cached: 300, output: 30, context: { used: 1580 } });
	assert.deepEqual(codexLimits({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1795000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null } }), [
		{ label: '5h', usedPercent: 12, resetsAt: new Date(1795000000 * 1000).toISOString() },
		{ label: 'week', usedPercent: 40 },
	]);
	assert.deepEqual(codexLimits(null), []);
});

test('work beside the answer: the plan as a task list, sub-agents from collab calls and activity', () => {
	assert.deepEqual(codexPlan([{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }, { step: 'Ship', status: 'pending' }, { nope: 1 }]),
		{ type: 'todos', items: [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'in_progress' }, { text: 'Ship', status: 'pending' }] });
	assert.deepEqual(codexWork({ type: 'collabAgentToolCall', tool: 'spawnAgent', model: 'gpt-5.5', prompt: 'Check the tests\nmore', receiverThreadIds: ['th2'], agentsStates: { th2: { status: 'pendingInit' } } }, false),
		[{ type: 'subagent', id: 'th2', name: 'gpt-5.5', task: 'Check the tests', status: 'running' }]);
	assert.deepEqual(codexWork({ type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['th2'], agentsStates: { th2: { status: 'completed', message: 'all pass' } } }, true),
		[{ type: 'finished', id: 'th2', ok: true, text: 'all pass' }]);
	assert.deepEqual(codexWork({ type: 'subAgentActivity', agentThreadId: 'th3', agentPath: 'reviewer', kind: 'started' }, false), [{ type: 'subagent', id: 'th3', name: 'reviewer', status: 'running' }]);
	assert.deepEqual(codexWork({ type: 'subAgentActivity', agentThreadId: 'th3', kind: 'interrupted' }, true), [{ type: 'finished', id: 'th3', ok: false }]);
	assert.deepEqual(codexWork({ type: 'commandExecution' }, false), []);
});

test('models from model/list, and the override a turn sends: chosen, kept, or taken back to the defaults', () => {
	const models = codexModels({ data: [
		{ id: 'm1', model: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }] },
		{ id: 'm2', model: 'gpt-5.5-mini', displayName: 'Mini', supportedReasoningEfforts: [] },
		{ id: 'm3', model: 'secret', hidden: true },
	] });
	assert.deepEqual(models.map(m => [m.id, m.label, m.efforts ?? null]), [['gpt-5.5', 'GPT-5.5', ['low', 'high']], ['gpt-5.5-mini', 'Mini', null]]);
	assert.deepEqual(modelOverride({ model: 'gpt-5.5-mini' }, undefined, models), { model: 'gpt-5.5-mini' });
	assert.deepEqual(modelOverride({ effort: 'high' }, undefined, models), { effort: 'high' });
	// Taken back: Codex would keep the old override, so the defaults go once.
	assert.deepEqual(modelOverride({}, { model: 'gpt-5.5-mini', effort: 'low' }, models), { model: 'gpt-5.5', effort: 'medium' });
	assert.deepEqual(modelOverride({}, undefined, models), {});
});

test('existing threads (AR39): the list as sessions, newest first, rooms\' own threads left out; a thread\'s turns as messages', () => {
	const list = { data: [
		{ id: 't1', preview: 'refactor the advisor\nand test', cwd: '/home/r/x', updatedAt: 1700000100 },
		{ id: 't2', preview: '[You]\nhello from a room', updatedAt: 1700000300 },
		{ id: 't3', preview: '', createdAt: '2026-11-14T10:00:00Z' },
		{ nope: true },
	] };
	assert.deepEqual(codexSessions(list), [
		{ id: 't3', title: 't3', updatedAt: '2026-11-14T10:00:00.000Z' },
		{ id: 't1', title: 'refactor the advisor', cwd: '/home/r/x', updatedAt: new Date(1700000100 * 1000).toISOString() },
	]);
	assert.deepEqual(codexSessions(undefined), []);
	const thread = { turns: [
		{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'refactor' }, { type: 'image', url: 'x' }] }, { type: 'reasoning', text: 'hm' }, { type: 'agentMessage', text: 'Plan:' }, { type: 'commandExecution', command: 'ls' }, { type: 'agentMessage', text: 'Done.' }] },
		{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'tests?' }] }, { type: 'agentMessage', text: 'Added.' }] },
	] };
	assert.deepEqual(codexHistory(thread), [
		{ role: 'user', text: 'refactor' }, { role: 'agent', text: 'Plan:\n\nDone.' }, { role: 'user', text: 'tests?' }, { role: 'agent', text: 'Added.' },
	]);
	// With the items' ids, an answer keeps the id of its first item.
	const withIds = { turns: [{ items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'go' }] }, { type: 'agentMessage', id: 'm1', text: 'One.' }, { type: 'agentMessage', id: 'm2', text: 'Two.' }] }] };
	assert.deepEqual(codexHistory(withIds), [{ role: 'user', text: 'go', id: 'u1' }, { role: 'agent', text: 'One.\n\nTwo.', id: 'm1' }]);
});

test('an adopted thread goes on as that thread in its folder; when it cannot be resumed the turn fails, no new thread', async () => {
	const { agent, requests } = await setup();
	const old = [msg('user', 'user', 'refactor'), msg('agent', 'codex', 'Done.')];
	agent.adoptSession('r', { id: 'th1', cwd: '/srv/tenark' }, old.map(m => m.id));
	const live = msg('user', 'user', 'typed in the terminal');
	agent.adoptSession('r', { id: 'th1' }, [...old, live].map(m => m.id)); // what came in live counts as seen
	await agent.turn({ roomId: 'r', transcript: [...old, live, msg('user', 'user', 'now the tests')] }, () => { }, never());
	const [resume] = await requests('thread/resume');
	assert.deepEqual([resume.params.threadId, resume.params.cwd], ['th1', '/srv/tenark']);
	assert.equal((await requests('thread/start')).length, 0);
	assert.equal((await requests('turn/start'))[0].params.input[0].text, '[You]\nnow the tests');

	agent.adoptSession('q', { id: 'gone' }, []);
	await assert.rejects(agent.turn({ roomId: 'q', transcript: [msg('user', 'user', 'hi')] }, () => { }, never()), /Could not resume the Codex session gone/);
	assert.equal((await requests('thread/start')).length, 0);
	agent.dispose();
});

test('following a thread here: the rollout file its server names, appended items as entries, Arkestra\'s own turn left out', async () => {
	const { agent, dir } = await setup();
	const file = path.join(dir, 'rollout-2026-11-14T10-00-00-th1.jsonl');
	await writeFile(file, '');
	process.env.FAKE_ROLLOUT = file;
	const item = (type: string, id: string, text: string) => JSON.stringify({ timestamp: '2026-11-14T10:00:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type, id, content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }] } } });
	const got: { id?: string; text: string }[] = [];
	let calls = 0;
	const until = async (check: () => boolean) => {
		const end = Date.now() + 5000;
		while (!check()) {
			if (Date.now() > end) {
				throw new Error('timed out');
			}
			await new Promise(r => setTimeout(r, 20));
		}
	};
	const follow = agent.watchSession('th1', entries => { calls++; got.push(...entries); });
	try {
		await until(() => calls === 1);
		await writeFile(file, [item('UserMessage', 'u1', '[You]\nfrom Arkestra'), item('AgentMessage', 'm1', 'Sure.'), item('UserMessage', 'u2', 'from the terminal'), item('AgentMessage', 'm2', 'Plan:'), item('AgentMessage', 'm3', 'Done.')].join('\n') + '\n');
		await until(() => got.some(e => e.text === 'Plan:\n\nDone.'));
		assert.deepEqual([...new Set(got.map(e => e.id))], ['u2', 'm2']);
	} finally {
		follow.dispose();
		delete process.env.FAKE_ROLLOUT;
		agent.dispose();
	}
	assert.throws(() => agent.watchSession('x; rm -rf ~', () => { }), /not a Codex thread id/);
});

const FIXTURE = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'rollout-2026-11-14T10-00-00-01a1e000-0000-7000-8000-00000000c0de.jsonl');

test('a paginated thread\'s history (Codex 0.163: thread/read gives no turns) comes from its rollout file, here and over SSH', async () => {
	for (const remote of [false, true]) {
		const { agent, dir } = await setup({ mode: 'subscription' }, remote);
		const file = path.join(dir, path.basename(FIXTURE));
		await copyFile(FIXTURE, file);
		process.env.FAKE_ROLLOUT = file;
		try {
			const history = await agent.sessionHistory('01a1e000-0000-7000-8000-00000000c0de');
			assert.deepEqual(history.entries.map(e => [e.role, e.text]), [
				['user', 'Add a health check endpoint.'],
				['agent', 'I will look at the server first.\n\nAdded GET /health to src/server.ts.'],
				['user', 'Thanks. A test for it too.'],
				['agent', 'Added test/health.test.ts; it passes.'],
			], remote ? 'over SSH' : 'here');
			assert.equal(history.cursor, `${(await readFile(file)).length}m`);
		} finally {
			delete process.env.FAKE_ROLLOUT;
			agent.dispose();
		}
	}
});

test('history without a rollout file: the server\'s thread/read, as before', async () => {
	const { agent } = await setup();
	try {
		assert.deepEqual(await agent.sessionHistory('01a1e000-0000-7000-8000-0000000000ff'), { entries: [] });
	} finally {
		agent.dispose();
	}
	await assert.rejects(agent.sessionHistory('x; rm -rf ~'), /not a Codex thread id/);
});

test('import then follow: what the thread wrote between the history read and the follow comes in, once', async () => {
	const { agent, dir } = await setup();
	const file = path.join(dir, path.basename(FIXTURE));
	await copyFile(FIXTURE, file);
	process.env.FAKE_ROLLOUT = file;
	const item = (type: string, id: string, text: string) => JSON.stringify({ timestamp: '2026-11-14T11:00:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type, id, content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }] } } });
	try {
		const history = await agent.sessionHistory('01a1e000-0000-7000-8000-00000000c0de');
		await appendFile(file, [item('UserMessage', 'u9', 'written in the terminal meanwhile'), item('AgentMessage', 'm9', 'Seen.')].join('\n') + '\n');
		const got: { id?: string; text: string }[] = [];
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timed out')), 5000);
			const follow = agent.watchSession('01a1e000-0000-7000-8000-00000000c0de', entries => {
				got.push(...entries);
				clearTimeout(timer);
				follow.dispose();
				resolve();
			}, history.cursor);
		});
		assert.deepEqual(got.map(e => [e.id, e.text]), [['u9', 'written in the terminal meanwhile'], ['m9', 'Seen.']]);
	} finally {
		delete process.env.FAKE_ROLLOUT;
		agent.dispose();
	}
});

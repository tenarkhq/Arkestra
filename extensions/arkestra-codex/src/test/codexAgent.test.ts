/*---------------------------------------------------------------------------------------------
 *  Arkestra. Codex adapter against a fake `codex app-server` that speaks line JSON-RPC.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodexAgent, ROOM_PREAMBLE, codexLimits, codexUsage, describeItem, type CodexAuth } from '../codexAgent';
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
    case 'thread/resume': return reply({ thread: { id: m.params.threadId } });
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

async function setup(auth: CodexAuth = { mode: 'subscription' }) {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-codex-'));
	const cli = path.join(dir, 'codex');
	await writeFile(cli, FAKE);
	await chmod(cli, 0o755);
	process.env.FAKE_LOG = path.join(dir, 'log');
	const agent = new CodexAgent({ command: cli, sandbox: 'workspace-write', cwd: () => dir, auth: async () => auth, apiKeyHome: path.join(dir, 'key-home') });
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

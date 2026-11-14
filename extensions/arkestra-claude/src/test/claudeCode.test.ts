/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude Code adapter against a fake CLI that speaks stream-json.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAgent, ROOM_PREAMBLE, parseLine } from '../claudeCode';
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
	assert.deepEqual(events, [{ kind: 'tool', text: 'Edit src/advisor/state.py' }, { kind: 'text', text: 'Done.' }]);

	const t2 = [...t1, msg('agent', 'claude', 'Done.'), msg('user', 'user', 'now the test')];
	await agent.turn({ roomId: 'r', transcript: t2 }, () => { }, new AbortController().signal);

	const [first, second] = await calls();
	const p1 = first.args[first.args.indexOf('-p') + 1];
	assert.ok(p1.startsWith(ROOM_PREAMBLE) && p1.includes('fix the stop state') && p1.includes('[CODEX (agent)]'));
	assert.ok(!first.args.includes('--resume'));
	const p2 = second.args[second.args.indexOf('-p') + 1];
	assert.equal(p2, '[You]\nnow the test');
	assert.deepEqual(second.args.slice(second.args.indexOf('--resume'), second.args.indexOf('--resume') + 2), ['--resume', 's1']);
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

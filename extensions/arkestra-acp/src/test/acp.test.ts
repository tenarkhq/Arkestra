/*---------------------------------------------------------------------------------------------
 *  Arkestra. The ACP adapter against a fake ACP agent: sessions per room, only new messages,
 *  files, terminals, permission, cancel, sign-in and reloading a session after a restart.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AcpAgent, acpPlan, describeToolCall, formatMessages, type AcpOptions } from '../acpAgent';
import { readAgents, registryId, splitCommandLine } from '../config';
import { Terminals, keepTail, remoteFiles, sliceLines } from '../host';
import { spawn } from 'node:child_process';
import { readRegistry } from '../registry';
import type { AgentEvent, Message } from '../rooms';

const FAKE = path.join(__dirname, 'fakeAgent.js');
const msg = (n: number, kind: 'user' | 'agent' | 'system', id: string, text: string): Message =>
	({ id: `m${n}`, at: '2026-11-14T15:00:00Z', author: { kind, id, name: id === 'me' ? 'Roland' : id }, text });

async function setup(env: Record<string, string> = {}, askPermission: AcpOptions['askPermission'] = async () => 'yes', extra: Partial<AcpOptions> = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-acp-'));
	const file = path.join(dir, 'notes.txt');
	await writeFile(file, 'one\ntwo\nthree');
	const logFile = path.join(dir, 'log.txt');
	await writeFile(logFile, '');
	const agent = new AcpAgent({
		id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE], where: 'local',
		env: { FAKE_LOG: logFile, FAKE_FILE: file, ...env },
		cwd: async () => dir,
		askPermission,
		...extra,
	});
	const log = async () => (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean);
	return { agent, dir, file, log };
}

/** The turn's text and tool events; its work events (waiting, task list) go to `work`. */
const work: AgentEvent[] = [];
async function turn(agent: AcpAgent, roomId: string, transcript: Message[], signal = new AbortController().signal, mode?: 'plan') {
	const events: AgentEvent[] = [];
	work.length = 0;
	await agent.turn({ roomId, transcript, ...(mode ? { mode } : {}) }, e => (e.kind === 'work' ? work : events).push(e), signal);
	return events;
}

test('a turn: chunks become whole messages, files, terminal and permission work, tools show', async () => {
	const asked: string[] = [];
	const { agent, file, log } = await setup({}, async (name, title, options) => { asked.push(`${name}: ${title} [${options.map(o => o.kind).join(',')}]`); return 'yes'; });
	try {
		const events = await turn(agent, 'r1', [msg(1, 'user', 'me', 'plan it'), msg(2, 'agent', 'claude', 'three steps')]);
		assert.deepEqual(events, [
			{ kind: 'text', text: 'Hello' },
			{ kind: 'tool', text: 'Run echo' },
			{ kind: 'tool', text: 'Run echo · failed' },
			{ kind: 'text', text: 'file=two exit=0 out:v1 permission=yes' },
		]);
		assert.deepEqual(asked, ['Fake: Edit state.py [reject_once,allow_once]']);
		// While the question is open the agent waits for the user; after the answer it does not.
		assert.deepEqual(work, [{ kind: 'work', work: { type: 'waiting', reason: 'asks: Edit state.py' } }, { kind: 'work', work: { type: 'waiting' } }]);
		assert.equal(await readFile(`${file}.out/new.txt`, 'utf8'), 'written');
		const lines = await log();
		assert.match(lines[0], /^new \//);
		assert.ok(lines[1].includes('You are Fake in an Arkestra room') && lines[1].includes('[Roland]\\nplan it') && lines[1].includes('[claude (agent)]\\nthree steps'), lines[1]);
	} finally {
		agent.dispose();
	}
});

test('the next turn sends only what is new, in the same session; another room gets its own', async () => {
	const { agent, log } = await setup();
	try {
		const t1 = [msg(1, 'user', 'me', 'first')];
		await turn(agent, 'r1', t1);
		const t2 = [...t1, msg(2, 'agent', 'fake', 'answer'), msg(3, 'user', 'me', 'second')];
		await turn(agent, 'r1', t2);
		await turn(agent, 'r2', [msg(1, 'user', 'me', 'other room')]);
		const prompts = (await log()).filter(l => l.startsWith('prompt'));
		assert.equal(prompts.length, 3);
		const session = (l: string) => l.split(':')[0];
		assert.equal(session(prompts[0]), session(prompts[1]));
		assert.notEqual(session(prompts[0]), session(prompts[2]));
		assert.ok(prompts[1].endsWith(': "[Roland]\\nsecond"'), prompts[1]);
	} finally {
		agent.dispose();
	}
});

test('cancel stops the turn without an error; a dismissed permission is declined', async () => {
	const { agent } = await setup({}, async () => undefined);
	try {
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 200);
		assert.deepEqual(await turn(agent, 'r1', [msg(1, 'user', 'me', 'WAIT')], abort.signal), []);
		const events = await turn(agent, 'r1', [msg(1, 'user', 'me', 'WAIT'), msg(2, 'user', 'me', 'go')]);
		const last = events.at(-1);
		assert.equal(last?.kind === 'text' ? last.text : undefined, 'file=two exit=0 out:v1 permission=cancelled');
	} finally {
		agent.dispose();
	}
});

test('an agent that wants sign-in: readiness says so with its own methods, authenticate fixes it', async () => {
	const { agent } = await setup({ FAKE_AUTH: '1' });
	try {
		assert.deepEqual(await agent.readiness(), { ready: true });
		await assert.rejects(turn(agent, 'r1', [msg(1, 'user', 'me', 'hi')]), /Fake is not signed in/);
		assert.deepEqual(await agent.readiness(), { ready: false, reason: 'Fake is not signed in', fix: 'signIn' });
		assert.deepEqual(agent.signInMethods.map(m => m.id), ['key'], 'terminal sign-in is not offered: Arkestra does not advertise it');
		await agent.authenticate('key');
		assert.deepEqual(await agent.readiness(), { ready: true });
		assert.equal((await turn(agent, 'r1', [msg(1, 'user', 'me', 'hi')])).length, 4);
	} finally {
		agent.dispose();
	}
});

test('after a restart the room session is loaded again, not started over', async () => {
	const { agent, log } = await setup();
	try {
		await turn(agent, 'r1', [msg(1, 'user', 'me', 'first')]);
		agent.dispose(); // the process ends; the room keeps its session id
		await turn(agent, 'r1', [msg(1, 'user', 'me', 'first'), msg(2, 'agent', 'fake', 'a'), msg(3, 'user', 'me', 'again')]);
		const lines = await log();
		assert.equal(lines.filter(l => l.startsWith('new')).length, 1);
		assert.equal(lines.filter(l => l.startsWith('load')).length, 1);
		assert.ok(lines.at(-1)!.endsWith(': "[Roland]\\nagain"'));
	} finally {
		agent.dispose();
	}
});

test('a missing command is reported as not installed', async () => {
	const agent = new AcpAgent({ id: 'x', name: 'X', command: 'arkestra-no-such-acp-agent', args: [], where: 'local', cwd: async () => tmpdir(), askPermission: async () => undefined });
	assert.deepEqual(await agent.readiness(), { ready: false, reason: 'arkestra-no-such-acp-agent not found', fix: 'install' });
});

test('settings, command lines, registry entries, line slices and output tails', () => {
	assert.deepEqual(readAgents([{ id: 'gemini', command: ' npx ', args: ['-y', 1, '@google/gemini-cli'], env: { GEMINI_API_KEY: 'k', 'bad name': 'x', N: 1 } }, { id: 'gemini', command: 'x' }, { id: 'gemini', command: 'gemini', machine: 'dev' }, { id: 'bad id', command: 'x' }, { id: 'y' }, null]), [
		{ id: 'gemini', name: 'gemini', command: 'npx', args: ['-y', '@google/gemini-cli'], env: { GEMINI_API_KEY: 'k' }, machine: 'local' },
		{ id: 'gemini', name: 'gemini', command: 'gemini', args: [], env: {}, machine: 'dev' },
	]);
	assert.equal(registryId(readAgents([{ id: 'goose', command: 'goose', machine: 'dev' }])[0]), 'goose@dev');
	assert.deepEqual(splitCommandLine(` npx -y "@scope/my agent" --flag='a b' "" `), ['npx', '-y', '@scope/my agent', '--flag=a b', '']);
	assert.deepEqual(readRegistry({ agents: [
		{ id: 'gemini', name: 'Gemini CLI', distribution: { npx: { package: '@google/gemini-cli@0.68.0', args: ['--acp'] } } },
		{ id: 'goose', name: 'goose', website: 'https://goose', distribution: { binary: { 'linux-x86_64': { cmd: './goose', args: ['acp'] } } } },
		{ id: 'mac-only', name: 'Mac', distribution: { binary: { 'darwin-aarch64': { cmd: './m' } } } },
		{ id: 'bad id', name: 'x', distribution: { npx: { package: 'x' } } },
	] }, 'linux', 'x64'), [
		{ id: 'gemini', name: 'Gemini CLI', command: 'npx', args: ['-y', '@google/gemini-cli@0.68.0', '--acp'], needsInstall: false },
		{ id: 'goose', name: 'goose', website: 'https://goose', command: 'goose', args: ['acp'], needsInstall: true },
	]);
	assert.equal(sliceLines('a\nb\nc\nd', 2, 2), 'b\nc');
	assert.equal(sliceLines('a\nb', null, null), 'a\nb');
	assert.deepEqual(keepTail('aéz', 3), { text: 'éz', truncated: true });
	assert.deepEqual(keepTail('aéz', 2), { text: 'z', truncated: true }, 'never half a character');
	assert.deepEqual(keepTail('abc', 10), { text: 'abc', truncated: false });
	assert.equal(describeToolCall({ title: '', kind: 'read' }), 'read');
	assert.equal(formatMessages([msg(1, 'system', 'room', 'gpt joined'), msg(2, 'agent', 'fake', 'mine')], 'fake'), '[room] gpt joined');
});

test('on an SSH machine: files through commands there, terminals change folder and set env themselves', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-acp-remote-'));
	// A remote spawn takes neither cwd nor env, like remoteSpawn; this one runs here the same way.
	const remoteLike: typeof spawn = ((command: string, args: string[], options: any) => spawn(command, args, { stdio: options.stdio })) as any;
	const files = remoteFiles(remoteLike);
	await files.write(path.join(dir, 'a b', 'c.txt'), 'remote\ntext');
	assert.equal(await files.read(path.join(dir, 'a b', 'c.txt')), 'remote\ntext');
	await assert.rejects(files.read(path.join(dir, 'missing')), (e: any) => e.code === -32002);
	const terminals = new Terminals(remoteLike, true);
	const { terminalId } = terminals.create({ command: 'sh', args: ['-c', 'echo "$(pwd) $X"'], env: [{ name: 'X', value: 'it\'s' }, { name: 'bad name', value: 'y' }], cwd: dir });
	assert.deepEqual(await terminals.waitForExit(terminalId), { exitCode: 0, signal: null });
	assert.equal(terminals.output(terminalId).output.trim(), `${dir} it's`);
	terminals.release(terminalId);
	assert.throws(() => terminals.output(terminalId), /No terminal/);
});

test('by id, not by count: a message written during the turn comes next time; another agent\'s instruction never', async () => {
	const { agent, log } = await setup();
	try {
		const m1 = msg(1, 'user', 'me', 'start');
		await turn(agent, 'r1', [m1]);
		// While Fake worked, Codex wrote; Fake's answer came after it.
		const during = msg(2, 'agent', 'codex', 'meanwhile');
		const own = msg(3, 'agent', 'fake', 'answer');
		const forCodex: Message = { ...msg(4, 'system', 'room', 'only for codex'), to: ['codex'] };
		const forMe: Message = { ...msg(5, 'system', 'room', 'only for fake'), to: ['fake'] };
		await turn(agent, 'r1', [m1, during, own, forCodex, forMe]);
		const last = (await log()).filter(l => l.startsWith('prompt')).at(-1)!;
		assert.ok(last.endsWith(': "[codex (agent)]\\nmeanwhile\\n\\n[room] only for fake"'), last);
	} finally {
		agent.dispose();
	}
});

test('Plan mode: the agent\'s own plan mode for the turn, then back; writes, terminals and permissions are refused', async () => {
	const asked: string[] = [];
	const { agent, file, log } = await setup({ FAKE_MODES: '1' }, async (_n, title) => { asked.push(title); return 'yes'; });
	try {
		const events = await turn(agent, 'r1', [msg(1, 'user', 'me', 'PLAN it')], undefined, 'plan');
		assert.deepEqual(events, [{ kind: 'text', text: 'write=refused term=refused permission=no' }]);
		assert.deepEqual(asked, [], 'the user is not asked in Plan mode: the change is declined');
		await assert.rejects(readFile(`${file}.plan`, 'utf8'));
		assert.deepEqual((await log()).filter(l => l.startsWith('mode')), ['mode plan', 'mode default']);
		const normal = await turn(agent, 'r1', [msg(1, 'user', 'me', 'PLAN it'), msg(2, 'user', 'me', 'PLAN again, normal turn')]);
		assert.deepEqual(normal, [{ kind: 'text', text: 'write=ok term=ok permission=yes' }], 'after Plan mode changes work again');
		assert.deepEqual((await log()).filter(l => l.startsWith('mode')), ['mode plan', 'mode default'], 'a normal turn does not switch modes');
	} finally {
		agent.dispose();
	}
});

test('permission lists: the question carries the tool call; a denied write or command is refused even unasked', async () => {
	const calls: unknown[] = [];
	const refused: string[] = [];
	const { agent, file } = await setup({}, async (_n, _t, _o, _s, toolCall) => { calls.push(toolCall); return 'no'; }, {
		refuses: request => {
			const deny = request.tool === 'Edit' && !!request.path?.endsWith('new.txt');
			if (deny) {
				refused.push(request.title);
			}
			return deny;
		},
	});
	try {
		const events = await turn(agent, 'r1', [msg(1, 'user', 'me', 'go')]);
		assert.equal(events.at(-1)?.kind === 'text' && events.at(-1)!.kind, 'text');
		assert.match((events.at(-1) as { text: string }).text, /permission=no$/);
		assert.deepEqual(calls, [{ toolCallId: 't2', title: 'Edit state.py' }]);
		assert.equal(refused.length, 1);
		await assert.rejects(readFile(`${file}.out/new.txt`, 'utf8'), 'the denied write did not happen');
	} finally {
		agent.dispose();
	}
});

test('an ACP plan update is the agent\'s task list', () => {
	assert.deepEqual(acpPlan([{ content: 'Read', status: 'completed', priority: 'high' }, { content: 'Write', status: 'in_progress' }, { content: 'Ship' }, 7]),
		{ type: 'todos', items: [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'in_progress' }, { text: 'Ship', status: 'pending' }] });
});

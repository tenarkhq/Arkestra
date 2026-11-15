/*---------------------------------------------------------------------------------------------
 *  Arkestra. The raw tool lines handed to the rooms for what Claude produced (AR26): from the
 *  history read, the live follow and a turn's stream; and a CLI that cannot start, in plain words.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type SpawnOptions } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAgent, startProblem } from '../claudeCode';
import { followLocal } from '../follow';
import type { AgentEvent, Message } from '../rooms';
import { ClaudeHistory, claudeMeta, claudePiece, claudeToolLine, localHistory } from '../sessions';

const SESSION = '00000002-aaaa-bbbb-cccc-dddddddddddd';
const user = (uuid: string, content: unknown) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content } });
const said = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const write = (id: string, file: string, content: string) => JSON.stringify({ type: 'assistant', uuid: `w-${id}`, timestamp: '2026-11-15T09:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content } }] } });
const publish = (id: string, file: string) => JSON.stringify({ type: 'assistant', uuid: `p-${id}`, message: { content: [{ type: 'tool_use', id, name: 'Artifact', input: { file_path: file } }] } });
const result = (id: string, text: string) => JSON.stringify({ type: 'user', uuid: `r-${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const msg = (text: string): Message => ({ id: Math.random().toString(36), at: new Date().toISOString(), author: { kind: 'user', id: 'user', name: 'You' }, text });

/** A session: a message, a page written and published, a long read whose result names no artifact, an answer. */
const LINES = [
	user('u1', 'make the page'),
	write('t1', '/w/report.html', '<h1>Report</h1>'),
	result('t1', 'File created'),
	publish('t2', '/w/report.html'),
	result('t2', 'Published: https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-000000000001'),
	JSON.stringify({ type: 'assistant', uuid: 'rd', message: { content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/w/big.log' } }] } }),
	result('t3', 'x'.repeat(5000)),
	said('a1', 'Done: the page is published.'),
];

test('a tool line is one that can hold what Claude produced: tool uses, and a result that names a claude.ai artifact', () => {
	assert.deepEqual(LINES.map(claudeToolLine), [false, true, false, true, true, true, false, false]);
});

test('the history hands over the tool lines it read, the same here and over SSH, and lets go of them', async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'arkestra-lines-'));
	const dir = path.join(home, '.claude', 'projects', '-w');
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `${SESSION}.jsonl`), LINES.join('\n') + '\n');
	const here = await localHistory(home, SESSION);
	assert.deepEqual(here.entries.map(e => e.text), ['make the page', 'Done: the page is published.']);
	assert.deepEqual(here.lines, [LINES[1], LINES[3], LINES[4], LINES[5]]);

	const fakeSpawn = (command: string, args: string[], options: SpawnOptions) => spawn(command, args, { ...options, env: { ...process.env, HOME: home } });
	const remote = new ClaudeCodeAgent({ command: 'claude', permissionMode: 'acceptEdits', cwd: () => undefined, apiKey: async () => undefined, spawn: fakeSpawn, identity: { id: 'claude@prd', name: 'Claude · prd', where: 'prd' } });
	assert.deepEqual(await remote.sessionHistory(SESSION), here);

	const history = new ClaudeHistory();
	history.push(Buffer.from(LINES.join('\n') + '\n'));
	assert.equal(history.result().lines?.length, 4);
	assert.equal(history.result().lines, undefined, 'handed over once: the reader keeps no copy');
	// A history with no tool use says nothing about lines.
	const plain = new ClaudeHistory();
	plain.push(Buffer.from(`${user('u1', 'hi')}\n${said('a1', 'Hello.')}\n`));
	assert.ok(!('lines' in plain.result()));
});

test('the live follow hands over the tool lines behind each batch, a batch of tool lines alone too', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-follow-lines-'));
	const file = path.join(dir, 's.jsonl');
	await writeFile(file, '');
	const calls: { entries: number; lines?: readonly string[] }[] = [];
	const follow = followLocal(async () => file, { classify: claudePiece, meta: claudeMeta, keep: claudeToolLine, onEntries: (entries, _cursor, _meta, lines) => { calls.push({ entries: entries.length, ...(lines ? { lines } : {}) }); }, pollMs: 30, cursorDelayMs: 30 });
	const until = async (check: () => boolean) => {
		const end = Date.now() + 5000;
		while (!check()) {
			if (Date.now() > end) {
				throw new Error('timed out');
			}
			await new Promise(r => setTimeout(r, 20));
		}
	};
	try {
		await until(() => calls.length === 1);
		assert.equal(calls[0].lines, undefined, 'nothing read yet');
		// Only tool lines: no entry, still handed over.
		await appendFile(file, `${LINES[1]}\n${LINES[2]}\n`);
		await until(() => calls.some(c => c.lines));
		assert.deepEqual(calls.find(c => c.lines), { entries: 0, lines: [LINES[1]] });
		await appendFile(file, `${LINES[3]}\n${LINES[4]}\n${LINES[7]}\n`);
		await until(() => calls.filter(c => c.lines).length === 2);
		assert.deepEqual(calls.filter(c => c.lines)[1], { entries: 1, lines: [LINES[3], LINES[4]] });
	} finally {
		follow.dispose();
	}
});

test('a CLI that cannot start says so in plain words: not installed here, on an SSH machine, or not allowed to run', () => {
	assert.equal(startProblem('Claude Code', { code: 'ENOENT' })?.message, 'Claude Code is not installed on this computer. Install it or connect a machine that has it.');
	assert.equal(startProblem('Claude Code', { code: 'EACCES' })?.message, 'Claude Code could not be started on this computer: it is not allowed to run. Reinstall it or connect a machine that has it.');
	assert.equal(startProblem('Claude Code', { exitCode: 127 }, 'tenark-claude')?.message, 'Claude Code is not installed on tenark-claude. Install it there or choose another machine.');
	assert.equal(startProblem('Claude Code', { exitCode: 126 }, 'tenark-claude')?.message, 'Claude Code could not be started on tenark-claude: it is not allowed to run. Reinstall it there or choose another machine.');
	// ssh itself missing on this computer is not "Claude Code is not installed there"; other failures stay as they are.
	assert.equal(startProblem('Claude Code', { code: 'ENOENT' }, 'tenark-claude'), undefined);
	assert.equal(startProblem('Claude Code', { exitCode: 1 }), undefined);
});

test('a turn on a computer without Claude Code ends with the plain message, not "spawn claude ENOENT"', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-missing-'));
	const agent = new ClaudeCodeAgent({ command: path.join(dir, 'claude'), permissionMode: 'acceptEdits', cwd: () => dir, apiKey: async () => undefined });
	await assert.rejects(agent.turn({ roomId: 'r', transcript: [msg('hi')] }, () => { }, new AbortController().signal), (e: Error) => e.message === 'Claude Code is not installed on this computer. Install it or connect a machine that has it.');

	// On an SSH machine without it the remote shell answers 127.
	const missing = (_c: string, _a: string[], options: SpawnOptions) => spawn('sh', ['-c', 'echo "sh: 1: claude: not found" >&2; exit 127'], options);
	const remote = new ClaudeCodeAgent({ command: 'claude', permissionMode: 'acceptEdits', cwd: () => undefined, apiKey: async () => undefined, spawn: missing, identity: { id: 'claude@tenark-claude', name: 'Claude · tenark-claude', where: 'tenark-claude' } });
	const events: AgentEvent[] = [];
	await assert.rejects(remote.turn({ roomId: 'r', transcript: [msg('hi')] }, e => events.push(e), new AbortController().signal), /Claude Code is not installed on tenark-claude\. Install it there or choose another machine\./);
	assert.deepEqual(events, []);
});

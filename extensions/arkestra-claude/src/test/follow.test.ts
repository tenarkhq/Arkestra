/*---------------------------------------------------------------------------------------------
 *  Arkestra. Following a Claude Code session live (AR39): the incremental reader, the entries,
 *  the followers here and over a shell.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EntryAssembler, LineSplitter, followLocal, followRemote, parseCursor, tailScript, type LiveEntry, type Piece } from '../follow';
import { ROOM_PREAMBLE } from '../claudeCode';
import { claudePiece, locateScript, parseHistory } from '../sessions';

const user = (uuid: string, content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-11-14T10:00:00Z', message: { role: 'user', content }, ...extra });
const said = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
const tool = (uuid: string) => JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) {
			throw new Error('timed out');
		}
		await new Promise(r => setTimeout(r, 20));
	}
}

test('line splitter: whole lines only, a partial last line waits, a character cut between chunks stays whole', () => {
	const s = new LineSplitter(100);
	assert.deepEqual(s.push(Buffer.from('ab\ncd')), [{ text: 'ab', start: 100 }]);
	assert.equal(s.position, 103);
	assert.equal(s.read, 105);
	const e = Buffer.from('é\n');
	assert.deepEqual(s.push(e.subarray(0, 1)), []);
	assert.deepEqual(s.push(e.subarray(1)), [{ text: 'cdé', start: 103 }]);
	assert.equal(s.position, 108);
	assert.deepEqual(s.push(Buffer.from('\n\nx\n')).map(l => l.text), ['', '', 'x']);
});

test('entries: one per user message, an answer grows under its first id, a task report ends it', () => {
	const a = new EntryAssembler({ mute: true });
	const p = (kind: 'user' | 'agent' | 'notice', text: string, id: string): Piece => ({ kind, text, id });
	assert.deepEqual(a.feed(p('user', 'fix it', 'u1'), 0), { role: 'user', text: 'fix it', id: 'u1' });
	assert.deepEqual(a.feed(p('agent', 'Looking.', 'a1'), 10), { role: 'agent', text: 'Looking.', id: 'a1' });
	assert.equal(a.cursor(50), '10');
	assert.equal(a.feed(undefined, 20), undefined);
	assert.deepEqual(a.feed(p('agent', 'Fixed.', 'a2'), 30), { role: 'agent', text: 'Looking.\n\nFixed.', id: 'a1' });
	assert.deepEqual(a.feed(p('notice', 'tests passed', 'n1'), 40), { role: 'system', text: 'tests passed', id: 'n1' });
	assert.equal(a.cursor(50), '50');
	assert.deepEqual(a.feed(p('agent', 'Done.', 'a3'), 60), { role: 'agent', text: 'Done.', id: 'a3' });
});

test('entries: a message Arkestra sent and the answer to it are left out until the user writes again', () => {
	const a = new EntryAssembler({ mute: true, positional: true });
	for (const text of [`${ROOM_PREAMBLE}\n\n[You]\nhi`, '[You]\nnow deploy', '[room] Plan mode', 'Közös szabályok és memória (Arkestra; minden agent ugyanezt kapja):\n\n[You]\nx', '[Codex · prd (agent)]\nDone.\n\n[You]\nok']) {
		assert.equal(a.feed({ kind: 'user', text }, 0), undefined, text);
		assert.equal(a.feed({ kind: 'agent', text: 'Deployed.' }, 5), undefined);
		assert.equal(a.cursor(9), '9m');
	}
	assert.deepEqual(a.feed({ kind: 'user', text: '[WIP] check the logs' }, 20), { role: 'user', text: '[WIP] check the logs', id: '@20' });
	assert.equal(a.cursor(40), '40');
	assert.deepEqual(new EntryAssembler({ mute: true }, true).feed({ kind: 'agent', text: 'x', id: 'a' }, 0), undefined);
	assert.deepEqual(new EntryAssembler().feed({ kind: 'user', text: '[You]\nhi', id: 'u' }, 0), { role: 'user', text: '[You]\nhi', id: 'u' });
	assert.deepEqual(parseCursor('120m'), { offset: 120, muted: true });
	assert.deepEqual(parseCursor('7'), { offset: 7, muted: false });
	assert.equal(parseCursor('x'), undefined);
	assert.equal(parseCursor(undefined), undefined);
});

test('claude lines: ids from the line uuid; task reports as short lines; compact summaries and tool results left out', () => {
	assert.deepEqual(claudePiece(user('u1', 'fix the stop')), { kind: 'user', text: 'fix the stop', id: 'u1', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(claudePiece(user('u2', '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>')),
		{ kind: 'notice', text: 'Background command "npm test" completed (exit code 0)', id: 'u2', at: '2026-11-14T10:00:00Z' });
	assert.equal(claudePiece(user('u3', 'This session is being continued…', { isCompactSummary: true })), undefined);
	assert.equal(claudePiece(user('u4', [{ type: 'tool_result', content: 'ok' }])), undefined);
	assert.equal(claudePiece(tool('a0')), undefined);
	assert.deepEqual(parseHistory([user('u1', 'go'), said('a1', 'One.'), tool('a2'), said('a3', 'Two.'), user('u5', 'next')].join('\n')).map(e => [e.id, e.text]), [['u1', 'go'], ['a1', 'One.\n\nTwo.'], ['u5', 'next']]);
	assert.equal(locateScript('00000001-aaaa-bbbb-cccc-dddddddddddd'), 'f=$(ls "$HOME"/.claude/projects/*/00000001-aaaa-bbbb-cccc-dddddddddddd.jsonl 2>/dev/null | head -n 1)');
	assert.throws(() => locateScript('x; rm -rf ~'), /not a Claude session id/);
	assert.match(tailScript('f=/x', 12), /n=12\n[\s\S]*exec tail -c \+\$\(\(n \+ 1\)\) -F "\$f"$/);
});

test('this machine: from the end of the file, only what is appended; partial lines wait; a grown answer comes again under its id', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-follow-'));
	const file = path.join(dir, 's.jsonl');
	await writeFile(file, `${user('u0', 'old')}\n${said('a0', 'old answer')}\n`);
	const calls: { entries: LiveEntry[]; cursor: string }[] = [];
	const follow = followLocal(async () => file, { classify: claudePiece, onEntries: (entries, cursor) => calls.push({ entries, cursor }), pollMs: 30, cursorDelayMs: 30 });
	try {
		await until(() => calls.length === 1);
		assert.deepEqual(calls[0].entries, []);
		const start = Number(calls[0].cursor);
		const line1 = `${user('u1', 'from the terminal')}\n`;
		await appendFile(file, line1 + said('a1', 'On it.').slice(0, 20));
		await until(() => calls.some(c => c.entries.length));
		assert.deepEqual(calls.flatMap(c => c.entries).map(e => [e.id, e.role, e.text]), [['u1', 'user', 'from the terminal']]);
		await appendFile(file, `${said('a1', 'On it.').slice(20)}\n${tool('t1')}\n${said('a2', 'Done.')}\n`);
		await until(() => calls.flatMap(c => c.entries).some(e => e.text === 'On it.\n\nDone.'));
		const last = calls.flatMap(c => c.entries).filter(e => e.id === 'a1').at(-1)!;
		assert.equal(last.text, 'On it.\n\nDone.');
		// The open answer is where a later follow starts again, so it comes whole.
		assert.equal(calls.at(-1)!.cursor, String(start + Buffer.byteLength(line1)));
	} finally {
		follow.dispose();
	}

	// Going on from that cursor: the answer again, under the same id; then a replaced file from its start.
	const again: LiveEntry[] = [];
	const cursors: string[] = [];
	const resumed = followLocal(async () => file, { classify: claudePiece, cursor: calls.at(-1)!.cursor, onEntries: (entries, cursor) => { again.push(...entries); cursors.push(cursor); }, pollMs: 30, cursorDelayMs: 30 });
	try {
		await until(() => cursors.length === 1);
		assert.deepEqual(again.map(e => [e.id, e.text]), [['a1', 'On it.\n\nDone.']]);
		await writeFile(`${file}.new`, `${user('u9', 'fresh')}\n`);
		await rename(`${file}.new`, file);
		await until(() => again.some(e => e.id === 'u9'));
	} finally {
		resumed.dispose();
	}
});

test('this machine: an Arkestra turn written into the session is not followed back', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-follow-'));
	const file = path.join(dir, 's.jsonl');
	await writeFile(file, '');
	const got: LiveEntry[] = [];
	let calls = 0;
	const follow = followLocal(async () => file, { classify: claudePiece, onEntries: entries => { calls++; got.push(...entries); }, pollMs: 30 });
	try {
		await until(() => calls === 1);
		await appendFile(file, [user('u1', '[You]\nnow deploy'), said('a1', 'Deployed.'), user('u2', 'thanks, from the app'), said('a2', 'Welcome.')].join('\n') + '\n');
		await until(() => got.some(e => e.id === 'a2'));
		assert.deepEqual(got.map(e => e.id), ['u2', 'a2']);
	} finally {
		follow.dispose();
	}
});

test('over a shell: tail -F from the end, appended entries, a dropped connection started again at the cursor, closed on dispose', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-follow-'));
	const file = path.join(dir, 's.jsonl');
	await writeFile(file, `${user('u0', 'old')}\n`);
	const children: ChildProcess[] = [];
	const got: LiveEntry[] = [];
	const cursors: string[] = [];
	const follow = followRemote((command, args, options) => { const c = spawn(command, args, options); children.push(c); return c; }, `f='${file}'`, {
		classify: claudePiece, onEntries: (entries, cursor) => { got.push(...entries); cursors.push(cursor); }, backoffMs: [50], cursorDelayMs: 30,
	});
	try {
		await until(() => cursors.length === 1);
		assert.equal(cursors[0], String(Buffer.byteLength(`${user('u0', 'old')}\n`)));
		await appendFile(file, `${user('u1', 'hello')}\n${said('a1', 'Hi.')}\n`);
		await until(() => got.some(e => e.id === 'a1'));
		children[0].kill();
		await until(() => children.length === 2);
		await appendFile(file, `${said('a2', 'Anything else?')}\n`);
		await until(() => got.some(e => e.text === 'Hi.\n\nAnything else?'));
		assert.deepEqual(got.filter(e => e.id === 'u1').length, 1);
	} finally {
		follow.dispose();
	}
	await until(() => children.every(c => c.exitCode !== null || c.signalCode !== null));
});

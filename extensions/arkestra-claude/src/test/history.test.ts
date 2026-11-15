/*---------------------------------------------------------------------------------------------
 *  Arkestra. What a Claude Code session file holds beside plain messages: messages the user sent
 *  while Claude worked, compactions, the model and context fill; the history read from its end.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type SpawnOptions } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAgent, ROOM_PREAMBLE } from '../claudeCode';
import { followLocal } from '../follow';
import type { SessionMeta } from '../rooms';
import { COMPACTED, ClaudeHistory, claudeMeta, claudePiece, isCompactSummary, localHistory, parseHistory, readScript, setImageStore } from '../sessions';

/** Real lines of a session (private text replaced): a message, a tool step, a message sent mid-turn with its queue lines, a picture sent mid-turn, an answer, a task report sent mid-turn, a compaction and its summary. */
const FIXTURE = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'queued-and-compacted.jsonl');
const SESSION = '00000001-aaaa-bbbb-cccc-dddddddddddd';
const said = (uuid: string, text: string, extra: object = {}) => JSON.stringify({ type: 'assistant', uuid, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 50 } }, ...extra });
const queued = (uuid: string, prompt: unknown, commandMode = 'prompt') => JSON.stringify({ type: 'attachment', uuid, timestamp: '2026-11-14T22:27:39.176Z', attachment: { type: 'queued_command', prompt, commandMode } });
const user = (uuid: string, content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content }, ...extra });

test('a real session excerpt: messages sent while Claude worked at their place (a picture too), once; a compaction one line, its summary never', async () => {
	setImageStore(() => '/pictures/one.png');
	const text = await readFile(FIXTURE, 'utf8');
	assert.deepEqual(parseHistory(text).map(e => [e.role, e.text, e.id]), [
		['user', 'first message', '5c1b6b72-d388-4d4c-bafe-6a9fc95316db'],
		['user', 'sent while Claude worked', 'fe851c11-a21e-4a67-bfdf-9b9bec92d1e5'],
		['user', '![image](/pictures/one.png)', '6575a8e6-abfa-4411-a2e2-5aed63ad2653'],
		['agent', 'Looking at it.', 'be5fc75f-2461-4676-b3a0-0e8f48d2119e'],
		['system', 'Background command "npm test" completed (exit code 0)', 'aa820ded-24b5-4fa0-99c8-183360fba2cd'],
		['system', COMPACTED, '597e885b-94b4-408a-847e-db2072463310'],
	]);
	assert.ok(!parseHistory(text).some(e => /being continued|stripped/.test(e.text)));
	// The latest answer's model and how full its context was: input, cache read and cache written.
	const history = new ClaudeHistory();
	history.push(Buffer.from(text));
	const last = text.trim().split('\n').map(l => JSON.parse(l)).filter(d => d.type === 'assistant').at(-1).message.usage;
	assert.deepEqual(history.result().meta, { model: 'claude-opus-5-5', context: last.input_tokens + last.cache_read_input_tokens + last.cache_creation_input_tokens });
	assert.equal(history.result().cursor, String(Buffer.byteLength(text)));
});

test('a message sent mid-turn splits the answer around it; other queued kinds and Claude Code\'s own lines stay out', () => {
	const lines = [
		user('u1', 'fix the stop'),
		said('a1', 'Looking.'),
		JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'also the test' }),
		queued('q1', 'also the test'),
		JSON.stringify({ type: 'queue-operation', operation: 'remove', content: 'also the test' }),
		said('a2', 'Fixed, test added.'),
		queued('q2', [{ type: 'text', text: 'and this [Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]),
		queued('q3', 'ls', 'bash'),
		JSON.stringify({ type: 'attachment', uuid: 'x1', attachment: { type: 'file', filename: 'a.ts' } }),
		user('s1', 'Summary of the earlier part. This session is being continued from a previous conversation that ran out of context.'),
		user('s2', 'shown only in the transcript', { isVisibleInTranscriptOnly: true }),
		said('a3', 'Done.'),
	];
	setImageStore(() => '/p.png');
	assert.deepEqual(parseHistory(lines.join('\n')).map(e => [e.id, e.role, e.text]), [
		['u1', 'user', 'fix the stop'],
		['a1', 'agent', 'Looking.'],
		['q1', 'user', 'also the test'],
		['a2', 'agent', 'Fixed, test added.'],
		['q2', 'user', 'and this\n\n![image](/p.png)'],
		['a3', 'agent', 'Done.'],
	]);
	assert.deepEqual(claudePiece(JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', content: 'Conversation compacted' })), { kind: 'notice', text: COMPACTED, id: 'c1' });
	assert.ok(isCompactSummary('<artifact-content-authored-by-others/>\nThis session is being continued from a previous conversation that ran out of context.'));
	assert.ok(!isCompactSummary('fix the stop'));
});

test('the history leaves out what an Arkestra room sent into the session and the answer to it', () => {
	const lines = [user('u1', 'fix it'), said('a1', 'Fixed.'), user('r1', `${ROOM_PREAMBLE}\n\n[You]\nnow deploy`), said('a2', 'Deployed.'), user('u2', 'thanks')];
	assert.deepEqual(parseHistory(lines.join('\n')).map(e => e.id), ['u1', 'a1', 'u2']);
});

test('model and context: from main-chain answers only; Claude Code\'s stand-in answers and side chains say nothing', () => {
	assert.deepEqual(claudeMeta(said('a1', 'x')), { model: 'claude-opus-5-5', context: 1012 });
	assert.equal(claudeMeta(said('a1', 'x', { isSidechain: true })), undefined);
	assert.equal(claudeMeta(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [] } })), undefined);
	assert.deepEqual(claudeMeta(JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-5', content: [] } })), { model: 'claude-sonnet-4-5' });
	assert.equal(claudeMeta(user('u1', 'hi')), undefined);
	assert.equal(claudeMeta('not json "assistant"'), undefined);
});

test('read from the end of a file: bytes after the offset line, the cut first line skipped, the cursor in the file\'s bytes', () => {
	const tail = `cut line"}\n${user('u1', 'é then')}\n${said('a1', 'ok')}\n`;
	const history = new ClaudeHistory(0, true);
	const bytes = Buffer.from(`\u001eAT 5000\n${tail}`);
	history.push(bytes.subarray(0, 5));
	history.push(bytes.subarray(5, 30));
	history.push(bytes.subarray(30));
	const result = history.result();
	assert.deepEqual(result.entries.map(e => e.id), ['u1', 'a1']);
	// The answer may still grow: the follow goes on where it began, and reads it again under its id.
	assert.equal(result.cursor, String(5000 + Buffer.byteLength(`cut line"}\n${user('u1', 'é then')}\n`)));
	assert.match(readScript(SESSION), /exit 3\n[\s\S]*\\036AT %s\\n[\s\S]*exec tail -c \+\$\(\(n \+ 1\)\) "\$f"$/);
	assert.throws(() => readScript('x; rm -rf ~'), /not a Claude session id/);
});

test('history here and over a shell: the same entries, model and fill, and a cursor at the end of the file', async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'arkestra-home-'));
	const dir = path.join(home, '.claude', 'projects', '-home-r-tenark');
	await mkdir(dir, { recursive: true });
	const content = [user('u1', 'fix it'), said('a1', 'Fixed.'), queued('q1', 'and deploy'), user('u2', 'thanks')].join('\n') + '\n';
	await writeFile(path.join(dir, `${SESSION}.jsonl`), content);
	const here = await localHistory(home, SESSION);
	assert.deepEqual(here.entries.map(e => e.id), ['u1', 'a1', 'q1', 'u2']);
	assert.equal(here.cursor, String(Buffer.byteLength(content)));
	assert.deepEqual(here.meta, { model: 'claude-opus-5-5', context: 1012 });
	await assert.rejects(localHistory(home, '00000009-aaaa-bbbb-cccc-dddddddddddd'), /gone/);

	const fakeSpawn = (command: string, args: string[], options: SpawnOptions) => spawn(command, args, { ...options, env: { ...process.env, HOME: home } });
	const remote = new ClaudeCodeAgent({ command: 'claude', permissionMode: 'acceptEdits', cwd: () => undefined, apiKey: async () => undefined, spawn: fakeSpawn, identity: { id: 'claude@prd', name: 'Claude · prd', where: 'prd' } });
	assert.deepEqual(await remote.sessionHistory(SESSION), here);
	await assert.rejects(remote.sessionHistory('00000009-aaaa-bbbb-cccc-dddddddddddd'), /gone/);
	assert.equal(remote.historyVersion, 5);
});

test('the live follow hands over the model and context fill when they change', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-follow-'));
	const file = path.join(dir, 's.jsonl');
	await writeFile(file, '');
	const metas: (SessionMeta | undefined)[] = [];
	let calls = 0;
	const follow = followLocal(async () => file, { classify: claudePiece, meta: claudeMeta, onEntries: (_entries, _cursor, meta) => { calls++; metas.push(meta); }, pollMs: 30, cursorDelayMs: 30 });
	try {
		await new Promise<void>((resolve, reject) => { const t = setInterval(() => { if (calls) { clearInterval(t); resolve(); } }, 10); setTimeout(() => reject(new Error('timed out')), 5000); });
		await appendFile(file, `${user('u1', 'go')}\n${said('a1', 'Going.')}\n`);
		const end = Date.now() + 5000;
		while (!metas.some(m => m?.context === 1012) && Date.now() < end) {
			await new Promise(r => setTimeout(r, 20));
		}
		assert.deepEqual(metas.at(-1), { model: 'claude-opus-5-5', context: 1012 });
		assert.equal(metas[0], undefined, 'nothing known yet');
	} finally {
		follow.dispose();
	}
});

test('a message another sender put in the session: from Arkestra the user\'s own words in their place, from another session a line as the Claude app shows it', () => {
	const peer = (from: string, name: string, body: string) => JSON.stringify({ type: 'user', isMeta: true, uuid: 'p1', timestamp: '2026-11-15T18:57:03.872Z', origin: { kind: 'peer', from, name, body }, message: { role: 'user', content: `Another Claude session sent a message: <cross-session-message from="${from}">\n${body}\n</cross-session-message>` } });
	assert.deepEqual(claudePiece(peer('arkestra', 'Arkestra', '%?')), { kind: 'user', text: '%?', id: 'p1', at: '2026-11-15T18:57:03.872Z' });
	assert.deepEqual(claudePiece(peer('arkestra-app', 'The user, writing in the Arkestra app', 'telepítve')), { kind: 'user', text: 'telepítve', id: 'p1', at: '2026-11-15T18:57:03.872Z' });
	assert.deepEqual(claudePiece(peer('uds:/run/x.sock', 'Tenark X', 'kész a\nT108')), { kind: 'notice', text: 'Message from Tenark X: kész a T108', id: 'p1', at: '2026-11-15T18:57:03.872Z' });
	// Other meta lines stay out.
	assert.equal(claudePiece(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'x' } })), undefined);
});

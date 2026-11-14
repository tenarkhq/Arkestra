/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude Code's own sessions (AR39): the listing, a session's messages, adopting one.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAgent, ROOM_PREAMBLE } from '../claudeCode';
import { localListing, localSessionFile, parseHistory, parseListing, readScript } from '../sessions';
import type { Message } from '../rooms';

const ID = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;
const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', cwd: '/home/r/tenark', message: { role: 'user', content }, ...extra });

test('listing: title from a custom title, a summary or the first thing the user wrote; Arkestra\'s own rooms left out', () => {
	const out = [
		`\u001eFILE 1700000300 -home-r-tenark/${ID(1)}.jsonl`, JSON.stringify({ type: 'summary', summary: 'Stop loss fix' }), user('fix the stop'),
		`\u001eFILE 1700000500 -home-r-x/${ID(2)}.jsonl`, user('<command-name>/clear</command-name>'), user([{ type: 'text', text: 'deploy 3.2.35\nthen check' }]),
		`\u001eFILE 1700000400 -home-r-x/${ID(3)}.jsonl`, user(`${ROOM_PREAMBLE}\n\n[You]\nhello`),
		`\u001eFILE 1700000100 -home-r-x/${ID(4)}.jsonl`, '{"type":"user","cwd":"/srv/y","message":{"role":"user","content":"a very long pasted brief that the head cut \\"here',
		`\u001eFILE 1700000600 -home-r-x/not-a-session.jsonl`, user('x'),
		`\u001eFILE 1700000200 -home-r-x/${ID(5)}.jsonl`, user([{ type: 'tool_result', content: 'ok' }]), JSON.stringify({ type: 'custom-title', customTitle: 'Named by me' }),
	].join('\n');
	assert.deepEqual(parseListing(out).map(s => [s.id.slice(0, 8), s.title, s.cwd ?? '']), [
		[ID(2).slice(0, 8), 'deploy 3.2.35', '/home/r/tenark'],
		[ID(1).slice(0, 8), 'Stop loss fix', '/home/r/tenark'],
		[ID(5).slice(0, 8), 'Named by me', '/home/r/tenark'],
		[ID(4).slice(0, 8), 'a very long pasted brief that the head cut "here', '/srv/y'],
	]);
	assert.equal(parseListing(out)[0].updatedAt, new Date(1700000500 * 1000).toISOString());
	assert.throws(() => readScript('x; rm -rf ~'), /not a Claude session id/);
});

test('history: what the user wrote and Claude\'s answers, one answer per request; tool steps and side chains left out', () => {
	const lines = [
		user('fix the stop', { timestamp: '2026-11-14T10:00:00Z' }),
		JSON.stringify({ type: 'assistant', timestamp: '2026-11-14T10:00:05Z', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read', input: {} }] } }),
		user([{ type: 'tool_result', content: 'file' }]),
		JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
		JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed in state.py.' }] } }),
		user('side', { isSidechain: true }),
		user('Caveat: local command output'),
		'not json',
		user('and the test?'),
		JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Added.' }] } }),
	].join('\n');
	assert.deepEqual(parseHistory(lines), [
		{ role: 'user', text: 'fix the stop', at: '2026-11-14T10:00:00Z' },
		{ role: 'agent', text: 'Looking.\n\nFixed in state.py.', at: '2026-11-14T10:00:05Z' },
		{ role: 'user', text: 'and the test?' },
		{ role: 'agent', text: 'Added.' },
	]);
	assert.equal(parseHistory(lines, 2).length, 2);
});

test('this machine: the listing and the session file without a shell; sub-agent files left out', async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'arkestra-home-'));
	const dir = path.join(home, '.claude', 'projects', '-home-r-tenark');
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `${ID(1)}.jsonl`), [user('older'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })].join('\n'));
	await writeFile(path.join(dir, `${ID(2)}.jsonl`), user('newer'));
	await writeFile(path.join(dir, 'agent-1234.jsonl'), user('sub-agent'));
	await utimes(path.join(dir, `${ID(1)}.jsonl`), 1700000000, 1700000000);
	assert.deepEqual(parseListing(await localListing(home)).map(s => s.title), ['newer', 'older']);
	assert.deepEqual(parseHistory(await localSessionFile(home, ID(1))).map(e => e.text), ['older', 'ok']);
	assert.equal(await localListing(path.join(home, 'nobody')), '');
});

const msg = (kind: 'user' | 'agent', text: string): Message => ({ id: Math.random().toString(36).slice(2), at: new Date().toISOString(), author: { kind, id: kind === 'user' ? 'user' : 'claude', name: kind === 'user' ? 'You' : 'Claude' }, text });

test('an adopted session goes on with --resume in its own folder, and gets only what it has not seen', async () => {
	const calls: { command: string; args: string[]; cwd?: string }[] = [];
	const fakeSpawn = (command: string, args: string[], options: SpawnOptions) => {
		calls.push({ command, args, cwd: options.cwd as string | undefined });
		return spawn(process.execPath, ['-e', 'console.log(JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: process.argv[1] }))', ID(7)], { stdio: ['ignore', 'pipe', 'pipe'] });
	};
	const old = [msg('user', 'fix the stop'), msg('agent', 'Fixed.')];
	const next = msg('user', 'now deploy');

	// On an SSH machine: through `cd` into the session's folder.
	const remote = new ClaudeCodeAgent({ command: 'claude', permissionMode: 'acceptEdits', cwd: () => undefined, apiKey: async () => undefined, spawn: fakeSpawn, identity: { id: 'claude@prd', name: 'Claude · prd', where: 'prd' } });
	remote.adoptSession('r', { id: ID(7), cwd: '/home/r/tenark' }, old.map(m => m.id));
	remote.adoptSession('r', { id: ID(8) }, []); // the room has its session: nothing changes
	await remote.turn({ roomId: 'r', transcript: [...old, next] }, () => { }, new AbortController().signal);
	const r = calls.at(-1)!;
	assert.equal(r.command, 'sh');
	assert.deepEqual(r.args.slice(2, 5), ['sh', '/home/r/tenark', 'claude']);
	const rest = r.args.slice(5);
	assert.equal(rest[rest.indexOf('--resume') + 1], ID(7));
	const prompt = rest[rest.indexOf('-p') + 1];
	assert.ok(prompt.includes('now deploy') && !prompt.includes('fix the stop') && !prompt.startsWith(ROOM_PREAMBLE), prompt);

});

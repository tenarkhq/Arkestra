/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude Code's own sessions (AR39): the listing, a session's messages, adopting one.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAgent, ROOM_PREAMBLE } from '../claudeCode';
import { LIST_SCRIPT, claudeStep, localListing, localSessionFile, parseHistory, parseListing, readScript } from '../sessions';
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

test('listing: the latest name wins (Claude Code writes it again near the end); the apps\' name before the first message', () => {
	const ID = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`;
	const user = (content: string) => JSON.stringify({ type: 'user', cwd: '/srv', message: { role: 'user', content } });
	const out = [
		`\u001eFILE 1700000300 -srv/${ID(1)}.jsonl`, user('first words'), JSON.stringify({ type: 'custom-title', customTitle: 'Old name' }),
		JSON.stringify({ type: 'custom-title', customTitle: 'Old name' }), JSON.stringify({ type: 'agent-name', agentName: 'Arkestra' }), JSON.stringify({ type: 'custom-title', customTitle: 'Arkestra' }),
		`\u001eFILE 1700000200 -srv/${ID(2)}.jsonl`, user('hello there'), JSON.stringify({ type: 'agent-name', agentName: 'Átadó beolvasása' }),
		'"bridgeSessionId":"cse_019UZiid5kkFdWcwMSXfYYca"',
		`\u001eFILE 1700000100 -srv/${ID(3)}.jsonl`, user('just a chat'),
	].join('\n');
	assert.deepEqual(parseListing(out).map(s => s.title), ['Arkestra', 'Átadó beolvasása', 'just a chat']);
	assert.deepEqual(parseListing(out).map(s => s.bridge ?? ''), ['', 'cse_019UZiid5kkFdWcwMSXfYYca', '']);
});

test('history: what the user wrote and Claude\'s answers, one answer per request with its tool steps as lines; side chains left out', () => {
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
		{ role: 'agent', text: 'Looking.\n\n<arkestra-step kind="read">Read a file</arkestra-step>\n\n<arkestra-step kind="edit">Edited a file</arkestra-step>\n\nFixed in state.py.', at: '2026-11-14T10:00:05Z' },
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

test('the listing skips scripts\' and pipelines\' sessions (claude -p, the Agent SDK) and temporary folders, the same over SSH as here', { skip: process.platform === 'win32' }, async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'arkestra-home-'));
	const projects = path.join(home, '.claude', 'projects');
	const chats = path.join(projects, '-home-r-tenark');
	const scratch = path.join(projects, '-tmp-claude-1001-beat-triage');
	await mkdir(chats, { recursive: true });
	await mkdir(scratch, { recursive: true });
	await writeFile(path.join(chats, `${ID(1)}.jsonl`), user('Tenark X', { entrypoint: 'claude-desktop' }));
	await writeFile(path.join(chats, `${ID(2)}.jsonl`), user('a dispatcher brief', { entrypoint: 'sdk-cli' }));
	await writeFile(path.join(chats, `${ID(3)}.jsonl`), [JSON.stringify({ type: 'user', message: { content: '<system-reminder>context</system-reminder>' } }), user('ArkadeOS', { entrypoint: 'cli' })].join('\n'));
	await writeFile(path.join(scratch, `${ID(4)}.jsonl`), user('You triage one beat', { entrypoint: 'claude-desktop' }));
	await utimes(path.join(chats, `${ID(1)}.jsonl`), 1700000000, 1700000000);
	const here = parseListing(await localListing(home));
	assert.deepEqual(here.map(s => s.title), ['ArkadeOS', 'Tenark X']);
	// The folders are named after paths (-home-...): the shell listing must not read them as options.
	const shell = parseListing(execFileSync('sh', ['-c', LIST_SCRIPT], { env: { ...process.env, HOME: home } }).toString());
	assert.deepEqual(shell, here);
});

test('tool steps as the Claude app names them: a command by its description in the past, files by name, own bookkeeping left out', () => {
	const t = (name: string, input: object) => claudeStep({ name, input });
	assert.equal(t('Bash', { description: 'Check the hand-started VM test progress' }), '<arkestra-step kind="command">Checked the hand-started VM test progress</arkestra-step>');
	assert.equal(t('Bash', { description: 'Run the tests' }), '<arkestra-step kind="command">Ran the tests</arkestra-step>');
	assert.equal(t('Bash', { description: 'Copy <x> files' }), '<arkestra-step kind="command">Copied ‹x› files</arkestra-step>');
	assert.equal(t('Edit', { file_path: '/a/b/state.py' }), '<arkestra-step kind="edit">Edited state.py</arkestra-step>');
	assert.equal(t('WebFetch', { url: 'https://docs.example.com/x' }), '<arkestra-step kind="web">Fetched docs.example.com</arkestra-step>');
	assert.equal(t('mcp__github__get_file_contents', {}), '<arkestra-step kind="other">Used get file contents</arkestra-step>');
	assert.equal(t('TodoWrite', {}), undefined);
	assert.equal(t('mcp__ccd_turn__update_plan', {}), undefined);
});

test('a linked session names the session that started it (its desktop-app id); running sessions their own; the same over SSH as here', { skip: process.platform === 'win32' }, async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'arkestra-home-'));
	const chats = path.join(home, '.claude', 'projects', '-home-r-tenark');
	const running = path.join(home, '.claude', 'sessions');
	await mkdir(chats, { recursive: true });
	await mkdir(running, { recursive: true });
	const PARENT = 'local_82ba8fe2-938d-4cca-ac4e-6ca2e6cfca4b';
	const CHILD_HOST = 'local_11111111-2222-4333-8444-555555555555';
	await writeFile(path.join(chats, `${ID(1)}.jsonl`), [user('Tenark X konzol', { entrypoint: 'claude-desktop' }), JSON.stringify({ type: 'custom-title', customTitle: 'Tenark X' })].join('\n'));
	// The child: its first message says another session started it; its instructions name that session.
	await writeFile(path.join(chats, `${ID(2)}.jsonl`), [
		JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'Task (from the session that started this one):\nFix the strategies page' }),
		JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: [`Blocked? Send ONE short question with \`SendMessage\` (\`to\`: \`${PARENT}\`) and end your turn.`] } }),
		user('Task (from the session that started this one):\nFix the strategies page', { entrypoint: 'claude-desktop' }),
		JSON.stringify({ type: 'agent-name', agentName: 'Stratégiák javítás' }),
	].join('\n'));
	// A plain session that only talks about such a line is not a linked one.
	await writeFile(path.join(chats, `${ID(3)}.jsonl`), [user('look at this: `SendMessage` (`to`: `local_99999999-2222-4333-8444-555555555555`)', { entrypoint: 'claude-desktop' })].join('\n'));
	await writeFile(path.join(running, '123.json'), JSON.stringify({ pid: 123, sessionId: ID(1), hostSessionId: PARENT, name: 'Tenark X' }));
	await writeFile(path.join(running, '124.json'), JSON.stringify({ pid: 124, sessionId: ID(2), hostSessionId: CHILD_HOST }));
	await writeFile(path.join(running, '125.json'), JSON.stringify({ pid: 125, sessionId: ID(9) }));
	const here = parseListing(await localListing(home));
	const byId = new Map(here.map(s => [s.id, s]));
	assert.equal(byId.get(ID(1))?.host, PARENT);
	assert.equal(byId.get(ID(1))?.parentHost, undefined);
	assert.equal(byId.get(ID(2))?.parentHost, PARENT);
	assert.equal(byId.get(ID(2))?.host, CHILD_HOST);
	assert.equal(byId.get(ID(2))?.title, 'Stratégiák javítás');
	assert.equal(byId.get(ID(3))?.parentHost, undefined);
	const shell = parseListing(execFileSync('sh', ['-c', LIST_SCRIPT], { env: { ...process.env, HOME: home } }).toString());
	assert.deepEqual(shell, here);
});

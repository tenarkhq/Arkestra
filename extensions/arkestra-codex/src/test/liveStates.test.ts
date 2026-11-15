/*---------------------------------------------------------------------------------------------
 *  Arkestra. A Codex thread's turn read live from its rollout file (the left bar's dots).
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { STALE_S, liveLine, shownState, stateOfTail, threadOfFile, watchScript } from '../liveStates';

const ID = '01a1e077-8910-7db3-b8e7-c6ac3955c526';
const ev = (type: string) => JSON.stringify({ timestamp: '2026-11-15T19:52:10.182Z', type: 'event_msg', payload: { type } });
const item = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } });

test('the latest turn mark decides', () => {
	assert.equal(stateOfTail([ev('task_started'), item, ev('token_count')].join('\n')), 'run');
	assert.equal(stateOfTail([ev('task_started'), item, ev('task_complete')].join('\n')), 'idle');
	assert.equal(stateOfTail([ev('task_started'), ev('turn_aborted')].join('\n')), 'idle');
	assert.equal(stateOfTail([ev('task_complete'), ev('task_started'), item].join('\n')), 'run');
});

test('a turn whose start fell off the read end still runs; nothing said: unknown', () => {
	assert.equal(stateOfTail(`{"cut line\n${item}\n${item}`), 'run');
	assert.equal(stateOfTail(JSON.stringify({ type: 'session_meta', payload: {} })), undefined);
});

test('the thread id from a rollout file name', () => {
	assert.equal(threadOfFile(`/x/sessions/2026/11/15/rollout-2026-11-15T19-28-12-${ID}.jsonl`), ID);
	assert.equal(threadOfFile('/x/sessions/2026/11/15/notes.jsonl'), undefined);
});

test('a run that wrote nothing for long is shown ended', () => {
	assert.equal(shownState('run', 1000, 1000 + STALE_S - 1), 'run');
	assert.equal(shownState('run', 1000, 1000 + STALE_S + 1), 'idle');
});

test('the machine watch tells each thread once, after its sweep says ready', async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'codex-live-'));
	const dir = path.join(home, 'sessions', '2026', '11', '15');
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `rollout-2026-11-15T19-28-12-${ID}.jsonl`), [ev('task_started'), item, ''].join('\n'));
	let out = '';
	try {
		execFileSync('sh', ['-c', `${watchScript([home])} & p=$!; sleep 2; kill $p`], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch (e) {
		out = String((e as { stdout?: string }).stdout ?? '');
	}
	out ||= execFileSync('sh', ['-c', `(${watchScript([home])}) & p=$!; sleep 2; kill $p; wait $p 2>/dev/null; true`], { encoding: 'utf8', timeout: 10_000 });
	const lines = out.trim().split('\n').map(liveLine);
	assert.deepEqual(lines.map(l => (l === 'ready' ? 'ready' : l && `${l.id} ${l.state}`)), [`${ID} run`, 'ready']);
});

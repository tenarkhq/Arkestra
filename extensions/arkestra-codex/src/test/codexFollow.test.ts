/*---------------------------------------------------------------------------------------------
 *  Arkestra. A Codex rollout file read live (AR39): its lines, where it is, the shared reader.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { codexMeta, codexPiece, codexToolLine, latestTokenCountScript, localRollout, locateRolloutScript, readLocalRollout, readRolloutScript, rolloutHistory, rolloutLimits } from '../codexFollow';
import { EntryAssembler, LineSplitter, assemble, followLocal } from '../follow';
import type { SessionEntry } from '../rooms';

/** A Codex 0.163 rollout in the real line format (session_meta, turn_context, response_item, event_msg…), nothing private. */
const FIXTURE = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'rollout-2026-11-14T10-00-00-01a1e000-0000-7000-8000-00000000c0de.jsonl');

const ID = '01a15d40-ab71-74c1-877b-793c24b8fba4';
const event = (payload: object) => JSON.stringify({ timestamp: '2026-11-14T10:00:00Z', type: 'event_msg', payload });

test('rollout lines: finished user and agent items with their ids, older message events without, tool items as steps, the rest left out', () => {
	assert.deepEqual(codexPiece(event({ type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'fix it', text_elements: [] }] } })),
		{ kind: 'user', text: 'fix it', id: 'u1', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(codexPiece(event({ type: 'item_completed', item: { type: 'AgentMessage', id: 'msg_1', phase: 'commentary', content: [{ type: 'Text', text: 'Looking.' }] } })),
		{ kind: 'agent', text: 'Looking.', id: 'msg_1', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(codexPiece(event({ type: 'user_message', message: 'older codex ' })), { kind: 'user', text: 'older codex', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(codexPiece(event({ type: 'agent_message', message: 'Done.' })), { kind: 'agent', text: 'Done.', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(codexPiece(event({ type: 'item_completed', item: { type: 'CommandExecution', id: 'c', command: ['/bin/bash', '-lc', 'git status --short'] } })),
		{ kind: 'step', text: '<arkestra-step kind="command">Ran git status --short</arkestra-step>', id: 'c', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(codexPiece(event({ type: 'item_completed', item: { type: 'FileChange', id: 'f', changes: { '/w/a.py': {}, '/w/b.py': {} } } }))?.text, '<arkestra-step kind="edit">Edited a.py, b.py</arkestra-step>');
	assert.deepEqual(codexPiece(event({ type: 'item_completed', item: { type: 'ImageView', id: 'i', path: 'file:///srv/x/links%20hu.png' } }))?.text, '<arkestra-step kind="read">Viewed links hu.png</arkestra-step>');
	for (const line of [
		event({ type: 'item_completed', item: { type: 'Reasoning', id: 'r' } }),
		event({ type: 'token_count' }),
		JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] } }),
		'{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMe',
	]) {
		assert.equal(codexPiece(line), undefined, line);
	}
	// Commentary and the final answer are one answer under the first item's id.
	const text = [event({ type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'go' }] } }),
		event({ type: 'item_completed', item: { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: 'Plan:' }] } }),
		event({ type: 'item_completed', item: { type: 'AgentMessage', id: 'm2', content: [{ type: 'Text', text: 'Done.' }] } })].join('\n');
	assert.deepEqual(assemble(text, codexPiece, 10).map(e => [e.id, e.role, e.text]), [['u1', 'user', 'go'], ['m1', 'agent', 'Plan:\n\nDone.']]);
});

test('older rollouts: entries without ids get the place of their line, the same on every read', () => {
	const lines = [event({ type: 'user_message', message: 'hi' }), event({ type: 'agent_message', message: 'Hello.' })].map(l => `${l}\n`).join('');
	const read = () => {
		const splitter = new LineSplitter();
		const a = new EntryAssembler({ mute: true, positional: true });
		return splitter.push(Buffer.from(lines)).map(l => a.feed(codexPiece(l.text), l.start)?.id);
	};
	assert.deepEqual(read(), ['@0', `@${Buffer.byteLength(lines.split('\n')[0]) + 1}`]);
	assert.deepEqual(read(), read());
});

test('the rollout file: found under the Codex homes here, or a known path or a search on a POSIX machine', async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'arkestra-codex-home-'));
	const day = path.join(home, 'sessions', '2026', '11', '14');
	await mkdir(day, { recursive: true });
	await writeFile(path.join(day, `rollout-2026-11-14T10-00-00-${ID}.jsonl`), '');
	await writeFile(path.join(day, 'rollout-2026-11-14T09-00-00-other.jsonl'), '');
	assert.equal(await localRollout([path.join(home, 'none'), home], ID), path.join(day, `rollout-2026-11-14T10-00-00-${ID}.jsonl`));
	assert.equal(await localRollout([home], '01a15d40-0000-0000-0000-000000000000'), undefined);
	assert.equal(locateRolloutScript(ID, "/home/r/.codex/it's.jsonl", []), `f='/home/r/.codex/it'\\''s.jsonl'`);
	assert.equal(locateRolloutScript(ID, undefined, ['~/.codex', '~/.arkestra/codex-key']),
		`f=$(find "$HOME"/'.codex'/sessions "$HOME"/'.arkestra/codex-key'/sessions -name 'rollout-*-${ID}.jsonl' 2>/dev/null | head -n 1)`);
	assert.throws(() => locateRolloutScript('x; rm -rf ~', undefined, []), /not a Codex thread id/);
});

test('older rollouts: Codex\'s own preamble (folder, AGENTS.md, user instructions) is not a user message', () => {
	for (const text of ['<environment_context>\n  <cwd>/w</cwd>\n</environment_context>', '<user_instructions>\nbe brief\n</user_instructions>', '# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>x</INSTRUCTIONS>']) {
		assert.equal(codexPiece(event({ type: 'user_message', message: text })), undefined, text);
		assert.equal(codexPiece(event({ type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } })), undefined, text);
	}
	assert.deepEqual(codexPiece(event({ type: 'user_message', message: 'what is <environment_context>?' }))?.text, 'what is <environment_context>?');
});

test('history from a 0.163 rollout: what the user wrote and the answers, preamble and the room\'s own turn left out, the follow cursor after it', async () => {
	const content = await readFile(FIXTURE);
	const history = rolloutHistory(content);
	assert.deepEqual(history.entries.map(e => [e.id, e.role, e.text, e.at]), [
		['01a1e000-0002-7000-8000-0000000000a1', 'user', 'Add a health check endpoint.', '2026-11-14T10:00:00.030Z'],
		['msg_a1', 'agent', 'I will look at the server first.\n\n<arkestra-step kind="command">Ran ls src</arkestra-step>\n\nAdded GET /health to src/server.ts.', '2026-11-14T10:00:03.000Z'],
		['01a1e000-0002-7000-8000-0000000000b2', 'user', 'Thanks. A test for it too.', '2026-11-14T10:05:00.010Z'],
		['msg_a3', 'agent', 'Added test/health.test.ts; it passes.', '2026-11-14T10:05:20.000Z'],
	]);
	// The last turn was the room's own: the follow goes on after the file, still muted.
	assert.equal(history.cursor, `${content.length}m`);
	assert.deepEqual(await readLocalRollout(FIXTURE), history);
	assert.deepEqual(rolloutHistory(content, 2).entries.map(e => e.id), ['01a1e000-0002-7000-8000-0000000000b2', 'msg_a3']);
	// A line still being written is not read; the answer before it may still grow, so the
	// cursor is at its start (the follow reads it again under the same id).
	const cut = content.subarray(0, content.indexOf('"Thanks.'));
	const partial = rolloutHistory(cut);
	assert.equal(partial.entries.length, 2);
	assert.equal(partial.cursor, String(content.lastIndexOf(10, content.indexOf('"msg_a1"')) + 1));
	const afterUser = content.subarray(0, content.indexOf('\n', content.indexOf('"type":"UserMessage","id":"01a1e000-0002-7000-8000-0000000000b2"')) + 1);
	assert.equal(rolloutHistory(afterUser).cursor, String(afterUser.length));
	assert.equal(readRolloutScript(`f='/x/r.jsonl'`), `f='/x/r.jsonl'\n[ -n "$f" ] && [ -f "$f" ] || exit 3\nexec cat "$f"`);
});

test('history then follow: whatever was written after the read comes once, under the same ids, nothing lost', async () => {
	const content = await readFile(FIXTURE);
	const dir = await mkdtemp(path.join(tmpdir(), 'arkestra-codex-hist-'));
	const whole = rolloutHistory(content).entries;
	// Cut after a line in the middle of an answer, after a whole turn, and inside a line.
	const lineEnds = [...content.entries()].filter(([, b]) => b === 10).map(([i]) => i + 1);
	const cuts = [content.indexOf('"msg_a1"'), lineEnds[12], lineEnds[20], content.length - 5, 0];
	for (const at of cuts) {
		const file = path.join(dir, `cut-${at}.jsonl`);
		await writeFile(file, content.subarray(0, at));
		const history = await readLocalRollout(file);
		await appendFile(file, content.subarray(at));
		const thread: SessionEntry[] = [...history.entries];
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timed out')), 5000);
			const follow = followLocal(async () => file, {
				classify: codexPiece, cursor: history.cursor, pollMs: 20,
				onEntries: entries => {
					for (const e of entries) {
						const i = thread.findIndex(t => t.id === e.id);
						i >= 0 ? thread[i] = e : thread.push(e); // the room's own dedupe: by id
					}
					clearTimeout(timer);
					follow.dispose();
					resolve();
				},
			});
		});
		assert.deepEqual(thread, whole, `cut at ${at}`);
	}
});

test('what a rollout line says about the thread: a turn\'s model, the latest call\'s context fill (never the running total)', () => {
	assert.deepEqual(codexMeta(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', cwd: '/w' } })), { model: 'gpt-5.5' });
	assert.deepEqual(codexMeta(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 900000 }, last_token_usage: { input_tokens: 30000, cached_input_tokens: 20000, output_tokens: 500, total_tokens: 30500 } } } })), { context: 30500 });
	assert.equal(codexMeta(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1280 } } } })), undefined);
	assert.equal(codexMeta(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'turn_context' } })), undefined);
	assert.equal(codexMeta('{"type":"turn_context", cut'), undefined);
	const patch = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch' } });
	assert.equal(codexToolLine(patch), true);
	assert.equal(codexToolLine(JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'hi' }] } })), false);
	const history = rolloutHistory(Buffer.from([JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }), patch].join('\n') + '\n'));
	assert.deepEqual([history.meta, history.lines], [{ model: 'gpt-5.5' }, [patch]]);
});

test('the quota in a rollout: Codex writes the account\'s windows with every token report; the newest rollout\'s last one is read', () => {
	const line = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 41200 }, model_context_window: 475000 }, rate_limits: { limit_id: 'codex', primary: { used_percent: 59.0, window_minutes: 10080, resets_at: 1794918849 }, secondary: null } } });
	const label = (m: number | null | undefined) => (m === 10080 ? 'week' : `${m}m`);
	assert.deepEqual(rolloutLimits(line, label), [{ label: 'week', usedPercent: 59, resetsAt: new Date(1794918849 * 1000).toISOString() }]);
	assert.deepEqual(codexMeta(line), { context: 41200, window: 475000 });
	assert.deepEqual(rolloutLimits('', label), []);
	assert.deepEqual(rolloutLimits(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }), label), []);
	const script = latestTokenCountScript(['~/.codex', '/srv/key home']);
	assert.ok(script.includes(`ls -t "$HOME"/'.codex'/sessions/*/*/*/rollout-*.jsonl '/srv/key home'/sessions/*/*/*/rollout-*.jsonl`), script);
	assert.ok(script.includes(`grep '"token_count"' "$f" | tail -n 1`));
});

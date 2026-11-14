/*---------------------------------------------------------------------------------------------
 *  Arkestra. A Codex rollout file read live (AR39): its lines, where it is, the shared reader.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { codexPiece, localRollout, locateRolloutScript } from '../codexFollow';
import { EntryAssembler, LineSplitter, assemble } from '../follow';

const ID = '01a15d40-ab71-74c1-877b-793c24b8fba4';
const event = (payload: object) => JSON.stringify({ timestamp: '2026-11-14T10:00:00Z', type: 'event_msg', payload });

test('rollout lines: finished user and agent items with their ids, older message events without, the rest left out', () => {
	assert.deepEqual(codexPiece(event({ type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'fix it', text_elements: [] }] } })),
		{ kind: 'user', text: 'fix it', id: 'u1', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(codexPiece(event({ type: 'item_completed', item: { type: 'AgentMessage', id: 'msg_1', phase: 'commentary', content: [{ type: 'Text', text: 'Looking.' }] } })),
		{ kind: 'agent', text: 'Looking.', id: 'msg_1', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(codexPiece(event({ type: 'user_message', message: 'older codex ' })), { kind: 'user', text: 'older codex', at: '2026-11-14T10:00:00Z' });
	assert.deepEqual(codexPiece(event({ type: 'agent_message', message: 'Done.' })), { kind: 'agent', text: 'Done.', at: '2026-11-14T10:00:00Z' });
	for (const line of [
		event({ type: 'item_completed', item: { type: 'CommandExecution', id: 'c', command: 'ls' } }),
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

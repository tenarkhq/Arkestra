/*---------------------------------------------------------------------------------------------
 *  Arkestra. What agents produced with their tools: files written (Claude Code Write / Edit,
 *  Codex apply_patch adds), claude.ai artifacts published; commands and code files are not.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { roomArtifacts } from '../artifacts';
import { artifactsFromSessionLines, mergeProduced, patchAdds, producedKind } from '../produced';
import { AgentRegistry, type Agent } from '../agent';
import { importedRoomState, newRoomState, Room } from '../room';

const claudeTool = (id: string, name: string, input: object, at = '2026-11-15T10:00:00Z') =>
	JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const claudeResult = (id: string, content: unknown, at = '2026-11-15T10:01:00Z') =>
	JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const codexCall = (payload: object, at = '2026-11-15T11:00:00Z') => JSON.stringify({ timestamp: at, type: 'response_item', payload });

test('kept file kinds: pages, documents, SVG, diagrams; code and config are not', () => {
	assert.equal(producedKind('/srv/x/report.html'), 'page');
	assert.equal(producedKind('NOTES.md'), 'document');
	assert.equal(producedKind('logo.SVG'), 'image');
	assert.equal(producedKind('flow.mmd'), 'diagram');
	assert.equal(producedKind('src/a.ts'), undefined);
	assert.equal(producedKind('run.sh'), undefined);
	assert.equal(producedKind('Makefile'), undefined);
});

test('Claude Code: Write of a page is an artifact, Bash and a code file are not; a publish keeps the file\'s text and its address', () => {
	const html = '<title>Riport</title><h1>Riport</h1>';
	const lines = [
		claudeTool('t1', 'Bash', { command: '( set -euo pipefail\nmake )' }),
		claudeTool('t2', 'Write', { file_path: '/home/u/src/a.ts', content: 'export {}' }),
		claudeTool('t3', 'Write', { file_path: '/home/u/out/riport.html', content: html }),
		claudeTool('t4', 'Artifact', { file_path: '/home/u/out/riport.html', icon: 'chart' }),
		'not json',
		claudeResult('t4', [{ type: 'text', text: 'Published: https://claude.ai/code/artifact/5f0c-aa11 (private)' }]),
		claudeTool('t5', 'mcp__docs__Artifact', { file_path: '/home/u/out/b.md', action: 'read' }),
	];
	const found = artifactsFromSessionLines(lines, 'claude@tenark');
	assert.deepEqual(found.map(f => [f.id, f.kind, f.title, f.url ?? '']), [
		['t3', 'page', 'riport.html', ''],
		['t4', 'page', 'riport.html', 'https://claude.ai/code/artifact/5f0c-aa11'],
	]);
	assert.equal(found[1].content, html);
	assert.equal(found[1].agentId, 'claude@tenark');
	assert.equal(found[1].at, '2026-11-15T10:01:00Z');
	// A failed publish, or one without an address, is nothing.
	assert.equal(artifactsFromSessionLines([claudeTool('x', 'Artifact', { file_path: 'a.html' }), claudeResult('x', 'refused')], 'claude').length, 0);
});

test('Codex: the files apply_patch adds, from its own call or a shell command; updates and code files are not', () => {
	const patch = ['*** Begin Patch', '*** Add File: docs/PLAN.md', '+# Terv', '+- első', '*** Add File: src/x.ts', '+export {}', '*** Update File: README.md', '@@', '-a', '+b', '*** End Patch'].join('\n');
	assert.deepEqual(patchAdds(patch).map(a => [a.path, a.content]), [['docs/PLAN.md', '# Terv\n- első'], ['src/x.ts', 'export {}']]);
	const found = artifactsFromSessionLines([
		codexCall({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: patch }),
		codexCall({ type: 'function_call', name: 'shell', call_id: 'c2', arguments: JSON.stringify({ command: ['bash', '-lc', `apply_patch <<'EOF'\n${patch.replace('PLAN.md', 'MASIK.md')}\nEOF`] }) }),
		codexCall({ type: 'function_call', name: 'shell', call_id: 'c3', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'] }) }),
	], 'codex');
	assert.deepEqual(found.map(f => [f.title, f.content]), [['PLAN.md', '# Terv\n- első'], ['MASIK.md', '# Terv\n- első']]);
});

test('in the room: versions in time order, an edit applied to the text before, a linked publish not twice, the same tool use kept once', () => {
	const room = newRoomState('Riport');
	const lines = [
		claudeTool('w1', 'Write', { file_path: '/p/NOTES.md', content: '# Jegyzet\nelső' }, '2026-11-15T10:00:00Z'),
		claudeTool('e1', 'Edit', { file_path: '/p/NOTES.md', old_string: 'első', new_string: 'második' }, '2026-11-15T10:05:00Z'),
		claudeTool('e2', 'Edit', { file_path: '/p/OTHER.md', old_string: 'a', new_string: 'b' }, '2026-11-15T10:06:00Z'),
		claudeTool('w2', 'Write', { file_path: '/p/r.html', content: '<h1>R</h1>' }, '2026-11-15T10:07:00Z'),
		claudeTool('p1', 'Artifact', { file_path: '/p/r.html' }, '2026-11-15T10:08:00Z'),
		claudeResult('p1', 'https://claude.ai/artifact/abc-123', '2026-11-15T10:09:00Z'),
	];
	room.produced = mergeProduced(undefined, artifactsFromSessionLines(lines, 'claude'));
	assert.equal(mergeProduced(room.produced, artifactsFromSessionLines(lines, 'claude')), undefined);
	room.messages.push({ id: 'm1', at: '2026-11-15T10:10:00Z', author: { kind: 'agent', id: 'claude', name: 'Claude' }, text: 'Kész: https://claude.ai/artifact/abc-123' });
	const list = roomArtifacts(room);
	const notes = list.find(a => a.title === 'NOTES.md')!;
	assert.deepEqual(notes.versions.map(v => v.content), ['# Jegyzet\nelső', '# Jegyzet\nmásodik']);
	assert.equal(notes.agentName, 'Claude');
	const other = list.find(a => a.title === 'OTHER.md')!;
	assert.deepEqual(other.versions.map(v => [v.content, v.language, v.path]), [['', 'file', '/p/OTHER.md']]);
	const page = list.find(a => a.title === 'r.html')!;
	assert.deepEqual(page.versions.map(v => [v.content, v.url]), [['<h1>R</h1>', 'https://claude.ai/artifact/abc-123']]);
	assert.equal(list.length, 3);
});

test('a room keeps what its turns, its followed session and its imported history produced', async () => {
	const write = claudeTool('w9', 'Write', { file_path: '/p/out.svg', content: '<svg/>' });
	const registry = new AgentRegistry();
	const agent: Agent = {
		id: 'claude', name: 'Claude', detail: 'local',
		readiness: async () => ({ ready: true }),
		turn: async (_input, onEvent) => { onEvent({ kind: 'line', line: write }); onEvent({ kind: 'text', text: 'ok' }); },
	};
	registry.register(agent);
	const room = new Room(newRoomState('R'), registry);
	await room.invite('claude');
	const seen: string[] = [];
	await room.say('rajzolj', (_a, e) => seen.push(e.kind), new AbortController().signal);
	assert.ok(!seen.includes('line'), 'raw lines are not shown');
	assert.deepEqual(room.state.produced?.map(p => p.title), ['out.svg']);

	const imported = importedRoomState({ id: 'claude', name: 'Claude' }, { id: 's1', title: 'S', updatedAt: '' }, { entries: [{ role: 'agent', text: 'kész', id: 'e1' }], cursor: 'c', lines: [write] });
	assert.deepEqual(imported.produced?.map(p => p.kind), ['image']);
	const followed = new Room(imported, registry);
	let touched = 0;
	followed.onDidChange(() => touched++);
	followed.followed('claude', [], 'c', undefined, [claudeTool('w10', 'Write', { file_path: '/p/b.md', content: '# B' })]);
	assert.deepEqual(followed.state.produced?.map(p => p.title), ['out.svg', 'b.md']);
	assert.equal(touched, 1);
});

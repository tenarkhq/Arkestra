/*---------------------------------------------------------------------------------------------
 *  Arkestra. Artifacts: found in agents' answers by kind and title, versions by title,
 *  unchanged repeats skipped, filters and pinned ones first, file extensions.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extensionFor, filterArtifacts, findInAnswer, roomArtifacts } from '../artifacts';
import type { Message, RoomState } from '../room';

const code = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n');

test('an answer\'s artifacts: diagram, document, page, svg and image links, long code; short code and logs are not', () => {
	const found = findInAnswer([
		'### Import folyamat',
		'```mermaid',
		'flowchart LR',
		'  A --> B',
		'```',
		'Itt a javaslat:',
		'```python schema.py',
		code(6),
		'```',
		'```ts',
		'short()',
		'```',
		'```console',
		code(8),
		'```',
		'```html',
		'<title>Termékoldal</title><h1>Hello</h1>',
		'```',
		'```markdown',
		'# Kiadási ellenőrzőlista',
		'- [ ] tesztek',
		'```',
		'![Képernyőkép](docs/shot.png)',
	].join('\n'));
	assert.deepEqual(found.map(f => [f.kind, f.title]), [
		['diagram', 'Import folyamat'],
		['code', 'schema.py'],
		['page', 'Termékoldal'],
		['document', 'Kiadási ellenőrzőlista'],
		['image', 'Képernyőkép'],
	]);
	assert.equal(found[1].language, 'python');
	assert.equal(findInAnswer('```mermaid\nunclosed').length, 0);
});

const msg = (id: string, author: 'agent' | 'user', name: string, text: string, at: string): Message =>
	({ id, at, author: { kind: author, id: name.toLowerCase(), name }, text });

test('the same title later is the next version; an unchanged repeat is not; user messages are not artifacts', () => {
	const room: RoomState = {
		id: 'r1', title: 'Stratégia JSON import', project: '/srv/x', roster: [], messages: [
			msg('1', 'agent', 'Claude', '### Import folyamat\n```mermaid\nflowchart LR\nA-->B\n```', '2026-11-14T13:52:00Z'),
			msg('2', 'user', 'You', '### Import folyamat\n```mermaid\nflowchart LR\nX-->Y\n```', '2026-11-14T13:55:00Z'),
			msg('3', 'agent', 'Claude', '### Import folyamat\n```mermaid\nflowchart LR\nA-->B-->C\n```', '2026-11-14T14:01:00Z'),
			msg('4', 'agent', 'Codex', '### Import folyamat\n```mermaid\nflowchart LR\nA-->B-->C\n```', '2026-11-14T14:03:00Z'),
			msg('5', 'agent', 'Codex', '`schema.py`\n```python\n' + code(5) + '\n```', '2026-11-14T13:58:00Z'),
		],
	};
	const list = roomArtifacts(room);
	assert.equal(list.length, 2);
	const diagram = list.find(a => a.kind === 'diagram')!;
	assert.deepEqual(diagram.versions.map(v => [v.n, v.messageId]), [[1, '1'], [2, '3']]);
	assert.equal(diagram.agentName, 'Claude');
	assert.equal(diagram.project, '/srv/x');
	assert.equal(list.find(a => a.kind === 'code')!.title, 'schema.py');
});

test('filters: project, kind, agent, search; pinned first, then newest', () => {
	const mk = (key: string, kind: 'code' | 'diagram', agentName: string, at: string, project = 'p1') =>
		({ key, kind, title: key, roomId: 'r', roomTitle: 'Room', project, agentId: agentName, agentName, versions: [{ n: 1, at, messageId: key, content: `body of ${key}` }] });
	const all = [mk('a', 'code', 'Claude', '2026-11-14T10:00:00Z'), mk('b', 'diagram', 'Codex', '2026-11-14T12:00:00Z'), mk('c', 'code', 'Claude', '2026-11-14T11:00:00Z', 'p2')];
	assert.deepEqual(filterArtifacts(all, {}, new Set()).map(a => a.key), ['b', 'c', 'a']);
	assert.deepEqual(filterArtifacts(all, {}, new Set(['a'])).map(a => a.key), ['a', 'b', 'c']);
	assert.deepEqual(filterArtifacts(all, {}, new Set(['a']), false).map(a => a.key), ['b', 'c', 'a']);
	assert.deepEqual(filterArtifacts(all, { kinds: ['code'] }, new Set()).map(a => a.key), ['c', 'a']);
	assert.deepEqual(filterArtifacts(all, { agents: ['Codex'] }, new Set()).map(a => a.key), ['b']);
	assert.deepEqual(filterArtifacts(all, { project: 'p2' }, new Set()).map(a => a.key), ['c']);
	assert.deepEqual(filterArtifacts(all, { query: 'BODY OF A' }, new Set()).map(a => a.key), ['a']);
});

test('a version is saved with its kind\'s extension', () => {
	assert.equal(extensionFor({ kind: 'diagram' }, {}), 'mmd');
	assert.equal(extensionFor({ kind: 'document' }, {}), 'md');
	assert.equal(extensionFor({ kind: 'page' }, {}), 'html');
	assert.equal(extensionFor({ kind: 'code' }, { language: 'python' }), 'py');
	assert.equal(extensionFor({ kind: 'code' }, { language: 'zig' }), 'txt');
	assert.equal(extensionFor({ kind: 'image' }, { language: 'svg' }), 'svg');
});

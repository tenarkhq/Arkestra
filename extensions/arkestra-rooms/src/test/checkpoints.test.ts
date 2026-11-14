/*---------------------------------------------------------------------------------------------
 *  Arkestra. Checkpoints and change acceptance in a real temporary workspace.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Checkpoints } from '../checkpoints';

async function workspace() {
	const root = await mkdtemp(path.join(tmpdir(), 'arkestra-cp-'));
	const ws = path.join(root, 'project');
	await mkdir(path.join(ws, 'src'), { recursive: true });
	await writeFile(path.join(ws, 'src', 'state.py'), 'def can_restart(s):\n    return True\n');
	await writeFile(path.join(ws, 'README.md'), 'hello\n');
	await writeFile(path.join(ws, '.gitignore'), 'build/\n');
	await mkdir(path.join(ws, 'build'));
	await writeFile(path.join(ws, 'build', 'out.js'), 'x');
	let t = 0;
	const cp = new Checkpoints(path.join(root, 'shadow.git'), ws, () => new Date(Date.UTC(2026, 10, 14, 13, 58 + t++)));
	return { ws, cp, read: (f: string) => readFile(path.join(ws, f), 'utf8'), exists: (f: string) => stat(path.join(ws, f)).then(() => true, () => false) };
}

test('a checkpoint is taken only when something changed; the first one is the accepted state', async () => {
	const { ws, cp } = await workspace();
	const first = await cp.take('r1', 'Start');
	assert.equal(first?.n, 1);
	assert.equal(await cp.take('r1', 'Again'), undefined, 'nothing changed');
	await writeFile(path.join(ws, 'src', 'state.py'), 'def can_restart(s):\n    return s.stopped_by != "human"\n');
	const second = await cp.take('r1', 'After Codex');
	assert.equal(second?.n, 2);
	const list = await cp.list('r1');
	assert.deepEqual(list.map(c => [c.n, c.label]), [[2, 'After Codex'], [1, 'Start']]);
	assert.equal(list[1].at, '2026-11-14T13:58:00.000Z');
	assert.deepEqual(await cp.list('other-room'), []);
});

test('changes since the accepted state: ignored files stay out, keep and discard work per file', async () => {
	const { ws, cp, read, exists } = await workspace();
	await cp.take('r1', 'Start');
	await writeFile(path.join(ws, 'src', 'state.py'), 'changed\n');
	await writeFile(path.join(ws, 'src', 'new.py'), 'new\n');
	await writeFile(path.join(ws, 'build', 'out.js'), 'ignored change');
	await writeFile(path.join(ws, 'README.md'), 'readme changed\n');
	assert.deepEqual(await cp.changes('r1'), [
		{ status: 'M', path: 'README.md' },
		{ status: 'A', path: 'src/new.py' },
		{ status: 'M', path: 'src/state.py' },
	]);
	await cp.keep('r1', ['src/state.py']);
	await cp.discard('r1', ['README.md', 'src/new.py']);
	assert.deepEqual(await cp.changes('r1'), []);
	assert.equal(await read('src/state.py'), 'changed\n');
	assert.equal(await read('README.md'), 'hello\n');
	assert.equal(await exists('src/new.py'), false);
	assert.equal(await cp.acceptedContent('r1', 'src/state.py'), 'changed\n');
	assert.equal(await cp.acceptedContent('r1', 'src/new.py'), undefined);
});

test('a deleted file can be kept deleted or brought back', async () => {
	const { ws, cp, exists } = await workspace();
	await cp.take('r1', 'Start');
	execFileSync('rm', [path.join(ws, 'README.md'), path.join(ws, 'src', 'state.py')]);
	assert.deepEqual((await cp.changes('r1')).map(c => c.status + c.path), ['DREADME.md', 'Dsrc/state.py']);
	await cp.discard('r1', ['README.md']);
	await cp.keep('r1', ['src/state.py']);
	assert.equal(await exists('README.md'), true);
	assert.deepEqual(await cp.changes('r1'), []);
});

test('restore brings the workspace back, takes a checkpoint first, and can be undone', async () => {
	const { ws, cp, read, exists } = await workspace();
	const start = (await cp.take('r1', 'Start'))!;
	await writeFile(path.join(ws, 'src', 'state.py'), 'v2\n');
	await writeFile(path.join(ws, 'src', 'added.py'), 'added\n');
	await cp.take('r1', 'After Claude');
	const before = await cp.restore('r1', start, 'Before restore');
	assert.equal(before, undefined, 'the state was already the last checkpoint');
	assert.equal(await read('src/state.py'), 'def can_restart(s):\n    return True\n');
	assert.equal(await exists('src/added.py'), false);
	assert.deepEqual(await cp.changes('r1'), [], 'the restored state is the accepted one');
	// Undo: restore the checkpoint taken after Claude.
	const after = (await cp.list('r1')).find(c => c.label === 'After Claude')!;
	await writeFile(path.join(ws, 'README.md'), 'edited after restore\n');
	const undoPoint = await cp.restore('r1', after, 'Before restore');
	assert.equal(undoPoint?.label, 'Before restore');
	assert.equal(await read('src/state.py'), 'v2\n');
	assert.equal(await read('src/added.py'), 'added\n');
	assert.equal(await read('README.md'), 'hello\n');
	assert.equal(execFileSync('ls', ['-a', ws], { encoding: 'utf8' }).includes('.git\n'), false, 'the project gets no .git of ours');
});

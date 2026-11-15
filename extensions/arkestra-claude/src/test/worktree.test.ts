/*---------------------------------------------------------------------------------------------
 *  Arkestra. A session folder's git changes, as the apps count them.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseWorktree, worktreeScript } from '../worktree';

test('changed files with their lines, binaries without, new files marked', () => {
	assert.deepEqual(parseWorktree('12\t3\tsrc/a.ts\n-\t-\tlogo.png\n?\t?\tnotes/new.md\nnoise\n'), [
		{ path: 'src/a.ts', status: 'M', added: 12, removed: 3 },
		{ path: 'logo.png', status: 'M' },
		{ path: 'notes/new.md', status: '?' },
	]);
});

test('the script stays out of a folder that is gone, and of a Mac git stub', () => {
	const s = worktreeScript("/w/it's here");
	assert.match(s, /^cd '\/w\/it'"'"'s here' 2>\/dev\/null \|\| exit 0/);
	assert.match(s, /xcode-select -p/);
});

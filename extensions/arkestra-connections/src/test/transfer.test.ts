/*---------------------------------------------------------------------------------------------
 *  Arkestra. File transfer over SSH against a fake `ssh` that runs the remote script locally:
 *  uploads of files and folders keep their layout, listings, drops typed into a terminal.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Machine } from '../ssh';
import { droppedPaths, groupByParent, joinRemote, listRemote, parseListing, shellArgs, shellWords, untarScript, upload, uploadedPaths } from '../transfer';

const FAKE_SSH = `#!/bin/sh
while [ $# -gt 1 ]; do
  case "$1" in -o|-p) shift 2 ;; -*) shift ;; *) break ;; esac
done
host="$1"; shift
if [ "$host" = down ]; then echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255; fi
exec sh -c "$*"
`;

async function setup() {
	const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'arkestra-xfer-')));
	await mkdir(path.join(dir, 'bin'));
	await writeFile(path.join(dir, 'bin', 'ssh'), FAKE_SSH);
	await chmod(path.join(dir, 'bin', 'ssh'), 0o755);
	await mkdir(path.join(dir, 'home'), { recursive: true });
	process.env.HOME = path.join(dir, 'home');
	return { dir, ssh: path.join(dir, 'bin', 'ssh') };
}

test('shell words and drops: quoted paths, bracketed paste, only existing absolute paths count', () => {
	assert.deepEqual(shellWords(`'/a b/c.txt' "/d \\"e\\"" /f\\ g plain`), ['/a b/c.txt', '/d "e"', '/f g', 'plain']);
	const exists = (p: string) => ['/a b/c.txt', '/srv/x'].includes(p);
	assert.deepEqual(droppedPaths(`\u001b[200~'/a b/c.txt' /srv/x \u001b[201~`, exists), ['/a b/c.txt', '/srv/x']);
	assert.equal(droppedPaths('ls -la', exists), undefined, 'typing is not a drop');
	assert.equal(droppedPaths('/srv/x /nope', exists), undefined, 'every word must exist');
	assert.equal(droppedPaths('/srv/x\r', exists), undefined, 'a line with Enter is typed, not dropped');
	assert.equal(droppedPaths('a', exists), undefined);
});

test('remote paths, listings, groups and the shell command', () => {
	assert.equal(joinRemote('~', 'a.txt'), '~/a.txt');
	assert.equal(joinRemote('/srv/app/', 'a.txt'), '/srv/app/a.txt');
	assert.equal(untarScript('~/my project'), `mkdir -p "$HOME"/'my project' && tar -C "$HOME"/'my project' -xf -`);
	assert.deepEqual(parseListing('b.txt\nsrc/\n./\n../\n.env\nA/\n'), [{ name: 'A', folder: true }, { name: 'src', folder: true }, { name: '.env', folder: false }, { name: 'b.txt', folder: false }]);
	assert.deepEqual(groupByParent(['/x/a', '/y/b', '/x/c']), [{ parent: '/x', names: ['a', 'c'] }, { parent: '/y', names: ['b'] }]);
	assert.equal(uploadedPaths(['/x/my file.txt', '/y/b'], '~/up'), `~/'up/my file.txt' ~/up/b`);
	const args = shellArgs({ id: 'dev', name: 'dev', host: 'dev', port: 2222 }, '~/app', { columns: 120, rows: 30 });
	assert.deepEqual(args.slice(0, 4), ['-tt', '-p', '2222', 'dev']);
	assert.match(args[4], /stty rows 30 cols 120.*cd "\$HOME"\/app \|\| exit 98; exec "\$\{SHELL:-sh\}" -l/);
});

test('an upload over ssh: files and a folder from two places arrive with their layout; the folder is listed', async () => {
	const { dir, ssh } = await setup();
	const local = path.join(dir, 'local');
	await mkdir(path.join(local, 'site', 'css'), { recursive: true });
	await mkdir(path.join(dir, 'other'), { recursive: true });
	await writeFile(path.join(local, 'site', 'index.html'), '<h1>hi</h1>');
	await writeFile(path.join(local, 'site', 'css', 'a.css'), 'body{}');
	await writeFile(path.join(local, 'notes one.txt'), 'notes');
	await writeFile(path.join(dir, 'other', 'b.txt'), 'b');
	const machine: Machine = { id: 'dev', name: 'dev', host: 'dev' };
	await upload(machine, [path.join(local, 'site'), path.join(local, 'notes one.txt'), path.join(dir, 'other', 'b.txt')], '~/deploy/new', { ssh });
	const remote = path.join(dir, 'home', 'deploy', 'new');
	assert.equal(await readFile(path.join(remote, 'site', 'css', 'a.css'), 'utf8'), 'body{}');
	assert.equal(await readFile(path.join(remote, 'notes one.txt'), 'utf8'), 'notes');
	assert.equal(await readFile(path.join(remote, 'b.txt'), 'utf8'), 'b');
	assert.deepEqual(await listRemote(machine, '~/deploy/new', { ssh }), [{ name: 'site', folder: true }, { name: 'b.txt', folder: false }, { name: 'notes one.txt', folder: false }]);
	await assert.rejects(upload({ ...machine, host: 'down' }, [path.join(dir, 'other', 'b.txt')], '~/x', { ssh }), /Connection refused/);
	await assert.rejects(listRemote(machine, '~/nope', { ssh }));
	assert.ok(existsSync(remote));
});

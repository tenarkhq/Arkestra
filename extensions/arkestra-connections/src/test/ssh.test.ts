/*---------------------------------------------------------------------------------------------
 *  Arkestra. Remote CLI runs against a fake `ssh` that executes the remote command locally,
 *  so the script, quoting, environment line and stdin are exercised end to end.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { newMachineId, readMachines, sshConfigHosts } from '../machines';
import { envLine, probe, remotePath, remoteSpawn, shQuote, sshTerminalArgs, type Machine } from '../ssh';

// ssh [options] host command: run the command with sh like sshd would; exit 255 for host "down".
const FAKE_SSH = `#!/bin/sh
while [ $# -gt 1 ]; do
  case "$1" in -o|-p) shift 2 ;; -*) shift ;; *) break ;; esac
done
host="$1"; shift
if [ "$host" = down ]; then echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255; fi
exec sh -c "$*"
`;

// A CLI that reports what it got: args, cwd, forwarded env, and its stdin.
const FAKE_CLI = `#!/bin/sh
printf 'args:'; for a in "$@"; do printf ' [%s]' "$a"; done; echo
echo "cwd: $(pwd)"
echo "anthropic: \${ANTHROPIC_API_KEY-unset}"
echo "openai: \${OPENAI_API_KEY-unset}"
echo "codex_home: \${CODEX_HOME-unset}"
echo "stdin: $(cat)"
`;

async function setup() {
	const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'arkestra-conn-')));
	const bin = path.join(dir, 'bin');
	await mkdir(bin);
	await mkdir(path.join(dir, 'home', 'my project'), { recursive: true });
	for (const [name, body] of [['ssh', FAKE_SSH], ['claude', FAKE_CLI], ['codex', FAKE_CLI]]) {
		await writeFile(path.join(bin, name), body);
		await chmod(path.join(bin, name), 0o755);
	}
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.HOME = path.join(dir, 'home');
	return { dir, ssh: path.join(bin, 'ssh') };
}

const run = (child: import('node:child_process').ChildProcess) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
	let out = '';
	let err = '';
	child.stdout?.on('data', c => { out += c; });
	child.stderr?.on('data', c => { err += c; });
	child.on('close', code => resolve({ code, out, err }));
});

test('a remote run keeps arguments intact, cds into the folder and forwards only the agent keys', async () => {
	const { dir, ssh } = await setup();
	const machine: Machine = { id: 'dev', name: 'dev', host: 'dev', folder: '~/my project' };
	process.env.OPENAI_API_KEY = 'remote-shell-value';
	const spawn = remoteSpawn(machine, { ssh });
	const child = spawn('claude', ['-p', 'it\'s "quoted" $HOME `x`', '--model', 'opus'], {
		env: { ANTHROPIC_API_KEY: 'sk-ant-1', CODEX_HOME: '~/.arkestra/codex-home' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const { code, out } = await run(child);
	delete process.env.OPENAI_API_KEY;
	assert.equal(code, 0);
	assert.ok(out.includes('args: [-p] [it\'s "quoted" $HOME `x`] [--model] [opus]'), out);
	assert.ok(out.includes(`cwd: ${path.join(dir, 'home', 'my project')}`), out);
	assert.ok(out.includes('anthropic: sk-ant-1'));
	assert.ok(out.includes('openai: unset'), 'a variable the agent cleared is cleared on the remote too');
	assert.ok(out.includes(`codex_home: ${path.join(dir, 'home', '.arkestra', 'codex-home')}`));
	assert.ok(out.includes('stdin: \n') || out.trimEnd().endsWith('stdin:'), 'stdin "ignore" reaches the CLI as empty');
});

test('a dropped connection stops a CLI that does not read stdin', async () => {
	const { ssh } = await setup();
	const child = remoteSpawn({ id: 'dev', name: 'dev', host: 'dev' }, { ssh })('sleep', ['30'], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
	const started = Date.now();
	setTimeout(() => child.stdin!.end(), 300); // what sshd does when the client goes away
	const { code } = await run(child);
	assert.equal(code, 143);
	assert.ok(Date.now() - started < 5000);
});

test('stdin after the environment line belongs to the CLI (stdio protocols work)', async () => {
	const { ssh } = await setup();
	const child = remoteSpawn({ id: 'dev', name: 'dev', host: 'dev' }, { ssh })('codex', ['app-server'], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
	child.stdin!.write('{"id":1,"method":"initialize"}\n');
	child.stdin!.end();
	const { out } = await run(child);
	assert.ok(out.includes('stdin: {"id":1,"method":"initialize"}'), out);
	assert.ok(out.includes('args: [app-server]'));
});

test('probe lists the agent CLIs on the machine, or says why it cannot connect', async () => {
	const { ssh } = await setup();
	assert.deepEqual(await probe({ id: 'dev', name: 'dev', host: 'dev' }, { ssh }), { reachable: true, clis: ['claude', 'codex'] });
	assert.deepEqual(await probe({ id: 'x', name: 'x', host: 'down' }, { ssh }), { reachable: false, clis: [], error: 'ssh: connect to host down port 22: Connection refused' });
});

test('a sign-in terminal runs the command in the machine folder with a TTY', () => {
	assert.deepEqual(sshTerminalArgs({ id: 'dev', name: 'dev', host: 'dev@srv', port: 2222, folder: '~/app' }, 'codex', ['login', '--device-auth']),
		['-t', '-p', '2222', 'dev@srv', `sh -lc 'cd "$HOME"/app || exit 98\nexec codex login --device-auth'`]);
});

test('quoting, remote paths and the environment line', () => {
	assert.equal(shQuote('plain-arg'), 'plain-arg');
	assert.equal(shQuote('it\'s'), `'it'\\''s'`);
	assert.equal(remotePath('~/a b'), `"$HOME"/'a b'`);
	assert.equal(remotePath('/srv/app'), '/srv/app');
	const decoded = Buffer.from(envLine({ ANTHROPIC_API_KEY: 'k\'1' }), 'base64').toString();
	assert.ok(decoded.includes(`export ANTHROPIC_API_KEY='k'\\''1'`));
	assert.ok(decoded.includes('unset OPENAI_API_KEY'));
	assert.ok(!decoded.includes('PATH'), 'nothing outside the agent keys is sent');
});

test('machine list: broken entries skipped, ids unique, ssh config aliases read', () => {
	assert.deepEqual(readMachines([{ id: 'dev', host: 'dev@srv', folder: ' ~/app ' }, { id: 'local', host: 'x' }, { id: 'bad id', host: 'x' }, { id: 'dev', host: 'y' }, null, 'x']),
		[{ id: 'dev', name: 'dev@srv', host: 'dev@srv', folder: '~/app' }]);
	assert.equal(newMachineId('Dev szerver', []), 'dev-szerver');
	assert.equal(newMachineId('Dev szerver', [{ id: 'dev-szerver', name: '', host: 'h' }]), 'dev-szerver-2');
	assert.equal(newMachineId('Építő gép', []), 'epito-gep');
	assert.deepEqual(sshConfigHosts('Host *\nHost dev prod\n  HostName 10.0.0.1\nhost 2ark\nHost !x *.lan'), ['dev', 'prod', '2ark']);
});

/*---------------------------------------------------------------------------------------------
 *  Arkestra. A connection from the pages' own forms (no input box at the top): a new one gets
 *  an id, an edited one keeps it, the port after a colon, what is wrong names its field. The
 *  Connections page's rows and its script; walking an SSH machine's folders upwards.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { connectionFromForm } from '../machines';
import { connectionsPage, pageRows, type PageStrings } from '../page';
import { remoteParent } from '../transfer';
import type { Machine } from '../ssh';

const t = { hostRequired: 'host?', hostInvalid: 'bad host', portInvalid: 'bad port', nameTaken: 'taken' };
const list: Machine[] = [{ id: 'tenark', name: 'tenark', host: 'tenark@srv' }, { id: 'dev', name: 'Dev box', host: 'dev', port: 2222, folder: '~/app' }];

test('a new connection from the form: an id from its name, the name from the host when empty, the port split off', () => {
	assert.deepEqual(connectionFromForm({ host: ' roland@build.example.com:2200 ', name: '', folder: ' ~/src ' }, list, t), {
		machine: { id: 'build-example-com', name: 'build.example.com', host: 'roland@build.example.com', port: 2200, folder: '~/src' },
	});
	assert.deepEqual(connectionFromForm({ host: 'tenark-claude@srv', name: 'Tenark Claude' }, list, t), {
		machine: { id: 'tenark-claude', name: 'Tenark Claude', host: 'tenark-claude@srv' },
	});
});

test('an edited connection keeps its id (its threads keep their agents); its own name is not taken', () => {
	assert.deepEqual(connectionFromForm({ host: 'dev', name: 'Dev box', folder: '' }, list, t, 'dev'), { machine: { id: 'dev', name: 'Dev box', host: 'dev' } });
	assert.deepEqual(connectionFromForm({ host: 'dev:22', name: 'tenark' }, list, t, 'dev'), { field: 'name', message: 'taken' });
});

test('what is wrong names its field: no host, a host with spaces or an option, a bad port, a name in use', () => {
	assert.deepEqual(connectionFromForm({ host: '  ' }, list, t), { field: 'host', message: 'host?' });
	assert.deepEqual(connectionFromForm({ host: 'a b' }, list, t), { field: 'host', message: 'bad host' });
	assert.deepEqual(connectionFromForm({ host: '-oProxyCommand=x' }, list, t), { field: 'host', message: 'bad host' });
	assert.deepEqual(connectionFromForm({ host: 'srv:' }, list, t), { field: 'host', message: 'bad port' });
	assert.deepEqual(connectionFromForm({ host: 'srv:70000' }, list, t), { field: 'host', message: 'bad port' });
	assert.deepEqual(connectionFromForm({ host: 'x@y', name: 'dev BOX' }, list, t), { field: 'name', message: 'taken' });
	assert.deepEqual(connectionFromForm({ host: 42 } as never, list, t), { field: 'host', message: 'host?' });
});

test('the Connections page: this machine first, each row with its check; the form and the row confirm are the page\'s own', () => {
	const rows = pageRows(list, new Map<string, 'checking' | { reachable: boolean; clis: string[]; error?: string }>([
		['local', { reachable: true, clis: ['claude', 'codex'] }], ['tenark', 'checking'], ['dev', { reachable: false, clis: [], error: 'timed out' }],
	]), { thisMachine: 'This machine', local: 'local', checking: 'checking…', reachable: 'reachable', unreachable: 'unreachable' });
	assert.deepEqual(rows.map(r => [r.id, r.name, r.access, r.state, r.text, r.clis.join(','), r.removable]), [
		['local', 'This machine', 'local', 'ok', 'reachable', 'claude,codex', false],
		['tenark', 'tenark', 'ssh · tenark@srv', 'checking', 'checking…', '', true],
		['dev', 'Dev box', 'ssh · dev:2222 · ~/app', 'bad', 'timed out', '', true],
	]);
	const strings = new Proxy({}, { get: (_x, k) => k === 'title' ? 'Conn<ections>' : String(k) }) as unknown as PageStrings;
	const html = connectionsPage('N', strings);
	assert.match(html, /default-src 'none'; style-src 'nonce-N'; script-src 'nonce-N';/);
	assert.ok(html.includes('<h1>Conn&lt;ections&gt;</h1>'));
	assert.ok(html.includes('<form id="add" hidden novalidate>') && html.includes('list="hosts"'));
	const script = [...html.matchAll(/<script nonce="N">([\s\S]*?)<\/script>/g)].map(m => m[1]);
	assert.equal(script.length, 1);
	assert.doesNotThrow(() => new Script(script[0]));
	assert.ok(script[0].includes("type: 'save', host: v.host"));
	assert.ok(script[0].includes("act === 'removeYes'") && script[0].includes("type: 'remove', id"));
});

test('one folder up on an SSH machine: the home through .., an absolute path by its parent, nothing above /', () => {
	assert.equal(remoteParent('~'), '~/..');
	assert.equal(remoteParent('~/app/src'), '~/app/src/..');
	assert.equal(remoteParent('/srv/app/'), '/srv');
	assert.equal(remoteParent('/srv'), '/');
	assert.equal(remoteParent('/'), undefined);
});

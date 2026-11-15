/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Machines page: machines in order, sessions of all agents newest first, the
 *  connection states, the filters, and a page that is locked down and whose script compiles.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { machinesHtml, type MachinesStrings } from '../machinesHtml';
import { notInstalled } from '../agentErrors';
import { agentKind, agentLabel, canList, connectionState, defaultFolder, machineOf, machinesModel, readMachineEntries, relativeTime, sessionKey, sessionMatches, type Listing } from '../machinesModel';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const labels = { thisMachine: 'This machine', local: 'roland@mac' };
const machines = [
	{ id: 'tenark', name: 'tenark', host: 'tenark@srv', folder: '~/tenark-dev' },
	{ id: 'tenark-claude', name: 'tenark-claude', host: 'tenark-claude@srv:2222' },
];
const agents = [
	{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' },
	{ id: 'claude@tenark', name: 'Claude · tenark' }, { id: 'codex@tenark', name: 'Codex · tenark' },
	{ id: 'claude@tenark-claude', name: 'Claude · tenark-claude' }, { id: 'codex@tenark-claude', name: 'Codex · tenark-claude' },
];

test('the setting is read like the Connections extension does, with the port on the address', () => {
	assert.deepEqual(readMachineEntries([
		{ id: 'a', host: ' u@h ', port: 2222, folder: ' ~/app ' }, { id: 'a', host: 'dup' }, { id: 'local', host: 'x' }, { id: 'bad id', host: 'x' }, { id: 'b', name: 'B', host: '' }, null, { id: 'c', name: ' Cé ', host: 'c', folder: ' ' },
	]), [{ id: 'a', name: 'u@h', host: 'u@h:2222', folder: '~/app' }, { id: 'c', name: 'Cé', host: 'c' }]);
	assert.deepEqual(readMachineEntries(undefined), []);
});

test('an agent id names its machine and kind; its name without the machine is its badge', () => {
	assert.equal(machineOf('claude'), 'local');
	assert.equal(machineOf('codex@tenark-codex'), 'tenark-codex');
	assert.equal(agentKind('claude@x'), 'claude');
	assert.equal(agentKind('codex'), 'codex');
	assert.equal(agentKind('gemini@x'), 'other');
	assert.equal(agentLabel('Codex · tenark'), 'Codex');
	assert.equal(sessionKey('codex@a', 's1'), 'codex@a\ns1');
});

test('relative times in the user\'s language', () => {
	assert.equal(relativeTime('2026-11-15T11:55:00Z', NOW, 'en'), '5 minutes ago');
	assert.equal(relativeTime('2026-11-15T09:00:00Z', NOW, 'en'), '3 hours ago');
	assert.equal(relativeTime('2026-11-14T12:00:00Z', NOW, 'en'), 'yesterday');
	assert.equal(relativeTime('2026-11-15T11:59:40Z', NOW, 'en'), 'now');
	assert.match(relativeTime('2026-10-01T12:00:00Z', NOW, 'en'), /2026/);
	assert.equal(relativeTime('', NOW, 'en'), '');
	assert.equal(relativeTime('nonsense', NOW, 'en'), '');
});

test('connection states: this machine always connected, a check keeps its last answer, refusals are errors', () => {
	assert.deepEqual(connectionState(true, undefined), { state: 'connected' });
	assert.deepEqual(connectionState(false, undefined), { state: 'connecting' });
	assert.deepEqual(connectionState(false, { checking: true }), { state: 'connecting' });
	assert.deepEqual(connectionState(false, { checking: false, result: { reachable: true } }), { state: 'connected' });
	// A check running again shows the last answer, so the dot does not blink every half minute.
	assert.deepEqual(connectionState(false, { checking: true, result: { reachable: true } }), { state: 'connected' });
	assert.deepEqual(connectionState(false, { checking: false, result: 'unknown' }), { state: 'unknown' });
	for (const reason of ['Connection timed out', 'ssh: connect to host srv port 22: Connection refused', 'ssh: Could not resolve hostname srv: nodename nor servname provided, or not known', 'ssh: connect to host 10.0.0.2 port 22: No route to host', 'kex_exchange_identification: read: Connection reset by peer', 'ssh: connect to host srv port 22: Operation timed out']) {
		assert.deepEqual(connectionState(false, { checking: false, result: { reachable: false, error: reason } }), { state: 'unreachable', reason }, reason);
	}
	assert.deepEqual(connectionState(false, { checking: false, result: { reachable: false } }), { state: 'unreachable' });
	for (const reason of ['tenark@srv: Permission denied (publickey).', 'Host key verification failed.', 'spawn ssh ENOENT', 'sh exited with 127']) {
		assert.deepEqual(connectionState(false, { checking: false, result: { reachable: false, error: reason } }), { state: 'error', reason }, reason);
	}
	assert.equal(canList({ state: 'connected' }), true);
	assert.equal(canList({ state: 'unknown' }), true);
	assert.equal(canList({ state: 'connecting' }), false);
	assert.equal(canList({ state: 'unreachable' }), false);
	assert.equal(canList({ state: 'error', reason: 'x' }), false);
});

test('the default folder: the set one on the real home, else the home', () => {
	assert.equal(defaultFolder(undefined, undefined), '~');
	assert.equal(defaultFolder('', '/home/u'), '/home/u');
	assert.equal(defaultFolder('~', '/home/u'), '/home/u');
	assert.equal(defaultFolder('~/app', '/home/u/'), '/home/u/app');
	assert.equal(defaultFolder('~/app', undefined), '~/app');
	assert.equal(defaultFolder('/srv/app', '/home/u'), '/srv/app');
});

test('this machine first, then the SSH machines; each lists all its agents\' sessions newest first', () => {
	const listings = new Map<string, Listing>([
		['claude', { state: 'ok', sessions: [{ id: 'c1', title: 'Old fix', cwd: '/Users/r/app/', updatedAt: '2026-11-14T12:00:00Z' }] }],
		['codex', { state: 'ok', sessions: [{ id: 'x1', title: 'Codex work', cwd: '/Users/r/site', updatedAt: '2026-11-15T11:00:00Z' }, { id: 'x2', title: '', updatedAt: '' }] }],
		['claude@tenark', { state: 'loading' }],
		['codex@tenark', { state: 'ok', sessions: [] }],
		['claude@tenark-claude', { state: 'error', message: 'ssh: Permission denied' }],
		['codex@tenark-claude', { state: 'ok', sessions: [{ id: 'y', title: 'Remote', cwd: '/home/u/p', updatedAt: '2026-11-15T10:00:00Z' }] }],
	]);
	const model = machinesModel({
		machines, agents, listings, continued: new Map([[sessionKey('claude', 'c1'), 'room-7']]),
		connections: new Map([['tenark', { checking: false, result: { reachable: true, home: '/home/tenark' }, at: NOW - 120_000 }]]),
		labels, localFolder: '/Users/r/app', now: NOW, language: 'en',
	});
	assert.deepEqual(model.machines.map(m => [m.id, m.name, m.host, m.state, m.connection.state]), [
		['local', 'This machine', 'roland@mac', 'ok', 'connected'],
		['tenark', 'tenark', 'tenark@srv', 'loading', 'connected'],
		['tenark-claude', 'tenark-claude', 'tenark-claude@srv:2222', 'partial', 'connecting'],
	]);
	assert.deepEqual(model.machines.map(m => [m.folder, m.checked, m.configured]), [
		['/Users/r/app', '', false],
		['/home/tenark/tenark-dev', '2 minutes ago', true],
		['~', '', true],
	]);
	assert.deepEqual(model.machines.map(m => m.counts.map(k => `${k.agent} ${k.n}`)), [['Claude 1', 'Codex 2'], ['Codex 0'], ['Codex 1']]);
	const local = model.machines[0];
	assert.deepEqual(local.sessions.map(s => [s.title, s.kind, s.agent, s.folder, s.when, s.thread]), [
		['Codex work', 'codex', 'Codex', 'site', '1 hour ago', undefined],
		['Old fix', 'claude', 'Claude', 'app', 'yesterday', 'room-7'],
		['x2', 'codex', 'Codex', '', '', undefined],
	]);
	assert.deepEqual(model.machines[2].errors, [{ agent: 'Claude', message: 'ssh: Permission denied', missing: false }]);
	assert.deepEqual(model.machines[2].sessions.map(s => s.key), ['codex@tenark-claude\ny']);
});

test('a machine nobody asked yet is idle, one without agents has none, an agent on an unknown machine adds it', () => {
	const model = machinesModel({
		machines: [{ id: 'empty', name: 'Empty', host: 'e@h' }], agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex@gone', name: 'Codex · Gone box' }],
		listings: new Map([['codex@gone', { state: 'error', message: 'down' }]]), continued: new Map(), connections: new Map(), labels, localFolder: '/Users/r', now: NOW, language: 'en',
	});
	assert.deepEqual(model.machines.map(m => [m.id, m.name, m.state, m.configured]), [['local', 'This machine', 'idle', false], ['empty', 'Empty', 'none', true], ['gone', 'Gone box', 'error', false]]);
});

test('the filters: agent kind, machine, and the search over title and folder', () => {
	const s = { kind: 'codex', title: 'Fix the Login', cwd: '/srv/tenark-x' };
	assert.equal(sessionMatches(s, 'local', { agent: '', machine: '', query: '' }), true);
	assert.equal(sessionMatches(s, 'local', { agent: 'claude', machine: '', query: '' }), false);
	assert.equal(sessionMatches(s, 'local', { agent: 'codex', machine: 'tenark', query: '' }), false);
	assert.equal(sessionMatches(s, 'tenark', { agent: '', machine: 'tenark', query: ' login ' }), true);
	assert.equal(sessionMatches(s, 'tenark', { agent: '', machine: '', query: 'TENARK-X' }), true);
	assert.equal(sessionMatches(s, 'tenark', { agent: '', machine: '', query: 'nope' }), false);
});

test('the page runs only its own nonce, shows its strings escaped and its script compiles', () => {
	const keys = ['title', 'subtitle', 'search', 'refresh', 'connections', 'agent', 'machine', 'all', 'claude', 'codex', 'openThread', 'continueHere', 'loading', 'noSessions', 'noAgent', 'noMatch', 'couldNotRead', 'notInstalled', 'oneSession', 'nSessions', 'connected', 'connecting', 'unreachable', 'connectionError', 'unknown', 'localTip', 'reconnect', 'unreachableNote', 'connectingNote', 'checked', 'folder', 'openFolder', 'edit', 'remove', 'removeAsk', 'removeYes', 'cancel', 'addConnection', 'host', 'hostHint', 'name', 'nameHint', 'folderField', 'folderHint', 'save', 'folderUp', 'terminalHere', 'readingFolders', 'noFolders', 'couldNotReadFolder'];
	const strings = Object.fromEntries(keys.map(k => [k, k === 'title' ? 'Ma<b>chines</b> "x"' : k])) as unknown as MachinesStrings;
	const html = machinesHtml('NONCE123', strings, { base: 'vscode-resource://fonts', cspSource: 'vscode-resource:' });
	assert.match(html, /default-src 'none'; style-src 'nonce-NONCE123'; font-src vscode-resource:; script-src 'nonce-NONCE123';/);
	assert.ok(html.includes('Ma&lt;b&gt;chines&lt;/b&gt; &quot;x&quot;'));
	assert.ok(!html.includes('<b>chines</b>'));
	assert.ok(html.includes('@font-face'));
	const data = /<script type="application\/json" id="l10n" nonce="NONCE123">([^<]*)<\/script>/.exec(html);
	assert.ok(data);
	assert.equal(JSON.parse(data[1]).title, 'Ma<b>chines</b> "x"');
	const scripts = [...html.matchAll(/<script nonce="NONCE123">([\s\S]*?)<\/script>/g)].map(m => m[1]);
	assert.equal(scripts.length, 1);
	assert.doesNotThrow(() => new Script(scripts[0]));
	assert.ok(scripts[0].includes('function sessionMatches(') && scripts[0].includes('function canList('), 'the page filters with the tested functions');
});

test('connections are added and edited in the page\'s own form, and an SSH machine\'s folders are walked in its card', () => {
	const keys = ['addConnection', 'host', 'save', 'terminalHere', 'folderUp'];
	const strings = new Proxy({}, { get: (_t, k) => typeof k === 'string' ? (keys.includes(k) ? `«${k}»` : k) : undefined }) as unknown as MachinesStrings;
	const html = machinesHtml('N', strings);
	// The header's New SSH connection and the card's Edit open the form; no command prompts at the top.
	assert.ok(html.includes('id="addConn"') && html.includes('+ «addConnection»'));
	const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(html)![1];
	assert.doesNotThrow(() => new Script(script));
	assert.ok(script.includes("type: 'saveConnection', machine: editing.id"));
	assert.ok(script.includes("act === 'edit' && m) { openForm(id, m); }"));
	assert.ok(!script.includes("post({ type: 'edit'"), 'Edit no longer goes to a command that asks at the top');
	// Open a folder on an SSH machine lists its folders in the card, the terminal opens where it stands.
	assert.ok(script.includes("type: 'browse', machine: id, dir: ''"));
	assert.ok(script.includes("type: 'terminalAt', machine: id, dir: browsing.dir"));
	// What is typed survives the page's redraws (the checks every half minute).
	assert.ok(script.includes('editing[f] = e.target.value') && script.includes('setSelectionRange'));
});

test('the edit form starts from the connection as it is set, not from the resolved folder', () => {
	const model = machinesModel({
		machines: readMachineEntries(machines), agents: [], listings: new Map(), continued: new Map(),
		connections: new Map([['tenark', { checking: false, result: { reachable: true, home: '/home/tenark' }, at: NOW }]]), labels, localFolder: '/Users/roland/p', now: NOW, language: 'en',
	});
	assert.deepEqual(model.machines.map(m => [m.id, m.host, m.folder, m.setFolder]), [
		['local', 'roland@mac', '/Users/roland/p', ''],
		['tenark', 'tenark@srv', '/home/tenark/tenark-dev', '~/tenark-dev'],
		['tenark-claude', 'tenark-claude@srv:2222', '~', ''],
	]);
});

test('the page binds its embedded functions to their names: the shipped bundle renames function declarations', () => {
	const strings = new Proxy({}, { get: (_t, k) => typeof k === 'string' ? k : undefined }) as unknown as MachinesStrings;
	const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(machinesHtml('N', strings))![1];
	assert.match(script, /const sessionMatches = function \w*\(/);
	assert.match(script, /const canList = function \w*\(/);
});

test('an agent that is only not installed on a machine is a quiet fact there, not a failure; counts say what they count', () => {
	const strings = new Proxy({}, { get: (_t, k) => typeof k === 'string' ? k : undefined }) as unknown as MachinesStrings;
	const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(machinesHtml('N', strings))![1];
	assert.ok(script.includes("e.missing ? note(S.notInstalled"), 'a missing agent is a note');
	assert.ok(script.includes('S.oneSession : S.nSessions'), 'the count chip names sessions');
	assert.equal(notInstalled('Codex is not installed on tenark-claude. Install it there or choose another machine.'), true);
	assert.equal(notInstalled('Codex is not installed on this computer. Install it or connect a machine that has it.'), true);
	assert.equal(notInstalled('ssh: Permission denied'), false);
});

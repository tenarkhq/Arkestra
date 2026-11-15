/*---------------------------------------------------------------------------------------------
 *  Arkestra. A new ACP agent from the page's own form: the registry's agents and a command of
 *  one's own, the machine only when there are SSH machines, the setting's entry from the values.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { addFormEntry, addFormSpec, type AddFormStrings } from '../addForm';
import type { RegistryAgent } from '../registry';

const t = new Proxy({}, { get: (_x, k) => k === 'needs' ? 'needs {0}' : String(k) }) as unknown as AddFormStrings;
const registry: RegistryAgent[] = [
	{ id: 'gemini', name: 'Gemini CLI', command: 'npx', args: ['@google/gemini-cli', '--experimental-acp'], needsInstall: false },
	{ id: 'goose', name: 'Goose', command: 'goose', args: ['acp'], needsInstall: true, website: 'https://example.com/goose' },
];

test('the form: the registry\'s agents then a command of one\'s own; the command field only for that; the machine only with SSH machines', () => {
	const spec = addFormSpec(registry, [{ id: 'dev', name: 'Dev box' }], t) as { id: string; intro: string; fields: { id: string; options?: { value: string; label: string }[]; when?: object }[] };
	assert.equal(spec.id, 'acp-add');
	assert.deepEqual(spec.fields.map(f => f.id), ['source', 'command', 'name', 'machine']);
	assert.deepEqual(spec.fields[0].options, [{ value: 'registry:gemini', label: 'Gemini CLI' }, { value: 'registry:goose', label: 'Goose · needs goose' }, { value: 'custom', label: 'custom' }]);
	assert.deepEqual(spec.fields[1].when, { field: 'source', in: ['custom'] });
	assert.deepEqual(spec.fields[3].options, [{ value: 'local', label: 'thisMachine' }, { value: 'dev', label: 'Dev box' }]);
	const alone = addFormSpec([], [], t, false) as { intro: string; fields: { id: string }[] };
	assert.equal(alone.intro, 'noRegistry');
	assert.deepEqual(alone.fields.map(f => f.id), ['source', 'command', 'name']);
});

test('the entry: the registry agent\'s command, its name unless one is typed, an id unique on its machine', () => {
	const existing = [{ id: 'gemini', name: 'Gemini', command: 'gemini' }, { id: 'gemini', name: 'Gemini', command: 'gemini', machine: 'dev' }];
	assert.deepEqual(addFormEntry({ source: 'registry:gemini', name: '' }, registry, [{ id: 'dev' }], existing, t), {
		entry: { id: 'gemini-2', name: 'Gemini CLI', command: 'npx', args: ['@google/gemini-cli', '--experimental-acp'] }, agent: registry[0],
	});
	const remote = addFormEntry({ source: 'custom', command: ' my-agent --acp "a b" ', name: 'Mine', machine: 'dev' }, registry, [{ id: 'dev' }], existing, t);
	assert.deepEqual(remote, { entry: { id: 'mine', name: 'Mine', command: 'my-agent', args: ['--acp', 'a b'], machine: 'dev' } });
});

test('what is wrong names its field: no command, an agent no longer listed, a machine no longer connected', () => {
	assert.deepEqual(addFormEntry({ source: 'custom', command: '  ' }, registry, [], [], t), { field: 'command', message: 'commandRequired' });
	assert.deepEqual(addFormEntry({ source: 'registry:nope' }, registry, [], [], t), { field: 'source', message: 'unknownAgent' });
	assert.deepEqual(addFormEntry({ source: 'registry:goose', machine: 'gone' }, registry, [{ id: 'dev' }], [], t), { field: 'machine', message: 'unknownMachine' });
});

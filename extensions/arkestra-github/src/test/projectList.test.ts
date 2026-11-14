/*---------------------------------------------------------------------------------------------
 *  Arkestra. The project picker's list: the user's own projects and their organizations'.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseProjectList } from '../project';

test('project list: own projects, then the organizations\'; closed ones last', () => {
	const data = {
		viewer: {
			login: 'csorbar',
			projectsV2: { nodes: [{ number: 7, title: 'Tenark-X', closed: false }, { number: 2, title: 'old', closed: true }] },
			organizations: { nodes: [{ login: 'tenarkhq', projectsV2: { nodes: [{ number: 3, title: 'Arkestra', closed: false }, { number: 5, title: '', closed: false }] } }, { login: 'empty', projectsV2: null }] },
		},
	};
	assert.deepEqual(parseProjectList(data).map(p => `${p.owner}/${p.number} ${p.title}${p.closed ? ' (closed)' : ''}`), ['csorbar/7 Tenark-X', 'tenarkhq/3 Arkestra', 'tenarkhq/5 #5', 'csorbar/2 old (closed)']);
	assert.deepEqual(parseProjectList(undefined), []);
});

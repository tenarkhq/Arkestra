/*---------------------------------------------------------------------------------------------
 *  Arkestra. Step lines of adopted sessions: folded between the answer's texts, left out of what goes on.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stepParts, stepsLabel, withoutSteps } from '../steps';

const step = (kind: string, label: string) => `<arkestra-step kind="${kind}">${label}</arkestra-step>`;
const answer = ['Looking.', step('command', 'Checked the test'), step('edit', 'Edited a.py'), step('command', 'Ran the tests'), 'Fixed.', step('read', 'Read b.py')].join('\n\n');

test('an answer as texts and runs of steps, in order', () => {
	assert.deepEqual(stepParts(answer), [
		{ md: 'Looking.' },
		{ steps: [{ kind: 'command', label: 'Checked the test' }, { kind: 'edit', label: 'Edited a.py' }, { kind: 'command', label: 'Ran the tests' }] },
		{ md: 'Fixed.' },
		{ steps: [{ kind: 'read', label: 'Read b.py' }] },
	]);
	assert.deepEqual(stepParts('plain'), [{ md: 'plain' }]);
});

test('a run of steps as one line: one step by its name, more by what they were', () => {
	assert.equal(stepsLabel([{ kind: 'command', label: 'Checked the test' }]), 'Checked the test');
	assert.equal(stepsLabel([{ kind: 'command', label: 'a' }, { kind: 'edit', label: 'b' }, { kind: 'command', label: 'c' }]), 'Ran 2 commands and edited 1 file');
	assert.equal(stepsLabel([{ kind: 'read', label: 'a' }, { kind: 'search', label: 'b' }, { kind: 'zzz', label: 'c' }]), 'Read 1 file, ran 1 search and used 1 tool');
});

test('the agents and the clipboard get the words without the steps', () => {
	assert.equal(withoutSteps(answer), 'Looking.\n\nFixed.');
	assert.equal(withoutSteps('no steps\n\n\nhere'), 'no steps\n\n\nhere');
});

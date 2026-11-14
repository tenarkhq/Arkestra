/*---------------------------------------------------------------------------------------------
 *  Arkestra. ⌘K edit in place: the request, reading the code out of the answer, fitting it
 *  to the replaced lines and keeping the proposal's place while the file changes.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractCode, fitReplacement, inlinePrompt, inlineTranscript, shiftSpan } from '../inlineEdit';

const req = { file: 'src/app.ts', language: 'typescript', selected: '\tconst a = 1;\n', before: 'function f() {\n', after: '}\n', line: 2, instruction: 'nevezd át b-re' };

test('the request carries the code around, the selection, earlier rounds and the strict answer format', () => {
	const text = inlinePrompt({ ...req, history: [{ instruction: 'legyen let', proposal: '\tlet a = 1;\n' }] });
	assert.match(text, /A kijelölt kód \(src\/app\.ts, 2\. sortól\):\n\n```typescript\n\tconst a = 1;\n```/);
	assert.match(text, /Környezet előtte \(src\/app\.ts\):\n\n```typescript\nfunction f\(\) \{\n```/);
	assert.match(text, /1\. kérés: legyen let\nA javaslatod erre:/);
	assert.match(text, /A kérés: nevezd át b-re/);
	assert.match(text, /egyetlen kódblokk legyen: a kijelölés helyére/);
	assert.match(inlinePrompt({ ...req, selected: '' }), /A kurzor helye: src\/app\.ts, 2\. sor/);
	assert.match(inlinePrompt({ ...req, selected: 'x = "```"\n' }), /````typescript\nx = "```"\n````/, 'a fence inside the code gets a longer fence');
	const [m] = inlineTranscript(req, new Date(0));
	assert.equal(m.author.kind, 'user');
	assert.equal(m.text, inlinePrompt(req));
});

test('the code is the longest fenced block, or the bare answer; no code means nothing changes', () => {
	assert.equal(extractCode('Íme:\n\n```ts\n\tconst b = 1;\n```\n'), '\tconst b = 1;');
	assert.equal(extractCode('```\nshort\n```\n\n```ts\nthe real\nreplacement\n```'), 'the real\nreplacement');
	assert.equal(extractCode('~~~py\nx = 1\n~~~'), 'x = 1');
	assert.equal(extractCode('  ```js\n  a();\n    b();\n  ```'), 'a();\n  b();', 'an indented fence is unindented');
	assert.equal(extractCode('return a + b;'), 'return a + b;');
	assert.equal(extractCode(''), undefined);
	assert.equal(extractCode('[error] quota'), undefined);
	assert.equal(extractCode('```ts\nunclosed'), undefined);
});

test('the replacement keeps the selection\'s trailing newline and its indentation when the agent dropped it', () => {
	assert.equal(fitReplacement('\tconst b = 1;', '\tconst a = 1;\n'), '\tconst b = 1;\n');
	assert.equal(fitReplacement('const b = 1;\nif (b) {\n\tgo();\n}', '\tconst a = 1;\n'), '\tconst b = 1;\n\tif (b) {\n\t\tgo();\n\t}\n');
	assert.equal(fitReplacement('x();', '', '    '), '    x();', 'an insertion takes the indentation around it');
	assert.equal(fitReplacement('  x();', '\ty();'), '  x();', 'code with its own indentation is left as it is');
});

test('the proposal moves with edits above, grows with edits inside, ignores edits below', () => {
	const span = { start: 10, end: 14 };
	assert.deepEqual(shiftSpan(span, { start: 2, end: 2, lines: 3 }), { start: 12, end: 16 }, 'two lines added above');
	assert.deepEqual(shiftSpan(span, { start: 3, end: 5, lines: 1 }), { start: 8, end: 12 }, 'two lines removed above');
	assert.deepEqual(shiftSpan(span, { start: 11, end: 11, lines: 2 }), { start: 10, end: 15 }, 'a line added inside');
	assert.deepEqual(shiftSpan(span, { start: 14, end: 20, lines: 1 }), span, 'below');
	assert.deepEqual(shiftSpan(span, { start: 10, end: 13, lines: 1 }), { start: 10, end: 11 }, 'most of it deleted');
});

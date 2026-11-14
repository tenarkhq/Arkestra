/*---------------------------------------------------------------------------------------------
 *  Arkestra. @-references: finding them in a message, line ranges, limits, the attached
 *  material and taking it off again, web pages as text, terminal output without codes.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cap, completionKinds, fileTarget, htmlToText, parseReferences, stripAnsi, withAttachments, withoutAttachments } from '../references';

test('references are found by kind; @Name mentions, e-mail addresses and bare kinds that need an argument are not', () => {
	const refs = parseReferences('Nézd meg @file:src/app.ts#L10-40 és @diff, (@terminal:3), @thread:"Bejelentkezés hiba". @Claude, írj a@b.hu-ra; @brief:#12 @web:https://example.com/a?b=1. @file @file:src/app.ts#L10-40');
	assert.deepEqual(refs.map(r => r.token), ['@file:src/app.ts#L10-40', '@diff', '@terminal:3', '@thread:"Bejelentkezés hiba"', '@brief:#12', '@web:https://example.com/a?b=1']);
	assert.equal(refs[3].arg, 'Bejelentkezés hiba');
	assert.equal(refs[1].arg, '');
	assert.deepEqual(parseReferences('@diff:main...HEAD\n@terminal').map(r => [r.kind, r.arg]), [['diff', 'main...HEAD'], ['terminal', '']]);
	assert.deepEqual(parseReferences('x@file:a.ts @files:b @thread'), []);
});

test('a file reference can carry a line range', () => {
	assert.deepEqual(fileTarget('src/a.ts#L10-40'), { path: 'src/a.ts', from: 10, to: 40 });
	assert.deepEqual(fileTarget('src/a.ts#L40-L10'), { path: 'src/a.ts', from: 10, to: 40 });
	assert.deepEqual(fileTarget('src/a.ts#L7'), { path: 'src/a.ts', from: 7, to: 7 });
	assert.deepEqual(fileTarget('docs/#readme'), { path: 'docs/#readme' });
});

test('material is cut at a line end and attached after the message; the thread shows the message alone', () => {
	const c = cap('aaaa\nbbbb\ncccc\n', 11);
	assert.deepEqual(c, { text: 'aaaa\nbbbb', truncated: true });
	assert.deepEqual(cap('rövid', 10), { text: 'rövid', truncated: false });
	assert.equal(withAttachments('csak szöveg', []), 'csak szöveg');
	const text = withAttachments('Javítsd @file:a.ts', [{ label: '@file:a.ts', text: 'const a = "```";\n', language: 'typescript', truncated: true }, { label: '@diff', text: '+x', language: 'diff' }]);
	assert.match(text, /^Javítsd @file:a\.ts\n\n---\nHivatkozott anyagok \(2\):\n\n### @file:a\.ts \(levágva\)\n\n````typescript\nconst a = "```";\n````\n\n### @diff\n\n```diff\n\+x\n```$/);
	assert.deepEqual(withoutAttachments(text), { message: 'Javítsd @file:a.ts', count: 2 });
	assert.deepEqual(withoutAttachments('semmi'), { message: 'semmi', count: 0 });
});

test('a web page becomes readable text without scripts, styles and tags', () => {
	const page = htmlToText('<html><head><title>A &amp; B</title><style>p{}</style></head><body><nav>menü</nav><h1>Cím</h1><p>Első&nbsp;bekezdés &lt;kód&gt; &#233; &#x151;</p><script>alert(1)</script><ul><li>egy</li><li>kettő</li></ul></body></html>');
	assert.equal(page.title, 'A & B');
	assert.equal(page.text, '# Cím\nElső bekezdés <kód> é ő\n\n- egy\n- kettő');
});

test('terminal output loses colour and cursor codes; completion offers the kinds', () => {
	assert.equal(stripAnsi('\u001b[32mok\u001b[0m 3 passed\r\n\u001b]633;A\u0007$ '), 'ok 3 passed\r\n$ ');
	assert.deepEqual(completionKinds('@'), ['file', 'diff', 'terminal', 'thread', 'brief', 'web']);
	assert.deepEqual(completionKinds('@t'), ['terminal', 'thread']);
	assert.deepEqual(completionKinds('@file:src'), ['file']);
});

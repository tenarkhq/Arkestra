/*---------------------------------------------------------------------------------------------
 *  Arkestra. Images in a thread: what a source is, which files may be loaded, image references
 *  in the text and in the user's bubble, the composer's file names, the bundled font.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { Script } from 'node:vm';
import { allowedImage, attachmentName, fileReference, imageName, imageRefs, imageSource, isInside, markdownImages, userImages, type ImageResolver } from '../images';
import { imageAttachment, parseReferences } from '../references';
import { fontFaces, fontSrc } from '../fonts';
import { renderMarkdown, rowHtml, threadPage, detailsPage, type ThreadStrings } from '../threadHtml';
import { sidebarHtml } from '../sidebarHtml';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('image sources: data images, https, local files; scripts and odd schemes never', () => {
	assert.deepEqual(imageSource(PNG), { kind: 'data', url: PNG });
	assert.equal(imageSource('data:image/svg+xml;base64,PHN2Zz4='), undefined, 'no svg data URLs');
	assert.equal(imageSource('data:text/html;base64,PHNjcmlwdD4='), undefined);
	assert.equal(imageSource('data:image/png;base64,abc"onerror="x'), undefined);
	assert.deepEqual(imageSource('https://example.com/a.png?x=1'), { kind: 'web', url: 'https://example.com/a.png?x=1' });
	assert.equal(imageSource('http://example.com/a.png'), undefined, 'plain http is not loaded');
	assert.equal(imageSource('javascript:alert(1)'), undefined);
	assert.equal(imageSource('vscode-resource://x/a.png'), undefined);
	assert.deepEqual(imageSource('/home/r/shot.png'), { kind: 'file', path: path.normalize('/home/r/shot.png') });
	assert.deepEqual(imageSource('<file:///home/r/my%20shot.png>'), { kind: 'file', path: path.normalize('/home/r/my shot.png') });
	assert.deepEqual(imageSource('~/Desktop/a.jpg', { home: '/home/r' }), { kind: 'file', path: path.normalize('/home/r/Desktop/a.jpg') });
	assert.equal(imageSource('~/Desktop/a.jpg'), undefined, 'no home, no ~');
	assert.deepEqual(imageSource('docs/a.webp', { base: '/w/proj' }), { kind: 'file', path: path.normalize('/w/proj/docs/a.webp') });
	assert.equal(imageSource('docs/a.webp'), undefined, 'a relative path needs a base');
	assert.equal(imageSource('/etc/passwd'), undefined, 'only image files');
	assert.equal(imageSource('/home/r/.claude/.credentials.json'), undefined);
});

test('allowed folders: inside only, no way out with ..', () => {
	const roots = ['/g/room-files/r1', '/w/proj', '/home/r/.claude'];
	assert.ok(allowedImage('/g/room-files/r1/kep.png', roots));
	assert.ok(allowedImage('/w/proj/docs/deep/a.jpeg', roots));
	assert.ok(allowedImage('/home/r/.claude/arkestra-images/abc.png', roots));
	assert.ok(!allowedImage('/g/room-files/r2/kep.png', roots), 'another room');
	assert.ok(!allowedImage('/g/room-files/r1/../r2/kep.png', roots));
	assert.ok(!allowedImage('/w/project2/a.png', roots), 'a prefix is not a parent');
	assert.ok(!allowedImage('/tmp/a.png', roots));
	assert.ok(!allowedImage('/w/proj/secret.txt', roots), 'not an image');
	assert.ok(!allowedImage('/w/proj/a.png', ['']), 'an empty root allows nothing');
	assert.ok(isInside('/W/Proj', '/w/proj/a.png', true));
	assert.ok(!isInside('/W/Proj', '/w/proj/a.png', false));
});

test('image references in the text: markdown images, @file: pictures, paths; code blocks left out', () => {
	assert.deepEqual(markdownImages('a ![shot](/x/a.png) b ![](<C:/my shots/b.png> "t")'), [{ alt: 'shot', src: '/x/a.png' }, { alt: '', src: 'C:/my shots/b.png' }]);
	const text = 'Saved to /w/proj/out/shot.png and `~/Desktop/b.jpg`.\nSee @file:"room files/c.webp" and @file:src/app.ts, ![x](/x/md.png)\n```\nls /w/proj/inside-code.png\n```\nhttps://example.com/web.png';
	assert.deepEqual(imageRefs(text), ['room files/c.webp', '/w/proj/out/shot.png', '~/Desktop/b.jpg']);
	assert.deepEqual(imageRefs('@file:shots/a.png#L1-2 C:\\Users\\r\\a.gif'), ['shots/a.png', 'C:\\Users\\r\\a.gif']);
	assert.deepEqual(imageRefs('no pictures: /etc/hosts, a.png'), []);
});

test('the user bubble: attached pictures come out of the words, other references stay', () => {
	const { text, images } = userImages('Mi ez?\n\n@file:"/g/room-files/r1/kep 1.png" @file:src/app.ts\n![image](/home/r/.claude/arkestra-images/ab.png)');
	assert.equal(text, 'Mi ez?\n\n@file:src/app.ts');
	assert.deepEqual(images, ['/home/r/.claude/arkestra-images/ab.png', '/g/room-files/r1/kep 1.png']);
	assert.deepEqual(userImages('just words'), { text: 'just words', images: [] });
	assert.equal(imageName('/a/b/kep.png'), 'kep.png');
	assert.equal(imageName(PNG), 'image');
});

test('composer files: clean names, a pasted picture named by the time, nothing overwritten', () => {
	const taken = new Set(['kep.png', 'kep-2.png']);
	const at = new Date('2026-11-15T09:08:07Z');
	assert.equal(attachmentName('kep.png', 'image/png', n => taken.has(n), at), 'kep-3.png');
	assert.equal(attachmentName('../../etc/passwd', 'text/plain', () => false, at), 'passwd');
	assert.equal(attachmentName('', 'image/png', () => false, at), 'kep-20261115-090807.png');
	assert.equal(attachmentName('image', 'image/jpeg', () => false, at), 'image.jpg');
	assert.equal(attachmentName('a<b>:c?.txt', '', () => false, at), 'abc.txt');
	assert.equal(attachmentName('.hidden', '', () => false, at), 'hidden');
	assert.equal(fileReference('/g/room-files/r1/kep.png'), '@file:/g/room-files/r1/kep.png');
	assert.equal(fileReference('/g/room files/kep.png'), '@file:"/g/room files/kep.png"');
	// What the composer sends is what the room reads back as a reference.
	assert.deepEqual(parseReferences(`nézd ${fileReference('/g/room files/kep.png')}`).map(r => r.arg), ['/g/room files/kep.png']);
	assert.equal(imageAttachment('@file:/a/kep.png', '/a/kep.png')?.label, '@file:/a/kep.png (kép)');
	assert.ok(imageAttachment('@file:/a/kep.png', '/a/kep.png')?.text.includes('/a/kep.png'));
	assert.equal(imageAttachment('@file:/a/app.ts', '/a/app.ts'), undefined);
});

const S: ThreadStrings = { local: 'this machine', attached: n => `+${n} attached`, tasksDone: n => `${n} finished`, tasks: n => `${n} tasks`, other: n => `${n} other`, working: 'working…', copy: 'Copy' };
const allow: ImageResolver = src => src.startsWith('/ok/') ? `https://res.test${src}` : src.startsWith('https://') || src.startsWith('data:image/') ? src : undefined;

test('markdown images render as thumbnails only through the resolver', () => {
	assert.equal(renderMarkdown('![a](https://e.com/a.png)'), '<p><img class="thumb" src="https://e.com/a.png" alt="a" loading="lazy"></p>');
	const local = renderMarkdown('![shot](/home/r/a.png)');
	assert.ok(!local.includes('<img'), 'no resolver: no local file');
	assert.ok(local.includes('class="imgx"') && local.includes('shot'));
	assert.ok(renderMarkdown('![x](/ok/a.png)', { image: allow }).includes('src="https://res.test/ok/a.png"'));
	assert.ok(renderMarkdown('- item ![x](/ok/b.png)', { image: allow }).includes('src="https://res.test/ok/b.png"'), 'nested blocks use it too');
	assert.ok(!renderMarkdown('`![x](/ok/a.png)`', { image: allow }).includes('<img'), 'not inside code');
	assert.ok(!renderMarkdown('![x" onerror="alert(1)](https://e.com/a.png)').includes('" onerror'), 'alt escaped');
	// After a call with a resolver the default is back.
	assert.ok(!renderMarkdown('![x](/ok/a.png)').includes('<img'));
});

test('rows show pictures: the agent\'s named files under its answer, the user\'s in the bubble', () => {
	const agent = rowHtml({ type: 'agent', id: '1', at: '', agentId: 'claude', name: 'Claude', text: 'Kész: /ok/shot.png és /nope/x.png' }, S, renderMarkdown, '', allow);
	assert.ok(agent.includes('<div class="imgs"><img class="thumb" src="https://res.test/ok/shot.png"'));
	assert.ok(!agent.includes('/nope/x.png"'), 'a path that may not load stays text');
	const user = rowHtml({ type: 'user', id: '2', at: '', text: 'Mi ez?\n\n@file:/ok/kep.png', attached: 1 }, S, renderMarkdown, '', allow);
	assert.ok(user.startsWith('<div class="ub">Mi ez?<div class="imgs"><img class="thumb" src="https://res.test/ok/kep.png"'), user);
	assert.ok(!user.includes('@file'));
	const missing = rowHtml({ type: 'user', id: '3', at: '', text: '![image](/gone/kep.png)', attached: 0 }, S, renderMarkdown, '', allow);
	assert.ok(missing.includes('class="imgx"') && missing.includes('kep.png'));
});

test('pages load the bundled Inter only with a font source in the CSP', () => {
	const fonts = { base: 'https://res.test/media/fonts/', cspSource: 'https://res.test' };
	const faces = fontFaces(fonts);
	assert.ok(faces.includes('url("https://res.test/media/fonts/inter-latin-wght-normal.woff2") format("woff2")'));
	assert.ok(faces.includes('inter-latin-ext-wght-normal.woff2') && faces.includes('U+0100-02AF'), 'ő and ű come from Latin Extended');
	assert.equal(fontFaces(undefined), '');
	assert.equal(fontSrc(fonts), ' font-src https://res.test;');
	const page = threadPage({ nonce: 'N', cspSource: 'https://res.test', mode: 'thread', placeholder: 'p', heading: 'h', fonts });
	assert.ok(page.includes("font-src https://res.test;"));
	assert.ok(page.includes('font-family: "Inter", -apple-system'));
	assert.ok(page.includes('id="atts"') && page.includes('id="lightbox"'));
	const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
	assert.doesNotThrow(() => new Script(script), 'the page script compiles');
	assert.ok(detailsPage('N', fonts).includes('@font-face'));
	assert.ok(!detailsPage('N').includes('font-src'));
	const side = sidebarHtml('N', new Proxy({}, { get: (_t, k) => String(k) }) as never, fonts);
	assert.ok(side.includes('font-src https://res.test;') && side.includes('@font-face'));
});

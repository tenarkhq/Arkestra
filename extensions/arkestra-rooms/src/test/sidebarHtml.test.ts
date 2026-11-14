/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar's page: locked down by its nonce, its strings safe, its script valid.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { sidebarHtml, type SidebarStrings } from '../sidebarHtml';

const keys = ['newChat', 'search', 'searchPlaceholder', 'boards', 'artifacts', 'machines', 'pinned', 'newSection', 'unsectioned', 'archived', 'noChats', 'noMatch', 'more', 'running', 'moveTo', 'noSection', 'newSectionMenu', 'pin', 'unpin', 'rename', 'archive', 'restore', 'delete', 'renameSection', 'moveUp', 'moveDown', 'deleteSection'];
const strings = Object.fromEntries(keys.map(k => [k, k === 'newChat' ? 'New <b>chat</b> "x"' : k])) as unknown as SidebarStrings;

test('the page runs only its own nonce, shows its strings escaped and its script compiles', () => {
	const html = sidebarHtml('NONCE123', strings);
	assert.match(html, /default-src 'none'; style-src 'nonce-NONCE123'; script-src 'nonce-NONCE123';/);
	assert.ok(html.includes('New &lt;b&gt;chat&lt;/b&gt; &quot;x&quot;'));
	assert.ok(!html.includes('<b>chat</b>'));
	const data = /<script type="application\/json" id="l10n" nonce="NONCE123">([^<]*)<\/script>/.exec(html);
	assert.ok(data, 'the strings travel as JSON with no raw "<"');
	assert.equal(JSON.parse(data[1]).newChat, 'New <b>chat</b> "x"');
	const scripts = [...html.matchAll(/<script nonce="NONCE123">([\s\S]*?)<\/script>/g)].map(m => m[1]);
	assert.equal(scripts.length, 1);
	assert.doesNotThrow(() => new Script(scripts[0]));
	for (const id of ['newChat', 'search', 'boards', 'artifacts', 'machines']) {
		assert.ok(html.includes(`data-nav="${id}"`), id);
	}
});

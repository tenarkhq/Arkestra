/*---------------------------------------------------------------------------------------------
 *  Arkestra. The left bar's page: locked down by its nonce, its strings safe, its script valid.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { sidebarHtml, type SidebarStrings } from '../sidebarHtml';

const keys = ['newChat', 'search', 'searchPlaceholder', 'boards', 'artifacts', 'machines', 'pinned', 'newSection', 'archived', 'showOlder', 'showFewer', 'noChats', 'noMatch', 'more', 'running', 'moveTo', 'noSection', 'newSectionMenu', 'sectionName', 'pin', 'unpin', 'rename', 'archive', 'restore', 'delete', 'renameSection', 'moveUp', 'moveDown', 'deleteSection'];
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

test('section and thread names are typed in place in the left bar, never in an input box at the top', () => {
	const html = sidebarHtml('NONCE123', strings);
	assert.match(html, /function editName\(host, initial, done\)/);
	assert.match(html, /editName\(action, '', name => post\(\{ type: 'section', action: 'new', name \}\)\)/);
	assert.match(html, /post\(\{ type: 'moveToNew', id: r\.id, name \}\)/);
	assert.match(html, /post\(\{ type: 'section', action: 'rename', id, name \}\)/);
	assert.match(html, /post\(\{ type: 'thread', action: 'rename', id: r\.id, name \}\)/);
	assert.doesNotMatch(html, /post\(\{ type: 'section', action: 'new' \}\)/);
});

test('session rows of the machines are rows like threads: menu and drag, but no Delete (the session stays on its machine)', () => {
	const html = sidebarHtml('NONCE123', strings);
	assert.match(html, /const chat = r\.kind === 'thread' \|\| r\.kind === 'session';/);
	assert.match(html, /it\.dataset\.menu = '1';/);
	assert.match(html, /\.\.\.\(r\.kind === 'thread' \? \[\{ label: S\.delete, danger: true, run: act\('delete'\) \}\] : \[\]\)/);
	assert.match(html, /e\.target\.closest\('\.it\[data-menu\]'\)/, 'the right click menu opens on session rows too');
	assert.match(html, /e\.target\.closest && e\.target\.closest\('\.it\[data-menu\]'\)/, 'session rows can be dragged into a section');
});

test('the agent groups: a header per agent that takes a row back out of its section, and "Show older" per group', () => {
	const html = sidebarHtml('NONCE123', strings);
	assert.match(html, /for \(const g of model\.groups\) \{\n\t\t\tout\.append\(header\(g\.name, ''\)\);/);
	assert.match(html, /S\.showOlder\.replace\('\{0\}', String\(g\.older\.length\)\)/);
	assert.match(html, /more\.dataset\.action = 'older:' \+ g\.id;/);
	assert.match(html, /ui\.olderOpen = Object\.assign\(\{\}, ui\.olderOpen, \{ \[g\]: !ui\.olderOpen\[g\] \}\)/);
	assert.doesNotMatch(html, /unsectioned/);
});

test('a background refresh waits while the mouse is on the list or a menu is open, so rows do not move under the pointer', () => {
	const html = sidebarHtml('NONCE123', strings);
	assert.match(html, /if \(m\.quiet && \(hovering \|\| menu\)\) \{ pending = true; return; \}/);
	assert.match(html, /list\.addEventListener\('mouseleave', \(\) => \{ hovering = false; flush\(\); \}\);/);
	assert.match(html, /if \(pending && !dragging && !editing && !menu && !hovering\) \{ pending = false; render\(\); \}/);
	assert.match(html, /if \(!reopen\) \{ flush\(\); \}/, 'closing a menu shows a held refresh');
});

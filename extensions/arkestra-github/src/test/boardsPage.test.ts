/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Boards page's script against a minimal fake DOM: the mosaic, empty state,
 *  tile click, the tile menu (pin, GitHub, remove with its inline confirm), search and chips,
 *  and the add form inside the page (validation, the user's projects, no quick pick).
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { boardsHtml } from '../boardsHtml';
import { boardTile } from '../boards';
import { sampleSnapshot } from './boardsSample';

test('the Boards page draws every board and posts what the user does', () => {
	const html = boardsHtml('n', 'c', {}, 'https://fonts.example');
	assert.ok(html.includes('font-src c;') && html.includes('inter-latin-wght-normal.woff2'), 'the bundled Inter');
	assert.ok(!/showQuickPick|showInputBox/.test(html));
	const script = html.split('<script nonce="n">')[1].split('</script>')[0];
	const g: any = globalThis;
	const els: Record<string, any> = {};
	const el = (id: string) => (els[id] ??= { id, innerHTML: '', value: '', focus() { } });
	const handlers: Record<string, any[]> = {};
	const posted: any[] = [];
	let messageListener: any;
	let state: any;
	g.document = { getElementById: (id: string) => id === 'root' || (els.root?.innerHTML ?? '').includes('id="' + id + '"') ? el(id) : null, addEventListener: (k: string, f: any) => (handlers[k] ??= []).push(f) };
	g.window = { addEventListener: (k: string, f: any) => { if (k === 'message') messageListener = f; } };
	g.acquireVsCodeApi = () => ({ getState: () => state, setState: (s: any) => { state = s; }, postMessage: (m: any) => posted.push(m) });
	new Function(script)();

	const root = () => els.root.innerHTML as string;
	const send = (data: any) => messageListener({ data });
	const fire = (kind: string, e: any) => handlers[kind].forEach(f => f(e));
	/** A click on an element with these data attributes (act/key/v/open), or inside a menu / form. */
	const click = (data: Record<string, string>, inside?: boolean) => fire('click', {
		target: {
			closest: (sel: string) => sel === '[data-act]' ? (data.act ? { dataset: data } : null)
				: sel === '[data-open]' ? (data.open ? { dataset: data } : null)
					: inside ? {} : null,
		},
	});
	const input = (id: string, value: string) => fire('input', { target: { id, value, selectionStart: value.length } });

	assert.equal(posted[0].type, 'ready');
	assert.ok(root().includes('<h1>Boards</h1>') && root().includes('+ Add board') && !root().includes('No boards yet'), 'no empty state before the list came');

	send({ type: 'data', tiles: [] });
	assert.ok(root().includes('No boards yet') && root().includes('+ Add board'), 'empty state with the add tile');

	const snap = sampleSnapshot();
	const ws = boardTile({ key: 'tenarkhq/3', title: '', workspace: true, pinned: false }, snap, { kind: 'synced', at: Date.now(), live: true });
	const other = boardTile({ key: 'csorbar/7', title: '', workspace: false, pinned: true }, sampleSnapshot({ owner: 'csorbar', number: 7, title: 'Tenark-X', url: 'https://github.com/users/csorbar/projects/7' }), undefined);
	const unread = boardTile({ key: 'x/1', title: '', workspace: false, pinned: false }, undefined, undefined);
	send({ type: 'data', tiles: [ws, other, unread] });
	const page = root();
	assert.ok(!page.includes('No boards yet'));
	assert.ok(page.includes('Arkestra') && page.includes('Tenark-X') && page.includes('x/1'), 'every board added');
	assert.ok(page.indexOf('Tenark-X') < page.indexOf('Arkestra'), 'pinned ones first');
	assert.ok(page.includes('TenarkHQ/3 · this workspace') && page.includes('csorbar/7 · pinned'));
	assert.ok(page.includes('<b>4</b>items') && page.includes('<b>1</b>open') && page.includes('<b>3</b>done') && page.includes('75%'), 'counts and done %');
	assert.ok(page.includes('data-w="75"'), 'the done bar');
	assert.ok(page.includes('>1.0<') && page.includes('>50%<') && page.includes('lane rel'), 'the lines with their %, released ones muted');
	assert.ok(page.includes('not read yet') && /read \d/.test(page), 'last read time');
	assert.ok(page.includes('All <em>3</em>') && page.includes('Pinned <em>1</em>'), 'chips');

	click({ open: 'csorbar/7' });
	assert.deepEqual(posted.at(-1), { type: 'open', key: 'csorbar/7' }, 'a tile opens its board');

	click({ act: 'menu', key: 'csorbar/7' });
	assert.ok(root().includes('role="menu"') && root().includes('>Unpin<') && root().includes('>Open on GitHub<') && root().includes('>Remove<'));
	click({ act: 'pin', key: 'csorbar/7' });
	assert.deepEqual(posted.at(-1), { type: 'pin', key: 'csorbar/7' });
	assert.ok(!root().includes('role="menu"'), 'the menu closes');
	click({ act: 'menu', key: 'tenarkhq/3' });
	assert.ok(root().includes('>Pin<') && !root().includes('>Remove<'), 'the workspace\'s own board is not removed from here');
	click({ act: 'github', key: 'tenarkhq/3' });
	assert.deepEqual(posted.at(-1), { type: 'github', key: 'tenarkhq/3' });
	click({ act: 'menu', key: 'x/1' });
	assert.ok(root().includes('disabled>Open on GitHub'), 'no GitHub address before the first read');

	// Remove asks inside the tile first.
	click({ act: 'remove', key: 'csorbar/7' });
	assert.ok(root().includes('Remove “Tenark-X” from Boards? The project stays on GitHub.'));
	const before = posted.length;
	click({ act: 'removeNo' });
	assert.ok(!root().includes('from Boards?') && posted.length === before, 'cancel keeps it');
	click({ act: 'remove', key: 'csorbar/7' });
	click({ act: 'removeYes', key: 'csorbar/7' });
	assert.deepEqual(posted.at(-1), { type: 'remove', key: 'csorbar/7' });

	// Search and chips.
	input('q', 'tenark-x');
	assert.ok(root().includes('Tenark-X') && !root().includes('TenarkHQ/3') && state.query === 'tenark-x');
	input('q', 'nothing like it');
	assert.ok(root().includes('Nothing matches the search.'));
	input('q', '');
	click({ act: 'scope', v: 'pinned' });
	assert.ok(root().includes('Tenark-X') && !root().includes('TenarkHQ/3') && state.scope === 'pinned');
	click({ act: 'scope', v: 'all' });
	assert.ok(root().includes('>csorbar<') && root().includes('>tenarkhq<'), 'owner chips with more than one owner');
	click({ act: 'owner', v: 'tenarkhq' });
	assert.ok(root().includes('TenarkHQ/3') && !root().includes('Tenark-X'));
	click({ act: 'owner', v: 'tenarkhq' });

	// The add form sits in the page.
	click({ act: 'addOpen' });
	assert.deepEqual(posted.at(-1), { type: 'projects' }, 'the user\'s projects asked for once');
	assert.ok(root().includes('id="addIn"') && root().includes('Reading your projects…'));
	click({ act: 'addGo' });
	assert.ok(root().includes('owner/number, e.g. tenarkhq/3'), 'empty is not a project');
	input('addIn', 'tenarkhq/arkestra');
	assert.ok(els.addErr.innerHTML.includes('owner/number, e.g.'), 'checked while typing');
	input('addIn', 'https://github.com/orgs/TenarkHQ/projects/3');
	assert.equal(els.addErr.innerHTML, '');
	click({ act: 'addGo' });
	assert.ok(root().includes('This board is already here.'));
	input('addIn', '');
	send({ type: 'projects', choices: [{ owner: 'TenarkHQ', number: 3, title: 'Arkestra', closed: false }, { owner: 'tenarkhq', number: 9, title: 'Website', closed: true }] });
	assert.ok(els.addList.innerHTML.includes('Website') && els.addList.innerHTML.includes('tenarkhq/9 · closed') && !els.addList.innerHTML.includes('>Arkestra<'), 'the user\'s projects not added yet');
	input('addIn', 'web');
	assert.ok(els.addList.innerHTML.includes('Website') && els.addErr.innerHTML === '', 'typing filters the list');
	click({ act: 'addPick', key: 'tenarkhq/9' });
	assert.deepEqual(posted.at(-1), { type: 'add', key: 'tenarkhq/9' });
	send({ type: 'addError', text: 'nope' });
	assert.equal(els.addErr.innerHTML, 'nope');
	send({ type: 'added', key: 'tenarkhq/9' });
	assert.ok(!root().includes('id="addIn"'), 'the form closes once added');
	click({ act: 'addOpen' });
	input('addIn', 'Csorbar/12');
	fire('keydown', { key: 'Enter', target: { id: 'addIn' }, preventDefault() { } });
	assert.deepEqual(posted.at(-1), { type: 'add', key: 'csorbar/12' }, 'Enter adds');
	fire('keydown', { key: 'Escape', target: { id: 'addIn' } });
	assert.ok(!root().includes('id="addIn"'), 'Escape closes the form');
	assert.equal(posted.filter(m => m.type === 'projects').length, 1);

	// "+ Board" on a board opens the page with the form open.
	send({ type: 'data', tiles: [ws], openForm: true });
	assert.ok(root().includes('id="addIn"'));
});

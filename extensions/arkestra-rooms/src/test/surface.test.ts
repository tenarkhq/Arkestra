/*---------------------------------------------------------------------------------------------
 *  Arkestra. The right details panel follows the middle: a page closes the right bar, a thread
 *  opens it again, the user's own close on a thread is kept, editors change nothing.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DetailsFollow, SETTLE_MS, surfaceOf } from '../surface';

test('the surface of the active tab: a thread, a page (board, artifacts, new chat), an editor', () => {
	assert.equal(surfaceOf({ webview: 'mainThreadWebview-arkestra.thread' }, 'arkestra.thread', 'room1'), 'thread');
	assert.equal(surfaceOf({ webview: 'arkestra.thread' }, 'arkestra.thread', undefined), 'page'); // the new chat
	assert.equal(surfaceOf({ webview: 'mainThreadWebview-arkestra.project' }, 'arkestra.thread', 'room1'), 'page');
	assert.equal(surfaceOf({ webview: 'mainThreadWebview-arkestra.artifacts' }, 'arkestra.thread', 'room1'), 'page');
	assert.equal(surfaceOf(undefined, 'arkestra.thread', 'room1'), 'editor');
});

test('a board closes the right bar and the thread opens it again; the thread\'s details only on a thread', () => {
	const f = new DetailsFollow();
	f.visibility(true);
	assert.equal(f.changed('thread'), undefined);
	assert.equal(f.showsThread(), true);
	assert.equal(f.changed('page'), 'close');
	assert.equal(f.showsThread(), false);
	f.visibility(false); // our own close
	assert.equal(f.changed('page'), undefined); // board to artifacts: stays closed
	assert.equal(f.changed('thread'), 'open');
	f.visibility(true);
	assert.equal(f.showsThread(), true);
});

test('after a restart on a page the bar is closed: the first thread opens it', () => {
	const f = new DetailsFollow();
	assert.equal(f.changed('page'), undefined); // restored on Remote Control, bar closed
	assert.equal(f.changed('thread'), 'open');
	f.visibility(true);
	assert.equal(f.changed('thread'), undefined);
});

test('closed by the user on a thread: a page and back keep it closed until he opens it', () => {
	let now = 0;
	const f = new DetailsFollow(() => now);
	f.changed('thread');
	f.visibility(true);
	now = SETTLE_MS;
	f.visibility(false); // the user closed it
	assert.equal(f.changed('page'), undefined);
	assert.equal(f.changed('thread'), undefined);
	f.visibility(true); // he opened it again
	assert.equal(f.changed('page'), 'close');
	f.visibility(false);
	assert.equal(f.changed('thread'), 'open');
});

test('editors and terminals change nothing; a bar opened by hand on a page is not reopened later by us', () => {
	const f = new DetailsFollow();
	f.changed('thread');
	f.visibility(true);
	assert.equal(f.changed('editor'), undefined);
	assert.equal(f.showsThread(), true);
	assert.equal(f.changed('thread'), undefined);
	assert.equal(f.changed('page'), 'close');
	f.visibility(false);
	f.visibility(true); // opened by hand on the page
	assert.equal(f.changed('thread'), undefined); // already open
	// Closed by hand on the page: not the user's thread choice, and nothing to reopen.
	assert.equal(f.changed('page'), 'close');
	f.visibility(false);
	assert.equal(f.changed('editor'), undefined);
	assert.equal(f.changed('thread'), 'open');
});

test('right after start the layout\'s own close is not the user\'s: once settled, a thread shows its details again', () => {
	let now = 0;
	const f = new DetailsFollow(() => now);
	assert.equal(f.changed('thread'), 'open');
	f.visibility(true);
	now = 2000;
	f.visibility(false); // the window restoring its layout closed the bar
	assert.equal(f.settled(), 'open');
	f.visibility(true);
	assert.equal(f.settled(), undefined);
	now = SETTLE_MS + 1;
	f.visibility(false); // now it is the user
	assert.equal(f.settled(), undefined);
	assert.equal(f.changed('page'), undefined);
	assert.equal(f.changed('thread'), undefined);
});

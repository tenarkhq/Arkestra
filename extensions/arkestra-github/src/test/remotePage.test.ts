/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Remote Control page (no quick pick, no dialog): the relay fields' check, the
 *  state line, the thread list, and the page's script against a minimal fake DOM; the board's
 *  own project list (Follow a project…).
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { relayProblem, remotePage, remoteThreads, statusLine, type RemoteStrings } from '../remotePage';
import { pickerProjects } from '../projectPicker';

const T: RemoteStrings = {
	title: 'Remote Control', lead: 'Follow and answer your threads from your phone.', relay: 'GitHub relay', relayLead: 'The phone reaches this machine through your relay.',
	relayUrl: 'Relay address', relayToken: 'Client token', tokenKept: 'Saved; type a new one to change it', tokenHint: 'From the relay\'s clients file.', save: 'Save', disconnect: 'Forget the relay',
	notConnected: 'Not connected yet.', connectedTo: 'Connected to {0}.', phone: 'Phone', off: 'Off', connecting: 'Connecting…', on: 'On · {0} phone(s)', error: 'The relay answered: {0}',
	turnOn: 'Turn on', turnOff: 'Turn off', copyLink: 'Copy the phone link', newLink: 'New link…', newLinkAsk: 'Phones with the old link stop working.', newLinkYes: 'Make a new link', cancel: 'Cancel',
	linkNote: 'Open the link on your phone.', scan: 'Scan it', threads: 'Threads on the phone', every: 'Every thread', chosen: 'Only the ones I tick ({0})', noThreads: 'No threads yet.',
};

test('relayProblem: an http(s) address, and a token unless one is saved', () => {
	const t = { url: 'URL', token: 'TOKEN' };
	assert.equal(relayProblem('', 'x', false, t), 'URL');
	assert.equal(relayProblem('edge.example.com', 'x', false, t), 'URL', 'no scheme');
	assert.equal(relayProblem('ftp://edge.example.com', 'x', false, t), 'URL');
	assert.equal(relayProblem(' https://edge.example.com/arkestra ', '', false, t), 'TOKEN');
	assert.equal(relayProblem('https://edge.example.com/arkestra', '  ', true, t), undefined, 'the saved token stays');
	assert.equal(relayProblem('http://127.0.0.1:8080', 'abc', false, t), undefined);
});

test('statusLine and remoteThreads', () => {
	assert.deepEqual(statusLine({ on: false, state: { kind: 'on', phones: 2 } as any }, T), { tone: 'off', text: 'Off' });
	assert.deepEqual(statusLine({ on: true, state: { kind: 'on', phones: 2 } as any }, T), { tone: 'ok', text: 'On · 2 phone(s)' });
	assert.deepEqual(statusLine({ on: true, state: { kind: 'error', message: '401' } as any }, T), { tone: 'bad', text: 'The relay answered: 401' });
	assert.deepEqual(statusLine({ on: true, state: { kind: 'connecting' } as any }, T), { tone: 'busy', text: 'Connecting…' });
	const rows = remoteThreads([{ id: 'a', title: 'Old', lastAt: '2026-11-01T10:00:00Z' }, { id: 'b', title: 'New', lastAt: '2026-11-14T10:00:00Z' }], ['a', 'gone']);
	assert.deepEqual(rows, [{ id: 'b', title: 'New', on: false }, { id: 'a', title: 'Old', on: true }]);
});

test('pickerProjects: open ones first, owner/number, closed and current marked', () => {
	const rows = pickerProjects([
		{ owner: 'acme', number: 1, title: 'Old plan', closed: true },
		{ owner: 'acme', number: 3, title: 'Roadmap', closed: false },
		{ owner: 'me', number: 2, title: 'Mine', closed: false },
	], ' Acme/3 ', { closed: 'closed', current: 'current' });
	assert.deepEqual(rows.map(r => r.ref), ['acme/3', 'me/2', 'acme/1']);
	assert.deepEqual(rows.map(r => r.detail), ['acme/3 · current', 'me/2', 'acme/1 · closed']);
	assert.deepEqual(rows.map(r => r.current), [true, false, false]);
});

/** Just enough DOM for the page's script: elements, children, text, events. */
function fakeDom(ids: string[]) {
	const listeners: Record<string, ((e: any) => void)[]> = {};
	class El {
		children: El[] = []; dataset: Record<string, string> = {}; className = ''; type = ''; name = ''; value = ''; checked = false; hidden = false; placeholder = ''; focused = false;
		private own = ''; private ls: Record<string, ((e: any) => void)[]> = {};
		constructor(public tag: string, public id = '') { }
		get textContent(): string { return this.own + this.children.map(c => c.textContent).join(''); }
		set textContent(v: string) { this.own = v; this.children = []; }
		append(...xs: El[]) { this.children.push(...xs); }
		replaceChildren(...xs: El[]) { this.own = ''; this.children = xs; }
		addEventListener(k: string, f: (e: any) => void) { (this.ls[k] ??= []).push(f); }
		fire(k: string, e: any = {}) { (this.ls[k] ?? []).forEach(f => f({ preventDefault() { }, target: this, ...e })); }
		focus() { this.focused = true; }
		closest(sel: string) { return sel === 'button[data-act]' && this.tag === 'button' && this.dataset.act ? this : null; }
		all(): El[] { return [this, ...this.children.flatMap(c => c.all())]; }
	}
	const byId: Record<string, El> = Object.fromEntries(ids.map(id => [id, new El(id === 'relay' ? 'form' : 'div', id)]));
	const document = {
		getElementById: (id: string) => byId[id] ?? null,
		createElement: (tag: string) => new El(tag),
		createTextNode: (text: string) => { const e = new El('#text'); e.textContent = text; return e; },
		addEventListener: (k: string, f: (e: any) => void) => (listeners[k] ??= []).push(f),
	};
	const fire = (k: string, target: El) => (listeners[k] ?? []).forEach(f => f({ target }));
	return { document, byId, fire };
}

test('the Remote Control page draws its state and posts what the user does', () => {
	const html = remotePage('n', 'c', T);
	assert.ok(!/showQuickPick|showInputBox|showWarningMessage|confirm\(/.test(html), 'no quick pick, input box or dialog');
	assert.ok(html.includes('type="password" name="token"'), 'the token is a password field');
	const scripts = html.split('<script nonce="n">');
	const script = scripts[1].split('</script>')[0];
	new Script(script);
	const l10n = html.split('id="l10n" nonce="n">')[1].split('</script>')[0];
	const dom = fakeDom(['l10n', 'phone', 'scope', 'relayState', 'relay', 'url', 'token', 'tokenHint', 'relayErr', 'disconnect']);
	dom.byId.l10n.textContent = l10n;
	const posted: any[] = [];
	let onMessage: any;
	const g: any = { document: dom.document, window: { addEventListener: (k: string, f: any) => { if (k === 'message') { onMessage = f; } } }, acquireVsCodeApi: () => ({ postMessage: (m: any) => posted.push(m) }) };
	new Function('document', 'window', 'acquireVsCodeApi', script)(g.document, g.window, g.acquireVsCodeApi);
	assert.deepEqual(posted, [{ type: 'ready' }]);
	const send = (model: any) => onMessage({ data: { type: 'model', model } });
	const base = { relayUrl: '', hasToken: false, on: false, state: { kind: 'off' }, all: true, threads: [{ id: 'a', title: 'Ünnep', on: true }, { id: 'b', title: 'Release', on: false }], status: { tone: 'off', text: 'Off' } };
	send(base);
	const phone = () => dom.byId.phone.textContent;
	const button = (label: string) => dom.byId.phone.all().find(e => e.tag === 'button' && e.textContent === label)!;
	assert.ok(phone().includes('Off') && phone().includes('Turn on'));
	assert.equal(dom.byId.relayState.textContent, 'Not connected yet.');
	assert.ok(dom.byId.disconnect.hidden, 'nothing to forget yet');
	dom.fire('click', button('Turn on'));
	assert.deepEqual(posted.at(-1), { type: 'start' });

	// On: copy, a new link confirmed in place (not a dialog), off.
	send({ ...base, on: true, relayUrl: 'https://edge.example.com/arkestra', hasToken: true, status: { tone: 'ok', text: 'On · 1 phone(s)' } });
	assert.ok(phone().includes('Copy the phone link') && phone().includes('Open the link on your phone.'));
	assert.equal(dom.byId.relayState.textContent, 'Connected to https://edge.example.com/arkestra.');
	assert.equal(dom.byId.url.value, 'https://edge.example.com/arkestra');
	assert.equal(dom.byId.token.placeholder, 'Saved; type a new one to change it');
	assert.ok(!dom.byId.disconnect.hidden);
	dom.fire('click', button('New link…'));
	assert.ok(phone().includes('Phones with the old link stop working.'), 'asked in place');
	const n = posted.length;
	dom.fire('click', button('Cancel'));
	assert.equal(posted.length, n, 'cancel posts nothing');
	dom.fire('click', button('New link…'));
	dom.fire('click', button('Make a new link'));
	assert.deepEqual(posted.at(-1), { type: 'newLink' });

	// Threads: every one, or the ticked ones.
	assert.ok(dom.byId.scope.textContent.includes('Only the ones I tick (1)') && !dom.byId.scope.textContent.includes('Release'), 'every thread: no list');
	send({ ...base, all: false });
	const boxes = dom.byId.scope.all().filter(e => e.type === 'checkbox');
	assert.deepEqual(boxes.map(b => [b.dataset.thread, b.checked]), [['a', true], ['b', false]]);
	boxes[1].checked = true;
	dom.fire('change', boxes[1]);
	assert.deepEqual(posted.at(-1), { type: 'thread', id: 'b', on: true });
	const radio = dom.byId.scope.all().find(e => e.type === 'radio' && e.value === 'all')!;
	dom.fire('change', radio);
	assert.deepEqual(posted.at(-1), { type: 'scope', all: true });

	// The relay form: a half-typed address survives a redraw; an error shows on the page.
	dom.byId.url.value = 'https://other.example.com';
	dom.byId.url.fire('input');
	send(base);
	assert.equal(dom.byId.url.value, 'https://other.example.com', 'typed text kept');
	dom.byId.token.value = 'secret-token';
	dom.byId.relay.fire('submit');
	assert.deepEqual(posted.at(-1), { type: 'saveRelay', url: 'https://other.example.com', token: 'secret-token' });
	onMessage({ data: { type: 'relaySaved', error: 'Paste this client\'s token.' } });
	assert.equal(dom.byId.relayErr.textContent, 'Paste this client\'s token.');
	onMessage({ data: { type: 'relaySaved' } });
	assert.equal(dom.byId.token.value, '', 'the token field is emptied once saved');
	onMessage({ data: { type: 'focusRelay' } });
	assert.ok(dom.byId.url.focused, 'Connect the relay opens on the address field');
	dom.byId.disconnect.fire('click');
	assert.deepEqual(posted.at(-1), { type: 'disconnect' });
});

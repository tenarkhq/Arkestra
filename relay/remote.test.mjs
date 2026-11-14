// Arkestra Remote Control on the relay: host and phone streams, frames both ways, the latest
// frame per topic for a late phone, offline when the host goes, and who may do what.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createRelay, readClients } from './server.mjs';

const TOKEN = 'h'.repeat(32);
const OTHER = 'o'.repeat(32);
const CH = 'c'.repeat(22);

async function start() {
	const clients = readClients({ [TOKEN]: { name: 'laptop', repos: ['*'] }, [OTHER]: { name: 'other', repos: ['*'] } });
	const relay = createRelay({ secret: 's', clients: () => clients, remoteApp: Buffer.from('<!doctype html><title>Arkestra Remote</title>') });
	const server = createServer(relay.handler);
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;
	return { base, relay, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

/** An SSE reader: next(event) waits for the next event of that name. */
function reader(res) {
	const r = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	const queue = [];
	const pump = async () => {
		for (;;) {
			const { value, done } = await r.read().catch(() => ({ done: true }));
			if (done) {
				return;
			}
			buf += decoder.decode(value, { stream: true });
			let end;
			while ((end = buf.indexOf('\n\n')) >= 0) {
				const block = buf.slice(0, end);
				buf = buf.slice(end + 2);
				const ev = /^event: (.*)$/m.exec(block)?.[1];
				const data = /^data: (.*)$/m.exec(block)?.[1];
				if (ev) {
					queue.push({ event: ev, data: JSON.parse(data) });
				}
			}
		}
	};
	void pump();
	return {
		async next(event) {
			for (let i = 0; i < 200; i++) {
				const at = queue.findIndex(q => q.event === event);
				if (at >= 0) {
					return queue.splice(at, 1)[0].data;
				}
				await new Promise(res => setTimeout(res, 5));
			}
			throw new Error(`no ${event} event`);
		},
		cancel: () => r.cancel(),
	};
}

const frame = (topic, data) => ({ ...(topic ? { topic } : {}), iv: 'aXY=', data });

test('remote: host and phone exchange frames; a late phone gets the latest per topic; offline when the host goes', async () => {
	const s = await start();
	try {
		const post = (what, body, token) => fetch(`${s.base}/remote/${CH}/${what}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
		assert.equal((await fetch(`${s.base}/remote/${CH}/host`)).status, 401);
		assert.equal((await post('cmd', frame(undefined, 'x'))).status, 503, 'no host: the machine is offline');

		const host = reader(await fetch(`${s.base}/remote/${CH}/host`, { headers: { authorization: `Bearer ${TOKEN}` } }));
		await host.next('hello');
		assert.equal((await fetch(`${s.base}/remote/${CH}/host`, { headers: { authorization: `Bearer ${OTHER}` } })).status, 409, 'another client cannot take the channel');

		assert.equal((await post('up', frame('threads', 'v1'), TOKEN)).status, 202);
		assert.equal((await post('up', frame('threads', 'v2'), TOKEN)).status, 202);
		assert.equal((await post('up', frame('thread:a', 'a1'), TOKEN)).status, 202);
		assert.equal((await post('up', frame('x', 'y'), OTHER)).status, 404);
		assert.equal((await post('up', { nope: 1 }, TOKEN)).status, 400);

		const phone = reader(await fetch(`${s.base}/remote/${CH}/down`));
		assert.equal((await phone.next('status')).online, true);
		// The latest per topic: threads v2 (v1 replaced) and thread:a.
		const late = [(await phone.next('frame')).data, (await phone.next('frame')).data].sort();
		assert.deepEqual(late, ['a1', 'v2']);
		assert.deepEqual(await host.next('phones'), { phones: 1 });

		assert.equal((await post('cmd', frame(undefined, 'say hello'))).status, 202);
		assert.deepEqual(await host.next('cmd'), { iv: 'aXY=', data: 'say hello' });

		await post('up', frame('thread:a', 'a2'), TOKEN);
		assert.equal((await phone.next('frame')).data, 'a2');

		host.cancel();
		const off = await phone.next('status');
		assert.equal(off.online, false);
		assert.equal(s.relay.remote.channels.get(CH).topics.size, 0, 'nothing of an offline host stays');
		phone.cancel();

		const app = await fetch(`${s.base}/remote/app`);
		assert.equal(app.status, 200);
		assert.match(app.headers.get('content-security-policy'), /frame-ancestors 'none'/);
		assert.match(await app.text(), /Arkestra Remote/);
		assert.equal((await fetch(`${s.base}/remote/short/down`)).status, 404, 'channel ids are long');
	} finally {
		await s.close();
	}
});

test('remote: the phone page is one file whose script parses and reads the key only after #', () => {
	const html = readFileSync(new URL('./remote-app.html', import.meta.url), 'utf8');
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
	assert.equal(scripts.length, 1);
	assert.doesNotThrow(() => new Script(scripts[0]));
	assert.doesNotMatch(html, /<script src=|<link [^>]*stylesheet/, 'nothing from another host (the CSP allows only self)');
	assert.match(scripts[0], /location\.hash/);
	assert.match(scripts[0], /history\.replaceState/);
});

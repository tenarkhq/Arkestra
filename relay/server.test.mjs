// Arkestra webhook relay: signatures, client filtering, live events and replay over SSE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { allowed, createRelay, readClients, validSignature } from './server.mjs';

const SECRET = 'webhook-secret';
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

const sign = body => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

test('signature: GitHub\'s HMAC is accepted, anything else is not', () => {
	const body = Buffer.from('{"a":1}');
	assert.equal(validSignature(SECRET, body, sign(body)), true);
	assert.equal(validSignature(SECRET, body, sign(Buffer.from('{"a":2}'))), false);
	assert.equal(validSignature(SECRET, body, 'sha1=abc'), false);
	assert.equal(validSignature(SECRET, body, undefined), false);
});

test('clients: short tokens refused; a client sees its installations and repositories', () => {
	const clients = readClients({ short: { repos: ['*'] }, [TOKEN_A]: { name: 'Roland', installations: [42], repos: ['TenarkHQ/Arkestra'] } });
	assert.equal(clients.size, 1);
	const c = clients.get(TOKEN_A);
	assert.equal(allowed(c, { installation: 42 }), true);
	assert.equal(allowed(c, { repository: 'tenarkhq/arkestra' }), true);
	assert.equal(allowed(c, { installation: 7, repository: 'other/repo' }), false);
	assert.equal(allowed(readClients({ [TOKEN_B]: { installations: ['*'] } }).get(TOKEN_B), { installation: 1 }), true);
});

async function start() {
	const clients = readClients({ [TOKEN_A]: { name: 'A', repos: ['tenarkhq/arkestra'] }, [TOKEN_B]: { name: 'B', repos: ['other/repo'] } });
	const relay = createRelay({ secret: SECRET, clients: () => clients });
	const server = createServer(relay.handler);
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = (event, payload, signature) => {
		const body = JSON.stringify(payload);
		return fetch(`${base}/github/webhook`, { method: 'POST', headers: { 'x-github-event': event, 'x-github-delivery': `d-${Math.random()}`, 'x-hub-signature-256': signature ?? sign(body), 'content-type': 'application/json' }, body });
	};
	return { base, post, relay, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

/** Reads SSE events from a stream until `count` github events arrived. */
async function events(res, count) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	const out = [];
	while (out.length < count) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buf += decoder.decode(value, { stream: true });
		let end;
		while ((end = buf.indexOf('\n\n')) >= 0) {
			const block = buf.slice(0, end);
			buf = buf.slice(end + 2);
			if (/^event: github$/m.test(block)) {
				out.push(JSON.parse(/^data: (.*)$/m.exec(block)[1]));
			}
		}
	}
	reader.cancel();
	return out;
}

test('webhooks: a bad signature is refused; clients get only their repositories, live and after a reconnect', async () => {
	const r = await start();
	try {
		assert.equal((await r.post('push', { repository: { full_name: 'tenarkhq/Arkestra' } }, 'sha256=00')).status, 401);
		assert.equal((await fetch(`${r.base}/events?token=nope`)).status, 401);

		const a = await fetch(`${r.base}/events`, { headers: { authorization: `Bearer ${TOKEN_A}` } });
		assert.equal(a.headers.get('content-type'), 'text/event-stream');
		const live = events(a, 2);
		await new Promise(res => setTimeout(res, 50));
		assert.equal((await r.post('check_run', { action: 'completed', repository: { full_name: 'tenarkhq/Arkestra' }, installation: { id: 42 } })).status, 202);
		await r.post('issues', { action: 'opened', repository: { full_name: 'other/repo' } });
		await r.post('pull_request', { action: 'opened', repository: { full_name: 'tenarkhq/Arkestra' } });
		const got = await live;
		assert.deepEqual(got.map(e => [e.event, e.action, e.repository]), [['check_run', 'completed', 'tenarkhq/Arkestra'], ['pull_request', 'opened', 'tenarkhq/Arkestra']]);
		assert.equal(got[0].installation, 42);

		// Away since the first event: the replay brings the second, never the other repository's.
		const again = await fetch(`${r.base}/events`, { headers: { authorization: `Bearer ${TOKEN_A}`, 'last-event-id': String(got[0].id) } });
		const replay = await events(again, 1);
		assert.deepEqual(replay.map(e => e.event), ['pull_request']);

		const health = await (await fetch(`${r.base}/healthz`)).json();
		assert.equal(health.ok, true);
		assert.equal(health.buffered, 3);
	} finally {
		await r.close();
	}
});

test('the buffer keeps the newest events within its size', () => {
	const relay = createRelay({ secret: SECRET, clients: () => new Map(), bufferSize: 2 });
	for (let i = 0; i < 5; i++) {
		relay.publish({ id: i + 1, receivedAt: Date.now() });
	}
	assert.deepEqual(relay.buffer.map(e => e.id), [4, 5]);
});

test('webhooks without a secret: refused with 503 (no GitHub App yet), the relay still serves', async () => {
	const relay = createRelay({ secret: undefined, clients: () => readClients({ [TOKEN_A]: { repos: ['*'] } }) });
	const server = createServer(relay.handler);
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	try {
		const base = `http://127.0.0.1:${server.address().port}`;
		const res = await fetch(`${base}/github/webhook`, { method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
		assert.equal(res.status, 503);
		assert.equal((await fetch(`${base}/healthz`)).status, 200);
	} finally {
		server.close();
	}
});

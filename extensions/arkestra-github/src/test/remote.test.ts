/*---------------------------------------------------------------------------------------------
 *  Arkestra. Remote Control (AR36): the frame encryption (and that the phone's WebCrypto reads
 *  it), the pairing link, and the host's answers to phone commands.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RemoteHost, newPairing, pairingLink, seal, unseal, type Command, type RemoteRooms } from '../remote';

const subtle = (globalThis as any).crypto.subtle;

test('seal and unseal: round trip; a changed frame, another key or another channel fails', () => {
	const p = newPairing();
	assert.equal(p.channel.length, 22);
	assert.match(p.key, /^[A-Za-z0-9_-]{43}$/);
	const f = seal(p, { t: 'threads', threads: [{ id: 'a', title: 'Ünnep ✓' }] }, 'threads');
	assert.equal(f.topic, 'threads');
	assert.deepEqual(unseal(p, f), { t: 'threads', threads: [{ id: 'a', title: 'Ünnep ✓' }] });
	const data = Buffer.from(f.data, 'base64');
	data[0] ^= 1;
	assert.throws(() => unseal(p, { iv: f.iv, data: data.toString('base64') }));
	assert.throws(() => unseal({ ...p, key: newPairing().key }, f));
	assert.throws(() => unseal({ ...p, channel: newPairing().channel }, f), 'the channel is bound into the frame');
	assert.throws(() => unseal(p, { iv: f.iv, data: 'AAAA' }), /too short/);
});

test('the phone page\'s WebCrypto reads the host\'s frames and the host reads the phone\'s', async () => {
	const p = newPairing();
	const key = await subtle.importKey('raw', Buffer.from(p.key, 'base64url'), 'AES-GCM', false, ['encrypt', 'decrypt']);
	const additionalData = new TextEncoder().encode(p.channel);
	const f = seal(p, { t: 'ack', cmdId: 'c1', ok: true });
	const plain = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(f.iv, 'base64'), additionalData }, key, Buffer.from(f.data, 'base64'));
	assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), { t: 'ack', cmdId: 'c1', ok: true });
	const iv = new Uint8Array(12).fill(7);
	const sealed = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, new TextEncoder().encode(JSON.stringify({ t: 'say', id: 'a', text: 'hi' })));
	assert.deepEqual(unseal(p, { iv: Buffer.from(iv).toString('base64'), data: Buffer.from(sealed).toString('base64') }), { t: 'say', id: 'a', text: 'hi' });
});

test('pairing link: key and channel after # only', () => {
	const link = pairingLink('https://edge.example/arkestra/', { channel: 'C'.repeat(22), key: 'K'.repeat(43) });
	assert.equal(link, `https://edge.example/arkestra/remote/app#c=${'C'.repeat(22)}&k=${'K'.repeat(43)}`);
	assert.ok(!new URL(link).pathname.includes('K'));
});

function fakeHost(allowed: (id: string) => boolean) {
	const p = newPairing();
	const sent: { topic?: string; message: any }[] = [];
	const calls: string[] = [];
	const rooms: RemoteRooms = {
		threads: async () => [{ id: 'a', title: 'A', lastAt: '', agents: 1, busy: false, waiting: false }, { id: 'b', title: 'B', lastAt: '', agents: 1, busy: true, waiting: false }],
		thread: async id => id === 'gone' ? undefined : { id, title: id.toUpperCase() },
		say: async (id, text) => { calls.push(`say ${id} ${text}`); if (text === 'busy') { throw new Error('a round is running'); } },
		stop: async id => { calls.push(`stop ${id}`); },
		setChoice: async (id, agentId, c) => { calls.push(`choose ${id} ${agentId} ${JSON.stringify(c)}`); },
	};
	const fetch = (async (url: string, init: any) => {
		assert.ok(String(url).endsWith(`/remote/${p.channel}/up`));
		assert.equal(init.headers.authorization, 'Bearer tok');
		const frame = JSON.parse(init.body);
		sent.push({ topic: frame.topic, message: unseal(p, frame) });
		return new Response(null, { status: 202 });
	}) as unknown as typeof globalThis.fetch;
	const host = new RemoteHost({ relayUrl: 'https://edge/arkestra/', token: 'tok', pairing: p, rooms, allowed, onState: () => { }, fetch });
	return { host, sent, calls };
}

test('host: list and open publish only allowed threads', async () => {
	const { host, sent } = fakeHost(id => id !== 'b');
	await host.handle({ t: 'list' });
	const list = sent.shift()!;
	assert.equal(list.topic, 'threads');
	assert.deepEqual(list.message.threads.map((t: any) => t.id), ['a']);
	await host.handle({ t: 'open', id: 'a' });
	assert.deepEqual(sent.shift(), { topic: 'thread:a', message: { t: 'thread', thread: { id: 'a', title: 'A' } } });
	await host.handle({ t: 'open', id: 'b' });
	assert.deepEqual(sent.shift(), { topic: 'thread:b', message: { t: 'closed', id: 'b' } }, 'a thread that is off is not shown');
	await host.handle({ t: 'open', id: 'gone' });
	assert.deepEqual(sent.shift(), { topic: 'thread:gone', message: { t: 'closed', id: 'gone' } });
});

test('host: say, stop, choose reach the rooms and are acked; an off thread and a failure are refused', async () => {
	const { host, sent, calls } = fakeHost(id => id !== 'b');
	const run = async (c: Command) => { await host.handle(c); return sent.splice(0).map(s => s.message); };
	assert.deepEqual(await run({ t: 'say', id: 'a', text: 'hello', cmdId: '1' }), [{ t: 'ack', cmdId: '1', ok: true }]);
	assert.deepEqual(await run({ t: 'stop', id: 'a', cmdId: '2' }), [{ t: 'ack', cmdId: '2', ok: true }]);
	assert.deepEqual(await run({ t: 'choose', id: 'a', agentId: 'claude', model: 'opus', cmdId: '3' }), [{ t: 'ack', cmdId: '3', ok: true }]);
	assert.deepEqual(await run({ t: 'say', id: 'b', text: 'x', cmdId: '4' }), [{ t: 'ack', cmdId: '4', ok: false, error: 'Remote Control is off for this thread' }]);
	assert.deepEqual(await run({ t: 'say', id: 'a', text: 'busy', cmdId: '5' }), [{ t: 'ack', cmdId: '5', ok: false, error: 'a round is running' }]);
	assert.deepEqual(await run({ t: 'stop', id: 'a' }), [], 'no cmdId, no ack');
	assert.deepEqual(calls, ['say a hello', 'stop a', 'choose a claude {"model":"opus"}', 'say a busy', 'stop a']);
});

test('host: switching a watched thread off sends it closed', async () => {
	let on = true;
	const { host, sent } = fakeHost(id => on || id !== 'a');
	await host.handle({ t: 'open', id: 'a' });
	sent.splice(0);
	on = false;
	host.allowedChanged();
	await new Promise(r => setTimeout(r, 0));
	assert.deepEqual(sent.shift(), { topic: 'thread:a', message: { t: 'closed', id: 'a' } });
});

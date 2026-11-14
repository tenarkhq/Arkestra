/*---------------------------------------------------------------------------------------------
 *  Arkestra. The relay client: SSE parsing, backoff, event lines and a live stream with
 *  reconnect and Last-Event-ID.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RelayClient, backoff, describe, parseSseBlock, type RelayEvent, type RelayState } from '../relayClient';

test('SSE blocks: id, event, multi-line data; comments ignored', () => {
	assert.deepEqual(parseSseBlock('id: 7\nevent: github\ndata: {"a":1}'), { id: '7', event: 'github', data: '{"a":1}' });
	assert.deepEqual(parseSseBlock('data: one\ndata: two'), { event: 'message', data: 'one\ntwo' });
	assert.equal(parseSseBlock(': keepalive'), undefined);
});

test('backoff grows 1, 2, 4 … and stops at 30 s', () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(backoff), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('event lines name the PR or issue, the event and its result', () => {
	const e = (event: string, payload: any, action?: string): RelayEvent => ({ id: 1, delivery: 'd', event, action, repository: 'tenarkhq/Arkestra', receivedAt: 0, payload });
	assert.equal(describe(e('check_run', { check_run: { name: 'test', conclusion: 'failure', pull_requests: [{ number: 27 }] } }, 'completed')), '#27 · check_run completed · test · failure');
	assert.equal(describe(e('issues', { issue: { number: 5, title: 'Board' } }, 'opened')), '#5 · issues opened · Board');
	assert.equal(describe(e('push', { ref: 'refs/heads/main' })), 'tenarkhq/Arkestra · push · main');
});

/** A fake fetch: each call answers with the next scripted stream of SSE text. */
function fakeFetch(streams: (string[] | number)[], seen: Record<string, string>[]): typeof fetch {
	let call = 0;
	return (async (_url: any, init?: any) => {
		seen.push({ ...(init?.headers ?? {}) });
		const next = streams[call++];
		if (next === undefined) {
			return new Promise<never>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
		}
		if (typeof next === 'number') {
			return { ok: false, status: next, body: null } as any;
		}
		const encoder = new TextEncoder();
		const body = (async function* () {
			for (const part of next) {
				yield encoder.encode(part);
			}
		})();
		return { ok: true, status: 200, body } as any;
	}) as typeof fetch;
}

test('live stream: events arrive, a dropped stream reconnects and asks from the last id', async () => {
	const seen: Record<string, string>[] = [];
	const got: RelayEvent[] = [];
	const states: RelayState[] = [];
	const ev = (id: number, event: string) => `id: ${id}\nevent: github\ndata: ${JSON.stringify({ id, delivery: 'd', event, receivedAt: 0, payload: {} })}\n\n`;
	const client = new RelayClient({
		url: 'https://edge.example/arkestra/',
		token: 't'.repeat(32),
		fetch: fakeFetch([
			['event: hello\ndata: {}\n\n', ev(1, 'push').slice(0, 10), ev(1, 'push').slice(10), ev(2, 'issues')],
			503,
			[ev(3, 'check_run')],
		], seen),
		onEvent: e => got.push(e),
		onState: s => states.push(s),
	});
	const realSetTimeout = globalThis.setTimeout;
	(globalThis as any).setTimeout = (fn: () => void) => realSetTimeout(fn, 1); // no real waiting
	try {
		client.start();
		for (let i = 0; i < 100 && got.length < 3; i++) {
			await new Promise(r => realSetTimeout(r, 5));
		}
	} finally {
		(globalThis as any).setTimeout = realSetTimeout;
		client.stop();
	}
	assert.deepEqual(got.map(e => e.event), ['push', 'issues', 'check_run']);
	assert.equal(client.lastId, 3);
	assert.equal(seen[0].authorization, `Bearer ${'t'.repeat(32)}`);
	assert.equal(seen[0]['last-event-id'], undefined);
	assert.equal(seen[1]['last-event-id'], '2');
	assert.equal(seen[2]['last-event-id'], '2');
	const kinds = states.map(s => s.kind);
	assert.deepEqual(kinds.slice(0, 3), ['connecting', 'live', 'error']);
	assert.ok(states.some(s => s.kind === 'error' && /503/.test(s.message)));
	assert.equal(kinds.at(-1), 'off');
});

/*---------------------------------------------------------------------------------------------
 *  Arkestra. OpenAI adapter against a local HTTP server that speaks the Responses API.
 *--------------------------------------------------------------------------------------------*/

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIAgent, ROOM_INSTRUCTIONS, parseEvent, toInput } from '../openaiAgent';
import type { AgentEvent, Message } from '../rooms';

const msg = (kind: 'user' | 'agent' | 'system', id: string, text: string): Message =>
	({ id: Math.random().toString(36), at: new Date().toISOString(), author: { kind, id, name: id === 'user' ? 'You' : id.toUpperCase() }, text });

const requests: { method?: string; url?: string; auth?: string; body?: any }[] = [];
const sse = (res: ServerResponse, events: object[], end = true) => {
	res.writeHead(200, { 'Content-Type': 'text/event-stream' });
	for (const e of events) {
		res.write(`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`);
	}
	if (end) {
		res.end();
	}
};
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	let raw = '';
	for await (const chunk of req) {
		raw += chunk;
	}
	const body = raw ? JSON.parse(raw) : undefined;
	requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
	if (req.headers.authorization !== 'Bearer sk-good') {
		res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
		return;
	}
	if (req.url?.startsWith('/v1/models/')) {
		const found = req.url.endsWith('/gpt-6-astra');
		res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(found ? { id: 'gpt-6-astra' } : { error: { message: 'not found' } }));
		return;
	}
	const last: string = body.input.at(-1).content;
	if (last.includes('FAIL')) {
		return sse(res, [{ type: 'response.created' }, { type: 'response.failed', response: { error: { message: 'The server had an error' } } }]);
	}
	if (last.includes('HANG')) {
		return sse(res, [{ type: 'response.output_text.delta', delta: 'Start' }], false);
	}
	if (last.includes('CUT')) {
		return sse(res, [{ type: 'response.output_text.delta', delta: 'Half' }]);
	}
	sse(res, [{ type: 'response.created' }, { type: 'response.output_text.delta', delta: 'Hel' }, { type: 'response.output_text.delta', delta: 'lo.' }, { type: 'response.completed', response: {} }]);
});
let baseUrl = '';
before(async () => {
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});
after(() => { server.closeAllConnections(); server.close(); });
const agent = (key: string | null = 'sk-good', model = 'gpt-6-astra') => new OpenAIAgent({ model, baseUrl, apiKey: async () => key ?? undefined });
const never = () => new AbortController().signal;

test('a turn streams the answer and sends the thread with roles, the instructions and store off', async () => {
	requests.length = 0;
	const events: AgentEvent[] = [];
	const transcript = [msg('user', 'user', 'review this'), msg('agent', 'claude', 'I changed state.py'), msg('agent', 'gpt', 'Earlier answer'), msg('user', 'user', 'and now?')];
	await agent().turn({ roomId: 'r', transcript }, e => events.push(e), never());
	assert.deepEqual(events, [{ kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo.' }]);
	const [req] = requests;
	assert.equal(req.url, '/v1/responses');
	assert.equal(req.auth, 'Bearer sk-good');
	assert.equal(req.body.model, 'gpt-6-astra');
	assert.equal(req.body.instructions, ROOM_INSTRUCTIONS);
	assert.equal(req.body.store, false);
	assert.equal(req.body.stream, true);
	assert.deepEqual(req.body.input.map((i: any) => i.role), ['user', 'user', 'assistant', 'user']);
	assert.equal(req.body.input[1].content, '[CLAUDE (agent)]\nI changed state.py');
});

test('a failed response, a rejected key and a cut stream end the turn with an error', async () => {
	await assert.rejects(agent().turn({ roomId: 'r', transcript: [msg('user', 'user', 'FAIL')] }, () => { }, never()), /The server had an error/);
	await assert.rejects(agent('sk-bad').turn({ roomId: 'r', transcript: [msg('user', 'user', 'hi')] }, () => { }, never()), /Incorrect API key provided/);
	await assert.rejects(agent().turn({ roomId: 'r', transcript: [msg('user', 'user', 'CUT')] }, () => { }, never()), /ended early/);
	await assert.rejects(agent(null).turn({ roomId: 'r', transcript: [msg('user', 'user', 'hi')] }, () => { }, never()), /No OpenAI API key stored/);
});

test('cancelling a turn stops the stream quietly', async () => {
	const abort = new AbortController();
	const events: AgentEvent[] = [];
	const turn = agent().turn({ roomId: 'r', transcript: [msg('user', 'user', 'HANG')] }, e => events.push(e), abort.signal);
	setTimeout(() => abort.abort(), 200);
	await turn;
	assert.deepEqual(events, [{ kind: 'text', text: 'Start' }]);
});

test('readiness: no key, rejected key, unknown model, ready', async () => {
	assert.deepEqual(await agent(null).readiness(), { ready: false, reason: 'No OpenAI API key stored', fix: 'signIn' });
	assert.deepEqual(await agent('sk-bad').readiness(), { ready: false, reason: 'OpenAI API key rejected', fix: 'signIn' });
	assert.deepEqual(await agent('sk-good', 'gpt-nope').readiness(), { ready: false, reason: 'Model gpt-nope is not available to this key', fix: 'retry' });
	assert.deepEqual(await agent().readiness(), { ready: true });
});

test('system messages are labelled as the room', () => {
	assert.deepEqual(toInput([msg('system', 'room', 'Claude joined.')], 'gpt'), [{ role: 'user', content: '[room] Claude joined.' }]);
});

test('usage from the completed response', () => {
	assert.deepEqual(parseEvent({ type: 'response.completed', response: { usage: { input_tokens: 900, output_tokens: 100, input_tokens_details: { cached_tokens: 300 } } } }), { done: true, usage: { input: 900, output: 100, cached: 300, context: { used: 1000 } } });
	assert.deepEqual(parseEvent({ type: 'response.completed', response: {} }), { done: true });
});

#!/usr/bin/env node
// Arkestra webhook relay (AR28). Runs on the edge server: GitHub sends the Arkestra GitHub
// App's webhooks here, the relay checks their signature and passes each event on to the
// Arkestra clients allowed to see it, over Server-Sent Events. Clients behind NAT need no
// open port; a client that was away gets what it missed (Last-Event-ID, within the buffer).
//
//   WEBHOOK_SECRET=…  RELAY_CLIENTS_FILE=/etc/arkestra-relay/clients.json  node relay/server.mjs
//
// clients.json: { "<client token>": { "name": "Roland", "installations": [123], "repos": ["tenarkhq/Arkestra"] } }
// A client sees an event when its installation or its repository is listed ("*" for all).
// No dependencies; Node 18+.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRemote } from './remote.mjs';
import { createServer } from 'node:http';
import { readFileSync, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_BODY = 5 * 1024 * 1024;
const KEEPALIVE_MS = 25_000;

/** GitHub's X-Hub-Signature-256 check, in constant time. */
export function validSignature(secret, body, header) {
	if (typeof header !== 'string' || !header.startsWith('sha256=')) {
		return false;
	}
	const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
	const given = Buffer.from(header);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Checked client entries from the clients file's JSON. */
export function readClients(json) {
	const clients = new Map();
	for (const [token, c] of Object.entries(json && typeof json === 'object' ? json : {})) {
		if (typeof token !== 'string' || token.length < 24 || !c || typeof c !== 'object') {
			continue; // short tokens are refused: they would be guessable
		}
		clients.set(token, {
			name: typeof c.name === 'string' ? c.name : 'client',
			installations: Array.isArray(c.installations) ? c.installations.map(String) : [],
			repos: Array.isArray(c.repos) ? c.repos.map(r => String(r).toLowerCase()) : [],
		});
	}
	return clients;
}

/** Whether a client may see an event. */
export function allowed(client, event) {
	return client.installations.includes('*') || client.repos.includes('*')
		|| (event.installation !== undefined && client.installations.includes(String(event.installation)))
		|| (!!event.repository && client.repos.includes(event.repository.toLowerCase()));
}

/**
 * The relay: an HTTP handler, the event buffer and the connected clients.
 * options: { secret, clients: () => Map, bufferSize = 500, retentionMs = 24h, now = Date.now }
 */
export function createRelay(options) {
	const bufferSize = options.bufferSize ?? 500;
	const retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
	const now = options.now ?? Date.now;
	const buffer = [];
	const streams = new Set();
	let nextId = 1;
	let lastEventAt;

	const prune = () => {
		while (buffer.length > bufferSize || (buffer.length && now() - buffer[0].receivedAt > retentionMs)) {
			buffer.shift();
		}
	};

	const send = (res, event) => {
		res.write(`id: ${event.id}\nevent: github\ndata: ${JSON.stringify(event)}\n\n`);
	};

	const publish = event => {
		buffer.push(event);
		prune();
		lastEventAt = event.receivedAt;
		for (const s of streams) {
			if (allowed(s.client, event)) {
				send(s.res, event);
			}
		}
	};

	const json = (res, code, body) => {
		res.writeHead(code, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	};

	const remote = createRemote({ clients: options.clients, app: options.remoteApp, now });

	const tokenOf = (req, url) => {
		const auth = req.headers.authorization ?? '';
		return auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('token') ?? '';
	};

	const handler = (req, res) => {
		const url = new URL(req.url ?? '/', 'http://relay');
		if (req.method === 'GET' && url.pathname === '/healthz') {
			return json(res, 200, { ok: true, clients: streams.size, buffered: buffer.length, lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null });
		}
		if (req.method === 'POST' && url.pathname === '/github/webhook') {
			const chunks = [];
			let size = 0;
			req.on('data', c => {
				size += c.length;
				if (size > MAX_BODY) {
					json(res, 413, { error: 'too large' });
					req.destroy();
					return;
				}
				chunks.push(c);
			});
			req.on('end', () => {
				if (res.writableEnded) {
					return;
				}
				const body = Buffer.concat(chunks);
				if (!validSignature(options.secret, body, req.headers['x-hub-signature-256'])) {
					return json(res, 401, { error: 'bad signature' });
				}
				let payload;
				try {
					payload = JSON.parse(body.toString('utf8'));
				} catch {
					return json(res, 400, { error: 'not JSON' });
				}
				const event = {
					id: nextId++,
					delivery: String(req.headers['x-github-delivery'] ?? ''),
					event: String(req.headers['x-github-event'] ?? ''),
					action: typeof payload.action === 'string' ? payload.action : undefined,
					installation: payload.installation?.id,
					repository: payload.repository?.full_name ?? (payload.organization?.login ? `${payload.organization.login}/*` : undefined),
					receivedAt: now(),
					payload,
				};
				publish(event);
				return json(res, 202, { id: event.id });
			});
			return;
		}
		if (url.pathname.startsWith('/remote/') || url.pathname === '/remote') {
			return remote.handle(req, res, url, tokenOf(req, url));
		}
		if (req.method === 'GET' && url.pathname === '/events') {
			const client = options.clients().get(tokenOf(req, url));
			if (!client) {
				return json(res, 401, { error: 'unknown client token' });
			}
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
			res.write(`event: hello\ndata: ${JSON.stringify({ client: client.name, lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null })}\n\n`);
			// What the client missed while it was away.
			const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? 0);
			if (since > 0) {
				for (const e of buffer) {
					if (e.id > since && allowed(client, e)) {
						send(res, e);
					}
				}
			}
			const stream = { res, client };
			streams.add(stream);
			const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
			req.on('close', () => {
				clearInterval(keepalive);
				streams.delete(stream);
			});
			return;
		}
		json(res, 404, { error: 'not found' });
	};

	return { handler, publish, get size() { return streams.size; }, buffer, remote };
}

function main() {
	const secret = process.env.WEBHOOK_SECRET;
	const file = process.env.RELAY_CLIENTS_FILE;
	if (!secret || !file) {
		console.error('WEBHOOK_SECRET and RELAY_CLIENTS_FILE are required');
		process.exit(2);
	}
	let clients = readClients(JSON.parse(readFileSync(file, 'utf8')));
	// The clients file is read again when it changes: adding a client needs no restart.
	watchFile(file, { interval: 5000 }, () => {
		try {
			clients = readClients(JSON.parse(readFileSync(file, 'utf8')));
			console.log(`clients reloaded: ${clients.size}`);
		} catch (e) {
			console.error(`clients file not reloaded: ${e.message}`);
		}
	});
	let remoteApp;
	try {
		remoteApp = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote-app.html'));
	} catch {
		remoteApp = undefined; // Remote Control's phone page is optional
	}
	const relay = createRelay({ secret, clients: () => clients, remoteApp });
	const port = Number(process.env.PORT ?? 8787);
	const host = process.env.HOST ?? '127.0.0.1';
	createServer(relay.handler).listen(port, host, () => console.log(`arkestra relay on ${host}:${port}, ${clients.size} client(s)`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}

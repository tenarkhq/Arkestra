// Arkestra Remote Control (AR36): the relay passes end-to-end encrypted frames between an
// Arkestra IDE (the host) and the phones paired with it. The relay never sees the key: the
// pairing link carries it after '#', which browsers do not send. A channel exists only while
// its host is connected; when the machine goes off, the phones see it offline at once.
//
//   host:  GET  /remote/<channel>/host   SSE, Bearer <client token>: the phones' commands
//          POST /remote/<channel>/up     Bearer <client token>: one frame for the phones
//   phone: GET  /remote/<channel>/down   SSE: the host's frames (the latest per topic first)
//          POST /remote/<channel>/cmd    one frame for the host
//          GET  /remote/app              the phone page
//
// A frame is { topic?, iv, data } (base64 AES-GCM); the relay only checks its size.

const CHANNEL = /^[A-Za-z0-9_-]{22,64}$/;
const MAX_FRAME = 256 * 1024;
const KEEPALIVE_MS = 25_000;
const KEEP_TOPICS = 64;

export function validFrame(frame) {
	return !!frame && typeof frame === 'object' && typeof frame.iv === 'string' && typeof frame.data === 'string'
		&& frame.iv.length <= 64 && (frame.topic === undefined || (typeof frame.topic === 'string' && frame.topic.length <= 120));
}

export function createRemote(options) {
	/** channel → { host: res | undefined, owner: token, phones: Set<res>, topics: Map<topic, frame>, seq } */
	const channels = new Map();
	const now = options.now ?? Date.now;

	const json = (res, code, body) => {
		res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify(body));
	};
	const sse = res => {
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
	};
	const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	const readBody = req => new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', c => {
			size += c.length;
			if (size > MAX_FRAME) {
				reject(Object.assign(new Error('too large'), { code: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(Object.assign(new Error('not JSON'), { code: 400 }));
			}
		});
		req.on('error', reject);
	});
	const keepalive = (req, res) => {
		const timer = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
		req.on('close', () => clearInterval(timer));
	};
	const status = (ch, online) => {
		for (const phone of ch.phones) {
			send(phone, 'status', { online, at: now() });
		}
	};

	const handle = async (req, res, url, token) => {
		if (req.method === 'GET' && (url.pathname === '/remote/app' || url.pathname === '/remote' || url.pathname === '/remote/')) {
			if (!options.app) {
				return json(res, 404, { error: 'the phone page is not installed' });
			}
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-cache',
				'referrer-policy': 'no-referrer',
				'x-content-type-options': 'nosniff',
				'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			});
			return res.end(options.app);
		}
		const m = /^\/remote\/([^/]+)\/(host|up|down|cmd)$/.exec(url.pathname);
		if (!m || !CHANNEL.test(m[1])) {
			return json(res, 404, { error: 'not found' });
		}
		const [, id, what] = m;
		const client = (what === 'host' || what === 'up') ? options.clients().get(token) : undefined;

		if (what === 'host' && req.method === 'GET') {
			if (!client) {
				return json(res, 401, { error: 'unknown client token' });
			}
			let ch = channels.get(id);
			if (ch && ch.owner !== token) {
				return json(res, 409, { error: 'the channel belongs to another client' });
			}
			if (!ch) {
				ch = { host: undefined, owner: token, phones: new Set(), topics: new Map() };
				channels.set(id, ch);
			}
			ch.host?.end(); // one host per channel: a reconnect replaces the old stream
			ch.host = res;
			sse(res);
			send(res, 'hello', { phones: ch.phones.size });
			status(ch, true);
			keepalive(req, res);
			req.on('close', () => {
				if (ch.host === res) {
					ch.host = undefined;
					ch.topics.clear(); // nothing of an offline host stays on the relay
					status(ch, false);
					if (!ch.phones.size) {
						channels.delete(id);
					}
				}
			});
			return;
		}
		if (what === 'up' && req.method === 'POST') {
			const ch = channels.get(id);
			if (!client || !ch || ch.owner !== token) {
				return json(res, client ? 404 : 401, { error: client ? 'no such channel' : 'unknown client token' });
			}
			let frame;
			try {
				frame = await readBody(req);
			} catch (e) {
				return json(res, e.code ?? 400, { error: e.message });
			}
			if (!validFrame(frame)) {
				return json(res, 400, { error: 'bad frame' });
			}
			if (frame.topic) {
				ch.topics.delete(frame.topic);
				ch.topics.set(frame.topic, frame);
				while (ch.topics.size > KEEP_TOPICS) {
					ch.topics.delete(ch.topics.keys().next().value);
				}
			}
			for (const phone of ch.phones) {
				send(phone, 'frame', frame);
			}
			return json(res, 202, { phones: ch.phones.size });
		}
		if (what === 'down' && req.method === 'GET') {
			let ch = channels.get(id);
			if (!ch) {
				// A phone may come first: it waits for the host, and sees it offline until then.
				ch = { host: undefined, owner: undefined, phones: new Set(), topics: new Map() };
				channels.set(id, ch);
			}
			sse(res);
			send(res, 'status', { online: !!ch.host, at: now() });
			for (const frame of ch.topics.values()) {
				send(res, 'frame', frame);
			}
			ch.phones.add(res);
			if (ch.host) {
				send(ch.host, 'phones', { phones: ch.phones.size });
			}
			keepalive(req, res);
			req.on('close', () => {
				ch.phones.delete(res);
				if (ch.host) {
					send(ch.host, 'phones', { phones: ch.phones.size });
				} else if (!ch.phones.size) {
					channels.delete(id);
				}
			});
			return;
		}
		if (what === 'cmd' && req.method === 'POST') {
			const ch = channels.get(id);
			if (!ch?.host) {
				return json(res, 503, { error: 'the machine is offline' });
			}
			let frame;
			try {
				frame = await readBody(req);
			} catch (e) {
				return json(res, e.code ?? 400, { error: e.message });
			}
			if (!validFrame(frame)) {
				return json(res, 400, { error: 'bad frame' });
			}
			send(ch.host, 'cmd', { iv: frame.iv, data: frame.data });
			return json(res, 202, { ok: true });
		}
		json(res, 405, { error: 'method not allowed' });
	};

	return { handle, channels };
}

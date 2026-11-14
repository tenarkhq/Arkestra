/*---------------------------------------------------------------------------------------------
 *  Arkestra. Remote Control (AR36): the threads on a phone, through the relay, end to end
 *  encrypted (AES-256-GCM; the key travels only in the pairing link after '#'). The host side:
 *  it answers the phone's commands and sends the threads it is allowed to show. No VS Code.
 *--------------------------------------------------------------------------------------------*/

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { backoff, parseSseBlock } from './relayClient';

export interface Pairing {
	/** The relay channel: 16 random bytes, base64url. */
	readonly channel: string;
	/** The AES-256 key: 32 random bytes, base64url. */
	readonly key: string;
}

export interface Frame {
	readonly topic?: string;
	readonly iv: string;
	readonly data: string;
}

export function newPairing(): Pairing {
	return { channel: randomBytes(16).toString('base64url'), key: randomBytes(32).toString('base64url') };
}

/** The phone page's link: the key and channel after '#', which the browser never sends anywhere. */
export function pairingLink(relayUrl: string, p: Pairing): string {
	return `${relayUrl.replace(/\/+$/, '')}/remote/app#c=${p.channel}&k=${p.key}`;
}

/** Encrypts a message for the channel (the channel id is the additional data). */
export function seal(p: Pairing, message: unknown, topic?: string): Frame {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', Buffer.from(p.key, 'base64url'), iv);
	cipher.setAAD(Buffer.from(p.channel));
	const body = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final(), cipher.getAuthTag()]);
	return { ...(topic ? { topic } : {}), iv: iv.toString('base64'), data: body.toString('base64') };
}

/** Decrypts a frame; throws on a wrong key or a changed frame. */
export function unseal(p: Pairing, frame: { iv: string; data: string }): unknown {
	const body = Buffer.from(frame.data, 'base64');
	if (body.length < 17) {
		throw new Error('frame too short');
	}
	const decipher = createDecipheriv('aes-256-gcm', Buffer.from(p.key, 'base64url'), Buffer.from(frame.iv, 'base64'));
	decipher.setAAD(Buffer.from(p.channel));
	decipher.setAuthTag(body.subarray(body.length - 16));
	return JSON.parse(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8'));
}

/** What the host needs from the rooms extension. */
export interface RemoteRooms {
	threads(): Promise<readonly { id: string; title: string; lastAt: string; agents: number; busy: boolean; waiting: boolean }[]>;
	thread(id: string): Promise<unknown | undefined>;
	say(id: string, text: string): Promise<void>;
	stop(id: string): Promise<void>;
	setChoice(id: string, agentId: string, choice: { model?: string; effort?: string }): Promise<void>;
}

export type RemoteState =
	| { readonly kind: 'off' }
	| { readonly kind: 'connecting' }
	| { readonly kind: 'on'; readonly phones: number }
	| { readonly kind: 'error'; readonly message: string };

export type Command =
	| { t: 'list' }
	| { t: 'open'; id: string }
	| { t: 'say'; id: string; text: string; cmdId?: string }
	| { t: 'stop'; id: string; cmdId?: string }
	| { t: 'choose'; id: string; agentId: string; model?: string; effort?: string; cmdId?: string };

export interface RemoteHostOptions {
	readonly relayUrl: string;
	readonly token: string;
	readonly pairing: Pairing;
	readonly rooms: RemoteRooms;
	/** Whether a thread may be shown: all threads, or the ones switched on. */
	readonly allowed: (id: string) => boolean;
	readonly onState: (s: RemoteState) => void;
	readonly onCommand?: (c: Command, ok: boolean) => void;
	readonly fetch?: typeof fetch;
	readonly debounceMs?: number;
}

export class RemoteHost {
	private abort: AbortController | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private attempt = 0;
	private stopped = true;
	private phones = 0;
	/** Threads a phone opened: their changes are sent as they happen. */
	private readonly watched = new Set<string>();
	private readonly dirty = new Set<string>();
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private listDirty = false;

	constructor(private readonly o: RemoteHostOptions) { }

	private get base(): string {
		return `${this.o.relayUrl.replace(/\/+$/, '')}/remote/${this.o.pairing.channel}`;
	}

	start(): void {
		if (!this.stopped) {
			return;
		}
		this.stopped = false;
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		clearTimeout(this.flushTimer);
		this.abort?.abort(); // the relay closes the channel: phones see the machine offline
		this.o.onState({ kind: 'off' });
	}

	/** A thread changed in the IDE. */
	changed(id: string): void {
		this.listDirty = true;
		if (this.watched.has(id)) {
			this.dirty.add(id);
		}
		this.schedule();
	}

	/** The allowed threads changed: the list again, and closed threads leave the phones. */
	allowedChanged(): void {
		for (const id of [...this.watched]) {
			if (!this.o.allowed(id)) {
				this.watched.delete(id);
				void this.publish({ t: 'closed', id }, `thread:${id}`);
			}
		}
		this.listDirty = true;
		this.schedule();
	}

	private schedule(): void {
		if (this.stopped || !this.phones) {
			return;
		}
		clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => void this.flush(), this.o.debounceMs ?? 300);
	}

	async flush(): Promise<void> {
		if (this.listDirty) {
			this.listDirty = false;
			await this.sendList();
		}
		const ids = [...this.dirty];
		this.dirty.clear();
		for (const id of ids) {
			await this.sendThread(id);
		}
	}

	private async publish(message: unknown, topic?: string): Promise<void> {
		const res = await (this.o.fetch ?? fetch)(`${this.base}/up`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.o.token}`, 'content-type': 'application/json' },
			body: JSON.stringify(seal(this.o.pairing, message, topic)),
		});
		if (!res.ok && res.status !== 404) {
			throw new Error(`relay answered ${res.status}`);
		}
	}

	private async sendList(): Promise<void> {
		const threads = (await this.o.rooms.threads()).filter(t => this.o.allowed(t.id));
		await this.publish({ t: 'threads', threads, at: Date.now() }, 'threads');
	}

	private async sendThread(id: string): Promise<void> {
		if (!this.o.allowed(id)) {
			return;
		}
		const thread = await this.o.rooms.thread(id);
		await this.publish(thread ? { t: 'thread', thread } : { t: 'closed', id }, `thread:${id}`);
	}

	/** One command from a phone. Exported for tests through `handle`. */
	async handle(c: Command): Promise<void> {
		const ack = async (ok: boolean, error?: string) => {
			this.o.onCommand?.(c, ok);
			if ('cmdId' in c && c.cmdId) {
				await this.publish({ t: 'ack', cmdId: c.cmdId, ok, ...(error ? { error } : {}) });
			}
		};
		try {
			switch (c.t) {
				case 'list':
					await this.sendList();
					return;
				case 'open':
					if (!this.o.allowed(c.id)) {
						await this.publish({ t: 'closed', id: c.id }, `thread:${c.id}`);
						return;
					}
					this.watched.add(c.id);
					await this.sendThread(c.id);
					return;
				case 'say':
				case 'stop':
				case 'choose':
					if (!this.o.allowed(c.id)) {
						await ack(false, 'Remote Control is off for this thread');
						return;
					}
					if (c.t === 'say') {
						await this.o.rooms.say(c.id, String(c.text ?? '').slice(0, 20_000));
					} else if (c.t === 'stop') {
						await this.o.rooms.stop(c.id);
					} else {
						await this.o.rooms.setChoice(c.id, String(c.agentId), { ...(c.model ? { model: String(c.model) } : {}), ...(c.effort ? { effort: String(c.effort) } : {}) });
					}
					this.watched.add(c.id);
					await ack(true);
					return;
			}
		} catch (error) {
			await ack(false, error instanceof Error ? error.message : String(error));
		}
	}

	private async connect(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.attempt++;
		this.o.onState({ kind: 'connecting' });
		this.abort = new AbortController();
		try {
			const res = await (this.o.fetch ?? fetch)(`${this.base}/host`, { headers: { authorization: `Bearer ${this.o.token}`, accept: 'text/event-stream' }, signal: this.abort.signal });
			if (res.status === 401) {
				throw new Error('the relay does not know this client token');
			}
			if (res.status === 409) {
				throw new Error('this channel belongs to another client: make a new pairing');
			}
			if (!res.ok || !res.body) {
				throw new Error(`relay answered ${res.status}`);
			}
			this.attempt = 0;
			this.o.onState({ kind: 'on', phones: this.phones });
			const decoder = new TextDecoder();
			let buf = '';
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
				let end: number;
				while ((end = buf.indexOf('\n\n')) >= 0) {
					const block = parseSseBlock(buf.slice(0, end));
					buf = buf.slice(end + 2);
					if (!block?.data) {
						continue;
					}
					if (block.event === 'hello' || block.event === 'phones') {
						const n = Number(JSON.parse(block.data).phones) || 0;
						const joined = n > this.phones;
						this.phones = n;
						this.o.onState({ kind: 'on', phones: n });
						if (joined) {
							this.listDirty = true;
							this.watched.forEach(id => this.dirty.add(id));
							this.schedule();
						}
					} else if (block.event === 'cmd') {
						let command: Command;
						try {
							command = unseal(this.o.pairing, JSON.parse(block.data)) as Command;
						} catch {
							continue; // not from a paired phone
						}
						void this.handle(command);
					}
				}
			}
			throw new Error('the relay closed the stream');
		} catch (error) {
			if (this.stopped) {
				return;
			}
			this.phones = 0;
			const wait = backoff(this.attempt);
			this.o.onState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
			this.timer = setTimeout(() => void this.connect(), wait);
		}
	}
}

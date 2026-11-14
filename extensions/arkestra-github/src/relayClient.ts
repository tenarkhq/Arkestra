/*---------------------------------------------------------------------------------------------
 *  Arkestra. The webhook relay's client (AR28): one Server-Sent Events stream from the edge
 *  relay, read with fetch; it reconnects with a growing pause and asks for what it missed
 *  (Last-Event-ID). No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

/** One GitHub event as the relay passes it on. */
export interface RelayEvent {
	readonly id: number;
	readonly delivery: string;
	/** `X-GitHub-Event`: `check_run`, `pull_request`, `issues`, `projects_v2_item`… */
	readonly event: string;
	readonly action?: string;
	readonly installation?: number;
	readonly repository?: string;
	readonly receivedAt: number;
	readonly payload: any;
}

export type RelayState =
	| { readonly kind: 'off' }
	| { readonly kind: 'connecting'; readonly attempt: number }
	| { readonly kind: 'live'; readonly since: number }
	| { readonly kind: 'error'; readonly message: string; readonly retryAt: number };

/** One SSE block: its id, event name and data lines. */
export function parseSseBlock(block: string): { id?: string; event: string; data: string } | undefined {
	let id: string | undefined;
	let event = 'message';
	const data: string[] = [];
	for (const line of block.split('\n')) {
		if (!line || line.startsWith(':')) {
			continue;
		}
		const colon = line.indexOf(':');
		const field = colon < 0 ? line : line.slice(0, colon);
		const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
		if (field === 'id') {
			id = value;
		} else if (field === 'event') {
			event = value;
		} else if (field === 'data') {
			data.push(value);
		}
	}
	return data.length || id ? { ...(id !== undefined ? { id } : {}), event, data: data.join('\n') } : undefined;
}

/** The pause before reconnect attempt `n` (1, 2, 4 … 30 s). */
export function backoff(attempt: number): number {
	return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** A short line for an event, as the log and the sync journal show it: `#27 · check_run completed`. */
export function describe(e: RelayEvent): string {
	const p = e.payload ?? {};
	const number = p.pull_request?.number ?? p.issue?.number ?? p.check_run?.pull_requests?.[0]?.number ?? p.workflow_run?.pull_requests?.[0]?.number;
	const what = [e.event, e.action].filter(Boolean).join(' ');
	const name = p.check_run?.name ?? p.workflow_run?.name ?? p.pull_request?.title ?? p.issue?.title ?? (e.event === 'push' && typeof p.ref === 'string' ? p.ref.replace('refs/heads/', '') : undefined);
	const result = p.check_run?.conclusion ?? p.workflow_run?.conclusion;
	return [number ? `#${number}` : e.repository, what, name, result].filter(Boolean).join(' · ');
}

export interface RelayClientOptions {
	readonly url: string;
	readonly token: string;
	readonly fetch?: typeof fetch;
	readonly onEvent: (e: RelayEvent) => void;
	readonly onState: (s: RelayState) => void;
	readonly now?: () => number;
}

export class RelayClient {
	private abort: AbortController | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastEventId = 0;
	private attempt = 0;
	private stopped = true;

	constructor(private readonly options: RelayClientOptions) { }

	get lastId(): number {
		return this.lastEventId;
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
		this.abort?.abort();
		this.options.onState({ kind: 'off' });
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private async connect(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.attempt++;
		this.options.onState({ kind: 'connecting', attempt: this.attempt });
		this.abort = new AbortController();
		const url = `${this.options.url.replace(/\/+$/, '')}/events`;
		try {
			const res = await (this.options.fetch ?? fetch)(url, {
				headers: { authorization: `Bearer ${this.options.token}`, accept: 'text/event-stream', ...(this.lastEventId ? { 'last-event-id': String(this.lastEventId) } : {}) },
				signal: this.abort.signal,
			});
			if (res.status === 401) {
				throw new Error('the relay does not know this client token');
			}
			if (!res.ok || !res.body) {
				throw new Error(`relay answered ${res.status}`);
			}
			this.attempt = 0;
			this.options.onState({ kind: 'live', since: this.now() });
			const decoder = new TextDecoder();
			let buf = '';
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
				let end: number;
				while ((end = buf.indexOf('\n\n')) >= 0) {
					const block = parseSseBlock(buf.slice(0, end));
					buf = buf.slice(end + 2);
					if (block?.event === 'github' && block.data) {
						try {
							const e = JSON.parse(block.data) as RelayEvent;
							this.lastEventId = Math.max(this.lastEventId, Number(block.id ?? e.id) || 0);
							this.options.onEvent(e);
						} catch { /* a broken event is skipped */ }
					}
				}
			}
			throw new Error('the relay closed the stream');
		} catch (error) {
			if (this.stopped) {
				return;
			}
			const wait = backoff(this.attempt);
			this.options.onState({ kind: 'error', message: error instanceof Error ? error.message : String(error), retryAt: this.now() + wait });
			this.timer = setTimeout(() => void this.connect(), wait);
		}
	}
}

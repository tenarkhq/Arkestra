/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Claude sessions of the claude.ai account, the list the Claude desktop app and
 *  the phone show (a CLI session there carries a `bridge-session` line with its `cse_…` id):
 *  their names and whether they are archived, and archiving, restoring and renaming them, so
 *  that a thread looks the same in every app. Through the same calls Claude Code makes, with
 *  the sign-in Claude Code keeps on the machine; Arkestra only reads it, never refreshes it
 *  (a refresh would sign the CLI out), and waits while it is out of date.
 *--------------------------------------------------------------------------------------------*/

import type { CloudSession, CloudSessions } from './rooms';

const BASE = 'https://api.anthropic.com';
/** A token this close to its end is not used: the CLI on that machine refreshes it soon. */
const MARGIN_MS = 60_000;
const PAGES = 20;

/** The script that prints Claude Code's sign-in on a POSIX machine: its file, else the macOS keychain item. */
export const CREDENTIALS_SCRIPT = [
	'f="$HOME/.claude/.credentials.json"',
	'if [ -f "$f" ]; then cat "$f"; elif command -v security >/dev/null 2>&1; then security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null; fi',
	'exit 0',
].join('\n');

export interface Credentials { readonly token: string; readonly expiresAt: number }

/** The claude.ai sign-in out of Claude Code's credentials; undefined: none (an API key, or signed out). */
export function parseCredentials(text: string): Credentials | undefined {
	try {
		const oauth = JSON.parse(text.trim())?.claudeAiOauth;
		return typeof oauth?.accessToken === 'string' && oauth.accessToken ? { token: oauth.accessToken, expiresAt: Number(oauth.expiresAt) || 0 } : undefined;
	} catch {
		return undefined;
	}
}

/** One row of the account's list, as Arkestra uses it. */
export function cloudSession(row: unknown): CloudSession | undefined {
	const r = row as { id?: unknown; title?: unknown; status?: unknown; last_event_at?: unknown; updated_at?: unknown } | undefined;
	if (typeof r?.id !== 'string' || !r.id.startsWith('cse_')) {
		return undefined;
	}
	const at = typeof r.last_event_at === 'string' ? r.last_event_at : typeof r.updated_at === 'string' ? r.updated_at : undefined;
	return { id: r.id, title: typeof r.title === 'string' ? r.title.trim() : '', archived: r.status === 'archived', ...(at ? { at } : {}) };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class CloudClient implements CloudSessions {
	private credentials: Credentials | undefined;

	constructor(
		/** Claude Code's credentials file (or keychain item) on the agent's machine. */
		private readonly read: () => Promise<string>,
		/** Where that machine is, for the messages. */
		private readonly where: string,
		private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
		private readonly now: () => number = Date.now,
	) { }

	async list(): Promise<readonly CloudSession[]> {
		const out: CloudSession[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < PAGES; page++) {
			const r = await this.call('GET', `/v1/code/sessions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
			const body = await r.json() as { data?: unknown[]; next_cursor?: unknown };
			for (const row of body.data ?? []) {
				const s = cloudSession(row);
				if (s) {
					out.push(s);
				}
			}
			cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : undefined;
			if (!cursor) {
				break;
			}
		}
		return out;
	}

	async archive(id: string): Promise<void> {
		await this.call('POST', `/v1/code/sessions/${session(id)}/archive`, {}, [409]);
	}

	async unarchive(id: string): Promise<void> {
		await this.call('POST', `/v1/code/sessions/${session(id)}/unarchive`, {}, [409]);
	}

	async rename(id: string, title: string): Promise<void> {
		await this.call('PUT', `/v1/code/sessions/${session(id)}`, { title });
	}

	private async token(): Promise<string> {
		if (!this.credentials || this.credentials.expiresAt - MARGIN_MS < this.now()) {
			this.credentials = parseCredentials(await this.read());
		}
		if (!this.credentials) {
			throw new Error(`Claude Code on ${this.where} is not signed in to claude.ai.`);
		}
		if (this.credentials.expiresAt && this.credentials.expiresAt - MARGIN_MS < this.now()) {
			throw new Error(`The claude.ai sign-in of Claude Code on ${this.where} is out of date; it renews the next time Claude runs there.`);
		}
		return this.credentials.token;
	}

	private async call(method: string, pathAndQuery: string, body?: unknown, alsoFine: readonly number[] = []): Promise<{ status: number; json(): Promise<unknown> }> {
		for (let attempt = 0; ; attempt++) {
			const token = await this.token();
			const r = await this.fetchFn(`${BASE}${pathAndQuery}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(15_000),
			});
			if (r.status === 401 && attempt === 0) {
				this.credentials = undefined; // renewed on the machine since: read it again once
				continue;
			}
			if ((r.status >= 200 && r.status < 300) || alsoFine.includes(r.status)) {
				return r;
			}
			const text = await r.text().catch(() => '');
			const message = (() => { try { return (JSON.parse(text) as { error?: { message?: string } }).error?.message; } catch { return undefined; } })();
			throw new Error(message ? `claude.ai: ${message}` : `claude.ai answered ${r.status}`);
		}
	}
}

function session(id: string): string {
	if (!/^cse_[A-Za-z0-9]+$/.test(id)) {
		throw new Error(`not a claude.ai session id: ${id}`);
	}
	return id;
}

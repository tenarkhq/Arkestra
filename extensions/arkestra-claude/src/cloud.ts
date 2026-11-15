/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Claude sessions of the claude.ai account, the list the Claude desktop app and
 *  the phone show (a CLI session there carries a `bridge-session` line with its `cse_…` id):
 *  their names and whether they are archived, and archiving, restoring and renaming them, so
 *  that a thread looks the same in every app. Through the same calls Claude Code makes, with
 *  the sign-in Claude Code keeps on the machine; Arkestra only reads it, never refreshes it
 *  (a refresh would sign the CLI out), and waits while it is out of date.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
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

/**
 * A message Arkestra sends into a session the Claude app runs, with its sender named. claude.ai
 * takes a message for the user's own only from its own apps; one from Arkestra reaches the
 * session as another session's, and this envelope (the one Claude Code's sessions use between
 * themselves) at least tells that session it came from Arkestra.
 */
export function fromArkestra(text: string): string {
	// No session's name (a reply by name would reach that session): the user, writing in Arkestra.
	return `<cross-session-message from="arkestra-app" from-name="The user, writing in the Arkestra app">\n${text.replace(/<\/cross-session-message/gi, '<\\/cross-session-message')}\n</cross-session-message>`;
}

/** The words of such a message as the session file keeps it (whatever the receiving CLI put around it); the text unchanged otherwise. */
export function arkestraWords(text: string): string {
	const inner = /<cross-session-message from="arkestra(?:-app)?"[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(text)?.[1];
	return inner === undefined ? text : inner.replace(/<\\\/cross-session-message/gi, '</cross-session-message').trim();
}

/** One row of the account's list, as Arkestra uses it. */
export function cloudSession(row: unknown): CloudSession | undefined {
	const r = row as { id?: unknown; title?: unknown; status?: unknown; last_event_at?: unknown; updated_at?: unknown; worker_status?: unknown; unread?: unknown; external_metadata?: { context_usage?: { used_tokens?: unknown; max_tokens?: unknown } } } | undefined;
	if (typeof r?.id !== 'string' || !r.id.startsWith('cse_')) {
		return undefined;
	}
	const at = typeof r.last_event_at === 'string' ? r.last_event_at : typeof r.updated_at === 'string' ? r.updated_at : undefined;
	const usage = r.external_metadata?.context_usage;
	const context = typeof usage?.used_tokens === 'number' && typeof usage.max_tokens === 'number' && usage.max_tokens > 0 ? { used: usage.used_tokens, max: usage.max_tokens } : undefined;
	return {
		id: r.id, title: typeof r.title === 'string' ? r.title.trim() : '', archived: r.status === 'archived', ...(at ? { at } : {}),
		...(typeof r.worker_status === 'string' ? { worker: r.worker_status } : {}), ...(r.unread === true ? { unread: true } : {}),
		...(context ? { context } : {}),
	};
}

/** The quota windows the account reports (`/api/oauth/usage`), with the labels the CLI's own report uses. */
const QUOTA_WINDOWS: readonly (readonly [string, string])[] = [['five_hour', '5h'], ['seven_day', 'week'], ['seven_day_opus', 'week · Opus'], ['seven_day_sonnet', 'week · Sonnet']];

export function accountLimits(body: unknown): { label: string; usedPercent: number; resetsAt?: string }[] {
	const b = body as Record<string, { utilization?: unknown; resets_at?: unknown } | null | undefined> | undefined;
	const out: { label: string; usedPercent: number; resetsAt?: string }[] = [];
	for (const [key, label] of QUOTA_WINDOWS) {
		const w = b?.[key];
		if (w && typeof w.utilization === 'number') {
			out.push({ label, usedPercent: Math.round(w.utilization), ...(typeof w.resets_at === 'string' ? { resetsAt: w.resets_at } : {}) });
		}
	}
	return out;
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

	/**
	 * A message into a session the Claude app runs now, as the phone sends it: that app's Claude
	 * answers it there, and the answer reaches Arkestra through the session file like any other.
	 */
	async send(id: string, text: string): Promise<void> {
		const payload = { uuid: randomUUID(), session_id: session(id), type: 'user', parent_tool_use_id: null, message: { role: 'user', content: fromArkestra(text) } };
		await this.call('POST', `/v1/code/sessions/${session(id)}/events`, { events: [{ payload }] });
	}

	async archive(id: string): Promise<void> {
		await this.call('POST', `/v1/code/sessions/${session(id)}/archive`, {}, [409]);
	}

	async unarchive(id: string): Promise<void> {
		await this.call('POST', `/v1/code/sessions/${session(id)}/unarchive`, {}, [409]);
	}

	async markRead(id: string): Promise<void> {
		await this.call('POST', `/v1/code/sessions/${session(id)}/mark_read`, {});
	}

	/** The account's quota now: the share of each window used, as the Claude app shows it. */
	async usage(): Promise<{ label: string; usedPercent: number; resetsAt?: string }[]> {
		const r = await this.call('GET', '/api/oauth/usage', undefined, [], { 'anthropic-beta': 'oauth-2025-04-20' });
		return accountLimits(await r.json());
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

	private async call(method: string, pathAndQuery: string, body?: unknown, alsoFine: readonly number[] = [], extra: Record<string, string> = {}): Promise<{ status: number; json(): Promise<unknown> }> {
		for (let attempt = 0; ; attempt++) {
			const token = await this.token();
			const r = await this.fetchFn(`${BASE}${pathAndQuery}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...extra },
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
			const error = (() => { try { return (JSON.parse(text) as { error?: { message?: string; type?: string } }).error; } catch { return undefined; } })();
			if (error?.type === 'session_not_active') {
				throw new Error('The session is archived in the Claude app. Restore it there (or here) to go on.');
			}
			throw new Error(error?.message ? `claude.ai: ${error.message}` : `claude.ai answered ${r.status}`);
		}
	}
}

function session(id: string): string {
	if (!/^cse_[A-Za-z0-9]+$/.test(id)) {
		throw new Error(`not a claude.ai session id: ${id}`);
	}
	return id;
}

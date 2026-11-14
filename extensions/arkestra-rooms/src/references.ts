/*---------------------------------------------------------------------------------------------
 *  Arkestra. @-references in a room message: @file:, @diff, @terminal, @thread:, @brief:,
 *  @web:. They are found in the text, resolved by the room (referencesUi.ts) and sent to the
 *  agents as attached material after the message. Plain @Name mentions are left alone.
 *--------------------------------------------------------------------------------------------*/

export type ReferenceKind = 'file' | 'diff' | 'terminal' | 'thread' | 'brief' | 'web';

export const REFERENCE_KINDS: readonly ReferenceKind[] = ['file', 'diff', 'terminal', 'thread', 'brief', 'web'];

/** Kinds that work without an argument: @diff (working tree), @terminal (last command). */
const BARE: readonly ReferenceKind[] = ['diff', 'terminal'];

export interface Reference {
	readonly kind: ReferenceKind;
	/** The argument after the colon, unquoted; '' for a bare @diff / @terminal. */
	readonly arg: string;
	/** The token as written, for the attachment's heading. */
	readonly token: string;
}

export interface Attachment {
	readonly label: string;
	readonly text: string;
	/** Fence language, when the text is code. */
	readonly language?: string;
	/** The text was cut to the limit. */
	readonly truncated?: boolean;
}

/** Separates the message from its attached material in the stored text. */
export const ATTACHMENTS_MARKER = '\n\n---\nHivatkozott anyagok';

/** Per-attachment character limits. */
export const LIMITS: Record<ReferenceKind, number> = { file: 100_000, diff: 60_000, terminal: 30_000, thread: 40_000, brief: 40_000, web: 40_000 };

/**
 * The references in a message, in order, each once. A token starts at the line start or
 * after whitespace or an opening bracket; an argument is quoted ("…") when it has spaces.
 */
export function parseReferences(text: string): Reference[] {
	const out: Reference[] = [];
	const seen = new Set<string>();
	const re = /(^|[\s([{])@(file|diff|terminal|thread|brief|web)(?::(?:"([^"\n]+)"|([^\s)\]}]+)))?(?=$|[\s)\]},.;!?])/gm;
	for (const m of text.matchAll(re)) {
		const kind = m[2] as ReferenceKind;
		const arg = (m[3] ?? m[4] ?? '').replace(/[.,;:!?]+$/, '');
		if (!arg && !BARE.includes(kind)) {
			continue;
		}
		const token = `@${kind}${arg ? `:${/\s/.test(arg) ? `"${arg}"` : arg}` : ''}`;
		if (!seen.has(token)) {
			seen.add(token);
			out.push({ kind, arg, token });
		}
	}
	return out;
}

/** `path#L10-40` or `path#L7` → the path and the 1-based inclusive line range. */
export function fileTarget(arg: string): { path: string; from?: number; to?: number } {
	const m = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(arg);
	if (!m) {
		return { path: arg };
	}
	const from = Number(m[2]);
	const to = m[3] ? Number(m[3]) : from;
	return { path: m[1], from: Math.min(from, to), to: Math.max(from, to) };
}

/** Cuts a text to `limit` characters at a line end, saying so. */
export function cap(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	const cut = text.lastIndexOf('\n', limit);
	return { text: text.slice(0, cut > limit / 2 ? cut : limit), truncated: true };
}

const fence = (text: string, language = '') => {
	const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map(m => m[0].length + 1)));
	return `${ticks}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${ticks}`;
};

/** The message with its material: what the agents get and the room stores. */
export function withAttachments(message: string, attachments: readonly Attachment[]): string {
	if (!attachments.length) {
		return message;
	}
	const parts = attachments.map(a => `### ${a.label}${a.truncated ? ' (levágva)' : ''}\n\n${fence(a.text, a.language)}`);
	return `${message}${ATTACHMENTS_MARKER} (${attachments.length}):\n\n${parts.join('\n\n')}`;
}

/** The message alone, without the attached material (thread history, titles). */
export function withoutAttachments(text: string): { message: string; count: number } {
	const at = text.indexOf(ATTACHMENTS_MARKER);
	if (at < 0) {
		return { message: text, count: 0 };
	}
	const count = Number(/^ \((\d+)\)/.exec(text.slice(at + ATTACHMENTS_MARKER.length))?.[1] ?? 0);
	return { message: text.slice(0, at), count };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A web page as readable text: no scripts, styles or tags; block elements become lines. */
export function htmlToText(html: string): { title?: string; text: string } {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	const decode = (s: string) => s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all);
	const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
		.replace(/<(script|style|noscript|svg|template|head|nav|footer)\b[\s\S]*?<\/\1>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(br|hr)\b[^>]*>/gi, '\n')
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
		.replace(/<\/(p|div|section|article|h[1-6]|tr|pre|blockquote|table|ul|ol)>/gi, '\n')
		.replace(/<(td|th)\b[^>]*>/gi, ' | ')
		.replace(/<[^>]+>/g, '');
	const text = decode(body).split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
	return { ...(title ? { title: decode(title).trim() } : {}), text };
}

/** Removes terminal colour and cursor codes from captured output. */
export function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '');
}

/** The completion list for what was typed after '@': kinds first, then matching items. */
export function completionKinds(query: string): ReferenceKind[] {
	const q = query.replace(/^@/, '').toLowerCase();
	return REFERENCE_KINDS.filter(k => k.startsWith(q.split(':')[0]));
}

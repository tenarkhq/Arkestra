/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude Code's own sessions on a machine (AR39): ~/.claude/projects/<folder>/<id>.jsonl.
 *  Listed and read the same way here and over SSH: the machine sends a short listing (or the
 *  session file), parsed here. No VS Code.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { ExistingSession, SessionEntry } from './rooms';
import { assemble, type Piece } from './follow';
import { folderStore, withImages, type ImageStore, type SessionImage } from './sessionImages';

const MARK = '\u001eFILE ';
/** How many sessions a machine lists, newest first. */
export const LIST_LIMIT = 60;
const HEAD_BYTES = 262_144;
const CANDIDATES = /"type":"(summary|user|custom-title)"/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The listing on a POSIX machine: per session its time, file, and the lines that name it. */
export const LIST_SCRIPT = [
	'cd "$HOME/.claude/projects" 2>/dev/null || exit 0',
	`for f in $(ls -t */*.jsonl 2>/dev/null | grep -v '/agent-' | head -n ${LIST_LIMIT}); do`,
	`  printf '\\036FILE %s %s\\n' "$(date -r "$f" +%s 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"`,
	`  head -c ${HEAD_BYTES} "$f" | grep -E '"type":"(summary|user|custom-title)"' | head -n 8`,
	'done',
].join('\n');

/** The script that prints one session file (the id is checked before it gets here). */
export function readScript(id: string): string {
	if (!SESSION_ID.test(id)) {
		throw new Error(`not a Claude session id: ${id}`);
	}
	return `cat "$HOME"/.claude/projects/*/${id}.jsonl 2>/dev/null | head -c 50000000`;
}

/** The same listing on this machine, without a shell (Windows too). */
export async function localListing(home: string): Promise<string> {
	const root = path.join(home, '.claude', 'projects');
	let dirs: string[];
	try {
		dirs = await fs.readdir(root);
	} catch {
		return '';
	}
	const files: { file: string; rel: string; mtime: number }[] = [];
	await Promise.all(dirs.map(async dir => {
		const names = await fs.readdir(path.join(root, dir)).catch(() => [] as string[]);
		await Promise.all(names.filter(n => n.endsWith('.jsonl') && !n.startsWith('agent-')).map(async name => {
			const file = path.join(root, dir, name);
			const stat = await fs.stat(file).catch(() => undefined);
			if (stat?.isFile()) {
				files.push({ file, rel: `${dir}/${name}`, mtime: Math.floor(stat.mtimeMs / 1000) });
			}
		}));
	}));
	files.sort((a, b) => b.mtime - a.mtime);
	const parts = await Promise.all(files.slice(0, LIST_LIMIT).map(async f => {
		const handle = await fs.open(f.file, 'r');
		try {
			const buf = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
			const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n').filter(l => CANDIDATES.test(l)).slice(0, 8);
			return `${MARK}${f.mtime} ${f.rel}\n${lines.join('\n')}`;
		} finally {
			await handle.close();
		}
	}));
	return parts.join('\n');
}

/** Where a session file is on this machine, if anywhere. */
export async function localSessionPath(home: string, id: string): Promise<string | undefined> {
	if (!SESSION_ID.test(id)) {
		throw new Error(`not a Claude session id: ${id}`);
	}
	const root = path.join(home, '.claude', 'projects');
	for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
		const file = path.join(root, dir, `${id}.jsonl`);
		if ((await fs.stat(file).catch(() => undefined))?.isFile()) {
			return file;
		}
	}
	return undefined;
}

/** The session file on this machine. */
export async function localSessionFile(home: string, id: string): Promise<string> {
	const file = await localSessionPath(home, id);
	const text = file ? await fs.readFile(file, 'utf8').catch(() => undefined) : undefined;
	if (text === undefined) {
		throw new Error('the session file is gone');
	}
	return text;
}

/** The shell line that finds a session file on a POSIX machine (`f`, empty when there is none). */
export function locateScript(id: string): string {
	if (!SESSION_ID.test(id)) {
		throw new Error(`not a Claude session id: ${id}`);
	}
	return `f=$(ls "$HOME"/.claude/projects/*/${id}.jsonl 2>/dev/null | head -n 1)`;
}

/** A JSON line, or what can be read from a line cut short (a long first message). */
function readLine(line: string): any {
	try {
		return JSON.parse(line);
	} catch {
		const field = (name: string) => {
			const m = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)`).exec(line);
			if (!m) {
				return undefined;
			}
			for (let s = m[1]; s; s = s.slice(0, -1)) {
				try {
					return JSON.parse(`"${s}"`) as string;
				} catch { /* cut inside an escape: shorten */ }
			}
			return undefined;
		};
		const type = field('type');
		if (type === 'user') {
			return { type, cwd: field('cwd'), message: { content: field('content') ?? (field('text') ? [{ type: 'text', text: field('text') }] : undefined) }, isMeta: /"isMeta":true/.test(line) };
		}
		return type ? { type, summary: field('summary'), customTitle: field('customTitle') } : undefined;
	}
}

/** Text a person wrote, not a tool result, a slash command's echo or an interruption note. */
function userText(content: unknown): string | undefined {
	let text: string | undefined;
	if (typeof content === 'string') {
		text = content;
	} else if (Array.isArray(content)) {
		if (content.some(b => b?.type === 'tool_result')) {
			return undefined;
		}
		text = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') || undefined;
	}
	text = text?.trim();
	if (!text || /^(<command-|<local-command|Caveat: |\[Request interrupted)/.test(text)) {
		return undefined;
	}
	return text;
}

const ARKESTRA_ROOM = 'You are Claude in an Arkestra room';

/** The sessions of a listing, newest first; those Arkestra's own rooms started are left out. */
export function parseListing(out: string): ExistingSession[] {
	const sessions: ExistingSession[] = [];
	for (const record of out.split(MARK).slice(1)) {
		const [head, ...lines] = record.split('\n');
		const m = /^(\d+) (.+\.jsonl)$/.exec(head.trim());
		const id = m ? path.posix.basename(m[2], '.jsonl') : '';
		if (!m || !SESSION_ID.test(id)) {
			continue;
		}
		let title: string | undefined;
		let summary: string | undefined;
		let first: string | undefined;
		let cwd: string | undefined;
		for (const line of lines) {
			const data = line.trim() ? readLine(line) : undefined;
			if (data?.type === 'custom-title' && typeof data.customTitle === 'string') {
				title ??= data.customTitle;
			} else if (data?.type === 'summary' && typeof data.summary === 'string') {
				summary ??= data.summary;
			} else if (data?.type === 'user' && !data.isMeta && !data.isSidechain) {
				cwd ??= typeof data.cwd === 'string' ? data.cwd : undefined;
				first ??= userText(data.message?.content);
			}
		}
		if (first?.startsWith(ARKESTRA_ROOM)) {
			continue;
		}
		const line = (s: string) => { const l = s.split('\n')[0].trim(); return l.length > 80 ? l.slice(0, 79).trimEnd() + '…' : l; };
		sessions.push({ id, title: line(title || summary || first || id.slice(0, 8)), ...(cwd ? { cwd } : {}), updatedAt: new Date(Number(m[1]) * 1000).toISOString() });
	}
	return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A background task's report to Claude (`<task-notification>`): its summaries, for a short room line. */
export function taskNotice(text: string): string | undefined {
	if (!text.startsWith('<task-notification>')) {
		return undefined;
	}
	const summaries = [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1].trim()).filter(Boolean);
	return summaries.join(' · ') || 'Background task finished';
}

/** Where the pictures of Claude Code sessions are kept on this machine (beside its own sessions). */
let imageStore: ImageStore = folderStore(path.join(homedir(), '.claude', 'arkestra-images'));

/** Another store (tests). */
export function setImageStore(store: ImageStore): void {
	imageStore = store;
}

/** The pictures of a user message: image blocks with base64 bytes or a web address. */
export function claudeImages(content: unknown): SessionImage[] {
	if (!Array.isArray(content)) {
		return [];
	}
	return content.flatMap((b: any): SessionImage[] => {
		const source = b?.type === 'image' ? b.source : undefined;
		if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
			return [{ data: source.data, mime: source.media_type }];
		}
		if (source?.type === 'url' && typeof source.url === 'string') {
			return [{ url: source.url }];
		}
		return [];
	});
}

/** One line of a session file as the thread sees it: what the user wrote (with its pictures), Claude's text, a task report. */
export function claudePiece(line: string): Piece {
	let data: any;
	try {
		data = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!data || data.isSidechain || data.isMeta || data.isCompactSummary) {
		return undefined;
	}
	const base = { ...(typeof data.uuid === 'string' ? { id: data.uuid } : {}), ...(typeof data.timestamp === 'string' ? { at: data.timestamp } : {}) };
	if (data.type === 'user') {
		const content = data.message?.content;
		const raw = typeof content === 'string' ? content
			: Array.isArray(content) && !content.some(b => b?.type === 'tool_result') ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
		const notice = taskNotice(raw.trim());
		if (notice) {
			return { kind: 'notice', text: notice, ...base };
		}
		const text = userText(content);
		const images = Array.isArray(content) && !content.some((b: any) => b?.type === 'tool_result') ? claudeImages(content) : [];
		if (images.length && (text || !raw.trim())) {
			// Claude Code's own placeholders ([Image #1]) give way to the pictures.
			return { kind: 'user', text: withImages((text ?? '').replace(/\[Image #\d+\]/g, '').replace(/[ \t]{2,}/g, ' ').trim(), images, imageStore), ...base };
		}
		return text ? { kind: 'user', text, ...base } : undefined;
	}
	if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
		const text = data.message.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b: any) => b.text.trim()).join('\n\n');
		return text ? { kind: 'agent', text, ...base } : undefined;
	}
	return undefined;
}

/**
 * A session file as thread messages: what the user wrote and Claude's answers, one answer per
 * request (its tool steps left out), under the id of the line each began with.
 */
export function parseHistory(text: string, limit = 300): SessionEntry[] {
	return assemble(text, claudePiece, limit);
}

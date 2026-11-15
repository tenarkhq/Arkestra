/*---------------------------------------------------------------------------------------------
 *  Arkestra. Claude Code's own sessions on a machine (AR39): ~/.claude/projects/<folder>/<id>.jsonl.
 *  Listed and read the same way here and over SSH: the machine sends a short listing (or the
 *  session file), parsed here. No VS Code.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { ExistingSession, SessionEntry, SessionHistory, SessionMeta } from './rooms';
import { EntryAssembler, LineSplitter, type Piece } from './follow';
import { folderStore, withImages, type ImageStore, type SessionImage } from './sessionImages';

const MARK = '\u001eFILE ';
/** How many sessions a machine lists, newest first. */
export const LIST_LIMIT = 60;
/**
 * How many of the newest session files the listing looks at to find them: scripts and agent
 * pipelines (`claude -p`, the Agent SDK) write many sessions nobody chats in, and those are
 * skipped, so the people's own threads are not pushed out of the list.
 */
export const SCAN_LIMIT = 2000;
/** How much of a file's start tells who wrote the session (its first lines name the entrypoint). */
export const KIND_BYTES = 16_384;
/** A session a script or an agent pipeline ran (`claude -p`, the Agent SDK), not a chat. */
export const AUTOMATED = /"entrypoint":"sdk-/;
/** The folder of sessions run in a temporary folder (/tmp, macOS's /var/folders): throwaway runs, not chats. */
export const TEMP_FOLDER = /^-(private-)?(tmp|var-folders)(-|$)/;
const HEAD_BYTES = 262_144;
const CANDIDATES = /"type":"(summary|user|custom-title)"/;
/** How much of a session file's end the listing reads for the name: Claude Code writes it again near the end. */
const TAIL_BYTES = 131_072;
/** The lines that hold the name the person gave (custom-title) or the apps show (agent-name). */
const NAMES = /"type":"(custom-title|agent-name)"/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The listing on a POSIX machine: per session its time, file, and the lines that name it. One
 * `head` reads the start of the newest files (/dev/null first, so it always prints the file
 * headers) and awk keeps the first LIST_LIMIT that are no script's or pipeline's. Sessions
 * of a temporary folder are left out too (TEMP_FOLDER).
 */
export const LIST_SCRIPT = [
	'cd "$HOME/.claude/projects" 2>/dev/null || exit 0',
	// ./ first: the folders are named after paths (-home-...), which ls and head would read as options.
	`files=$(ls -t ./*/*.jsonl 2>/dev/null | grep -v -E '/agent-|^\\./-(private-)?(tmp|var-folders)[-/]' | head -n ${SCAN_LIMIT})`,
	'[ -n "$files" ] || exit 0',
	`for f in $(head -c ${KIND_BYTES} /dev/null $files 2>/dev/null | awk -v max=${LIST_LIMIT} '`,
	`  /^==> .* <==$/ { if (f != "" && f != "/dev/null" && !auto) { print f; if (++n >= max) exit } f = substr($0, 5, length($0) - 8); auto = 0; next }`,
	`  /"entrypoint":"sdk-/ { auto = 1 }`,
	`  END { if (f != "" && f != "/dev/null" && !auto && n < max) print f }'); do`,
	`  [ "$f" = /dev/null ] && continue`,
	`  printf '\\036FILE %s %s\\n' "$(date -r "$f" +%s 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"`,
	`  head -c ${HEAD_BYTES} "$f" | grep -E '"type":"(summary|user|custom-title)"' | head -n 8`,
	`  tail -c ${TAIL_BYTES} "$f" | grep -E '"type":"(custom-title|agent-name)"' | tail -n 4`,
	'done',
].join('\n');

/** How much of a session file the history reads: its end, where the latest messages are. */
export const READ_MAX = 50_000_000;

/**
 * The script that prints the end of one session file (the id is checked before it gets here):
 * a first line `\036AT <offset>` says where in the file the bytes start; exit 3: no such file.
 */
export function readScript(id: string): string {
	return [
		locateScript(id),
		'[ -n "$f" ] && [ -f "$f" ] || exit 3',
		`s=$(wc -c < "$f" | tr -d ' ')`,
		`n=$(( s > ${READ_MAX} ? s - ${READ_MAX} : 0 ))`,
		`printf '\\036AT %s\\n' "$n"`,
		'exec tail -c +$((n + 1)) "$f"',
	].join('\n');
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
	await Promise.all(dirs.filter(dir => !TEMP_FOLDER.test(dir)).map(async dir => {
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
	// The newest sessions that are chats, as the shell listing finds them.
	const parts: string[] = [];
	for (const f of files.slice(0, SCAN_LIMIT)) {
		if (parts.length >= LIST_LIMIT) {
			break;
		}
		const handle = await fs.open(f.file, 'r').catch(() => undefined);
		if (!handle) {
			continue;
		}
		try {
			const kind = Buffer.alloc(KIND_BYTES);
			const start = await handle.read(kind, 0, KIND_BYTES, 0);
			if (AUTOMATED.test(kind.subarray(0, start.bytesRead).toString('utf8'))) {
				continue;
			}
			const buf = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
			const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n').filter(l => CANDIDATES.test(l)).slice(0, 8);
			const size = (await handle.stat()).size;
			const from = Math.max(0, size - TAIL_BYTES);
			const end = Buffer.alloc(size - from);
			const read = await handle.read(end, 0, end.length, from);
			lines.push(...end.subarray(0, read.bytesRead).toString('utf8').split('\n').filter(l => NAMES.test(l)).slice(-4));
			parts.push(`${MARK}${f.mtime} ${f.rel}\n${lines.join('\n')}`);
		} finally {
			await handle.close();
		}
	}
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
		return type ? { type, summary: field('summary'), customTitle: field('customTitle'), agentName: field('agentName') } : undefined;
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
	if (!text || /^(<command-|<local-command|<system-reminder>|Caveat: |\[Request interrupted)/.test(text)) {
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
		let named: string | undefined;
		let summary: string | undefined;
		let first: string | undefined;
		let cwd: string | undefined;
		for (const line of lines) {
			const data = line.trim() ? readLine(line) : undefined;
			// The latest name wins: Claude Code appends a new line on every rename.
			if (data?.type === 'custom-title' && typeof data.customTitle === 'string' && data.customTitle.trim()) {
				title = data.customTitle;
			} else if (data?.type === 'agent-name' && typeof data.agentName === 'string' && data.agentName.trim()) {
				named = data.agentName;
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
		sessions.push({ id, title: line(title || named || summary || first || id.slice(0, 8)), ...(cwd ? { cwd } : {}), updatedAt: new Date(Number(m[1]) * 1000).toISOString() });
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

/** The thread's line where Claude Code compacted the conversation (summed it up and went on from the summary). */
export const COMPACTED = 'Conversation compacted';

/** The summary Claude Code writes after a compaction, known by its text too (a line without the flag). */
export function isCompactSummary(text: string): boolean {
	return /This session is being continued from a previous conversation/.test(text.slice(0, 1000));
}

type Base = { readonly id?: string; readonly at?: string };

/** What the user wrote (a message, or a message sent while Claude worked), with its pictures; a task report as a short line. */
function userPiece(content: unknown, base: Base): Piece {
	const raw = typeof content === 'string' ? content
		: Array.isArray(content) && !content.some(b => b?.type === 'tool_result') ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
	const notice = taskNotice(raw.trim());
	if (notice) {
		return { kind: 'notice', text: notice, ...base };
	}
	if (isCompactSummary(raw)) {
		return undefined;
	}
	const text = userText(content);
	const images = Array.isArray(content) && !content.some((b: any) => b?.type === 'tool_result') ? claudeImages(content) : [];
	if (images.length && (text || !raw.trim())) {
		// Claude Code's own placeholders ([Image #1]) give way to the pictures.
		return { kind: 'user', text: withImages((text ?? '').replace(/\[Image #\d+\]/g, '').replace(/[ \t]{2,}/g, ' ').trim(), images, imageStore), ...base };
	}
	return text ? { kind: 'user', text, ...base } : undefined;
}

/** One parsed line as the thread sees it. */
function pieceOf(data: any): Piece {
	if (!data || data.isSidechain || data.isMeta || data.isCompactSummary || data.isVisibleInTranscriptOnly) {
		return undefined;
	}
	const base: Base = { ...(typeof data.uuid === 'string' ? { id: data.uuid } : {}), ...(typeof data.timestamp === 'string' ? { at: data.timestamp } : {}) };
	if (data.type === 'user') {
		return userPiece(data.message?.content, base);
	}
	if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
		const text = data.message.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b: any) => b.text.trim()).join('\n\n');
		return text ? { kind: 'agent', text, ...base } : undefined;
	}
	if (data.type === 'system' && data.subtype === 'compact_boundary') {
		return { kind: 'notice', text: COMPACTED, ...base };
	}
	// A message the user sent while Claude was working: Claude Code hands it over mid-turn and
	// keeps it as an attachment line (its queue-operation lines say the same again: not read).
	const a = data.type === 'attachment' ? data.attachment : undefined;
	if (a?.type === 'queued_command') {
		if (a.commandMode === 'task-notification') {
			const notice = typeof a.prompt === 'string' ? taskNotice(a.prompt.trim()) : undefined;
			return notice ? { kind: 'notice', text: notice, ...base } : undefined;
		}
		return a.commandMode === undefined || a.commandMode === 'prompt' ? userPiece(a.prompt, base) : undefined;
	}
	return undefined;
}

/** What a parsed line says about the session: the model and context fill of a main-chain answer. */
function metaOf(data: any): SessionMeta | undefined {
	const m = data?.type === 'assistant' && !data.isSidechain ? data.message : undefined;
	if (typeof m?.model !== 'string' || !m.model || m.model.startsWith('<')) {
		return undefined; // `<synthetic>`: Claude Code's own stand-in answer
	}
	const u = m.usage;
	const context = u && typeof u === 'object' ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0;
	return { model: m.model, ...(context > 0 ? { context } : {}) };
}

/**
 * One line of a session file as the thread sees it: what the user wrote (with its pictures, also
 * while Claude worked), Claude's text, a task report, a compaction.
 */
export function claudePiece(line: string): Piece {
	let data: any;
	try {
		data = JSON.parse(line);
	} catch {
		return undefined;
	}
	return pieceOf(data);
}

/**
 * A line that can hold what Claude produced with its tools (AR26): a tool use (Write, Edit, the
 * Artifact tool), or a tool's result that names a claude.ai artifact. The rest (text, the results
 * of reads and commands: most of a long session file) is not handed on, so a 50 MB read stays small.
 */
export function claudeToolLine(line: string): boolean {
	return line.includes('"tool_use"') || (line.includes('"tool_result"') && line.includes('claude.ai/'));
}

/** The model and context fill one line tells, if it tells them (an answer of the main chain). */
export function claudeMeta(line: string): SessionMeta | undefined {
	if (!line.includes('"assistant"')) {
		return undefined;
	}
	try {
		return metaOf(JSON.parse(line));
	} catch {
		return undefined;
	}
}

/**
 * A session file read the way the live follow reads it: the same entries under the same ids,
 * the room's own turns left out, its latest model and context fill, and the cursor the follow
 * goes on from. Fed in pieces from `offset` (the end of a long file); with `header`, the bytes
 * start with the read script's `\036AT <offset>` line.
 */
export class ClaudeHistory {
	private splitter: LineSplitter;
	private readonly assembler = new EntryAssembler({ mute: true });
	private readonly entries: SessionEntry[] = [];
	/** The tool lines read (`claudeToolLine`), for what Claude produced (AR26). */
	private lines: string[] = [];
	private meta: SessionMeta | undefined;
	private head: Buffer | undefined;

	constructor(offset = 0, header = false) {
		this.splitter = new LineSplitter(offset);
		this.head = header ? Buffer.alloc(0) : undefined;
	}

	push(chunk: Buffer): void {
		if (this.head) {
			this.head = Buffer.concat([this.head, chunk]);
			const nl = this.head.indexOf(10);
			if (nl < 0) {
				return;
			}
			const m = /^\u001eAT (\d+)$/.exec(this.head.toString('utf8', 0, nl));
			chunk = this.head.subarray(nl + 1);
			this.head = undefined;
			this.splitter = new LineSplitter(m ? Number(m[1]) : 0);
		}
		for (const line of this.splitter.push(chunk)) {
			this.line(line.text, line.start);
		}
	}

	private line(text: string, start: number): void {
		if (!text.trim()) {
			return;
		}
		let data: any;
		try {
			data = JSON.parse(text);
		} catch {
			return; // the first line of a read from the middle, or one still being written
		}
		if (claudeToolLine(text)) {
			this.lines.push(text);
		}
		const meta = metaOf(data);
		if (meta) {
			this.meta = { ...this.meta, ...meta };
		}
		const entry = this.assembler.feed(pieceOf(data), start);
		if (!entry) {
			return;
		}
		const last = this.entries.at(-1);
		if (entry.role === 'agent' && last?.role === 'agent' && last.id === entry.id) {
			this.entries[this.entries.length - 1] = entry; // the same answer, grown
		} else {
			this.entries.push(entry);
		}
	}

	/**
	 * The latest `limit` entries, where the follow goes on (after the last whole line, or where an
	 * answer still growing began), the model and fill, and the tool lines read. The lines are
	 * handed over once: this reader lets go of them.
	 */
	result(limit = 300): SessionHistory & { readonly cursor: string } {
		const lines = this.lines;
		this.lines = [];
		return { entries: this.entries.slice(-limit), cursor: this.assembler.cursor(this.splitter.position), ...(this.meta ? { meta: this.meta } : {}), ...(lines.length ? { lines } : {}) };
	}
}

/**
 * A session file as thread messages: what the user wrote and Claude's answers, one answer per
 * request (its tool steps left out), under the id of the line each began with.
 */
export function parseHistory(text: string, limit = 300): SessionEntry[] {
	const history = new ClaudeHistory();
	history.push(Buffer.from(text.endsWith('\n') ? text : `${text}\n`));
	return [...history.result(limit).entries];
}

/** The end of a session file on this machine (at most READ_MAX bytes), read in pieces. */
export async function localHistory(home: string, id: string, limit = 300): Promise<SessionHistory> {
	const file = await localSessionPath(home, id);
	const handle = file ? await fs.open(file, 'r').catch(() => undefined) : undefined;
	if (!handle) {
		throw new Error('the session file is gone');
	}
	try {
		const { size } = await handle.stat();
		const from = Math.max(0, size - READ_MAX);
		const history = new ClaudeHistory(from);
		for (let pos = from; pos < size;) {
			const buf = Buffer.alloc(Math.min(1 << 20, size - pos));
			const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
			if (!bytesRead) {
				break;
			}
			history.push(buf.subarray(0, bytesRead));
			pos += bytesRead;
		}
		return history.result(limit);
	} finally {
		await handle.close();
	}
}

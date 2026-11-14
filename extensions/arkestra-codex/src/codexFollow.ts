/*---------------------------------------------------------------------------------------------
 *  Arkestra. A Codex thread's rollout file (CODEX_HOME/sessions/…/rollout-<time>-<id>.jsonl)
 *  read live (AR39): what its lines mean for the thread, and where the file is. No VS Code.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { EntryAssembler, LineSplitter, type Piece } from './follow';
import type { SessionEntry, SessionHistory } from './rooms';
import { dataUrlImage, folderStore, withImages, type ImageStore, type SessionImage } from './sessionImages';

const THREAD_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{1,79}$/;

/**
 * What Codex itself puts before the user's first words (the folder, AGENTS.md, the user's own
 * instructions): a user message in older rollouts, never something the user wrote.
 */
const CODEX_PREAMBLE = /^(<environment_context>|<user_instructions>|<INSTRUCTIONS>|# AGENTS\.md instructions for )/;

/** Where the pictures of Codex sessions are kept on this machine (beside its own sessions). */
let imageStore: ImageStore = folderStore(path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'arkestra-images'));

/** Another store (tests). */
export function setImageStore(store: ImageStore): void {
	imageStore = store;
}

function textOf(content: unknown): string {
	return (Array.isArray(content) ? content : []).map((c: any) => typeof c?.text === 'string' ? c.text : '').join('\n').trim();
}

/** A picture as Codex names it: a data: URL, a web address or a file on its machine. */
function codexImage(value: unknown): SessionImage | undefined {
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}
	const v = value.trim();
	return /^data:/i.test(v) ? dataUrlImage(v) : /^https:\/\//i.test(v) ? { url: v } : /^(\/|~\/|[A-Za-z]:[\\/])/.test(v) ? { path: v.startsWith('~/') ? path.join(homedir(), v.slice(2)) : v } : undefined;
}

/**
 * The pictures in a user message's content: rollout items (`image` / `input_image` with a URL,
 * `local_image` with a path) and the app server's (`image` with `url`, `localImage` with `path`).
 */
export function codexImages(content: unknown): SessionImage[] {
	return (Array.isArray(content) ? content : []).flatMap((c: any): SessionImage[] => {
		const type = typeof c?.type === 'string' ? c.type : '';
		const image = /^(image|input_image)$/.test(type) ? codexImage(c.image_url ?? c.url ?? c.imageUrl)
			: /^(local_image|localImage)$/.test(type) ? codexImage(c.path)
				: undefined;
		return image ? [image] : [];
	});
}

/** A user message's text with its pictures under it as markdown images (kept once on this machine). */
export function codexUserText(text: string, images: readonly SessionImage[]): string {
	return withImages(text, images, imageStore);
}

/**
 * One rollout line as the thread sees it: what the user wrote and Codex's messages. Newer Codex
 * reports finished items (`item_completed`, with ids); older Codex `user_message` and
 * `agent_message` events (no ids: the follower uses the line's place).
 */
export function codexPiece(line: string): Piece {
	let data: any;
	try {
		data = JSON.parse(line);
	} catch {
		return undefined;
	}
	const p = data?.type === 'event_msg' ? data.payload : undefined;
	if (!p || typeof p !== 'object') {
		return undefined;
	}
	const at = typeof data.timestamp === 'string' ? { at: data.timestamp } : {};
	if (p.type === 'item_completed') {
		const item = p.item;
		const kind = item?.type === 'UserMessage' ? 'user' : item?.type === 'AgentMessage' ? 'agent' : undefined;
		const raw = kind ? textOf(item.content) : '';
		if (kind === 'user' && CODEX_PREAMBLE.test(raw)) {
			return undefined;
		}
		const text = kind === 'user' ? codexUserText(raw, codexImages(item.content)) : raw;
		return kind && text ? { kind, text, ...(typeof item.id === 'string' ? { id: item.id } : {}), ...at } : undefined;
	}
	if (p.type === 'user_message') {
		const raw = typeof p.message === 'string' ? p.message.trim() : '';
		if (CODEX_PREAMBLE.test(raw)) {
			return undefined;
		}
		const images = [...(Array.isArray(p.images) ? p.images : []), ...(Array.isArray(p.local_images) ? p.local_images : [])].map(codexImage).filter((i): i is SessionImage => !!i);
		const text = codexUserText(raw, images);
		return text ? { kind: 'user', text, ...at } : undefined;
	}
	if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) {
		return { kind: 'agent', text: p.message.trim(), ...at };
	}
	return undefined;
}

/**
 * A rollout file read from its start (the history import), the way the live follow reads it:
 * the same entries under the same ids, the room's own turns left out, and the cursor the
 * follow goes on from, so nothing written after the read is lost and nothing comes twice.
 * Codex 0.163 keeps a thread's turns "paginated": thread/read gives none, the file has them all.
 */
export class RolloutHistory {
	private readonly splitter = new LineSplitter();
	private readonly assembler = new EntryAssembler({ mute: true, positional: true });
	private readonly entries: SessionEntry[] = [];

	push(chunk: Buffer): void {
		for (const line of this.splitter.push(chunk)) {
			const entry = line.text.trim() ? this.assembler.feed(codexPiece(line.text), line.start) : undefined;
			if (!entry) {
				continue;
			}
			if (entry.id !== undefined && this.entries.at(-1)?.id === entry.id) {
				this.entries[this.entries.length - 1] = entry; // the same answer, grown
			} else {
				this.entries.push(entry);
			}
		}
	}

	/**
	 * The entries read, the latest `limit` of them, and the follow's cursor: after the last whole
	 * line, or at the start of an answer that may still grow (the follow reads it again, same id).
	 */
	result(limit = 300): Required<SessionHistory> {
		return { entries: this.entries.slice(-limit), cursor: this.assembler.cursor(this.splitter.position) };
	}
}

/** A whole rollout file's content as history and follow cursor. */
export function rolloutHistory(content: Buffer, limit = 300): Required<SessionHistory> {
	const history = new RolloutHistory();
	history.push(content);
	return history.result(limit);
}

/** Reads a rollout file on this machine up to its size now, in pieces (a long thread is many MB). */
export async function readLocalRollout(file: string, limit = 300): Promise<Required<SessionHistory>> {
	const handle = await fs.open(file, 'r');
	try {
		const { size } = await handle.stat();
		const history = new RolloutHistory();
		for (let pos = 0; pos < size;) {
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

/** The thread id, checked before it goes into a file name or a shell line. */
export function checkThreadId(id: string): string {
	if (!THREAD_ID.test(id)) {
		throw new Error(`not a Codex thread id: ${id}`);
	}
	return id;
}

/** The rollout file of a thread under these Codex homes on this machine, if any. */
export async function localRollout(homes: readonly string[], id: string): Promise<string | undefined> {
	const suffix = `-${checkThreadId(id)}.jsonl`;
	const walk = async (dir: string, depth: number): Promise<string | undefined> => {
		const names = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => b.name.localeCompare(a.name)); // newest days first
		for (const n of names) {
			if (n.isFile() && n.name.startsWith('rollout-') && n.name.endsWith(suffix)) {
				return path.join(dir, n.name);
			}
		}
		if (depth > 0) {
			for (const n of names.filter(n => n.isDirectory())) {
				const found = await walk(path.join(dir, n.name), depth - 1);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	};
	for (const home of homes) {
		const found = await walk(path.join(home, 'sessions'), 3);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/** POSIX single-quote quoting. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A Codex home for the remote shell: `~/…` from $HOME, the rest quoted. */
function remoteHome(home: string): string {
	return home === '~' ? '"$HOME"' : home.startsWith('~/') ? `"$HOME"/${shQuote(home.slice(2))}` : shQuote(home);
}

/** The shell line that sets `f` to the thread's rollout file on a POSIX machine: the known path, or a search of the homes. */
export function locateRolloutScript(id: string, known: string | undefined, homes: readonly string[]): string {
	if (known) {
		return `f=${shQuote(known)}`;
	}
	const dirs = homes.map(h => `${remoteHome(h)}/sessions`).join(' ');
	return `f=$(find ${dirs} -name 'rollout-*-${checkThreadId(id)}.jsonl' 2>/dev/null | head -n 1)`;
}

/** The script that prints a thread's rollout file on a POSIX machine (exit 3: no such file). */
export function readRolloutScript(locate: string): string {
	return [locate, '[ -n "$f" ] && [ -f "$f" ] || exit 3', 'exec cat "$f"'].join('\n');
}

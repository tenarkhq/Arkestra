/*---------------------------------------------------------------------------------------------
 *  Arkestra. Following a CLI session live (AR39): the lines appended to its JSONL file, read
 *  here (fs.watch with a polling fallback) or on an SSH machine (`tail -F`), turned into thread
 *  entries. The same file in arkestra-claude and arkestra-codex; each brings its line reader.
 *  No VS Code.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, watch, type FSWatcher } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { SessionEntry, SessionMeta } from './rooms';

/** What one line of a session file means for the thread, if anything. */
/** `step`: what the agent did with its tools (`stepToken` lines), shown in its answer as the apps show it. */
export type Piece = { readonly kind: 'user' | 'agent' | 'notice' | 'step'; readonly text: string; readonly id?: string; readonly at?: string } | undefined;

export type LiveEntry = SessionEntry & { readonly id: string };

/**
 * A message Arkestra itself sent into the session (a room turn): the room already has it and
 * the answer to it. The preambles, the shared rules block, or a transcript's author labels.
 */
export const ARKESTRA_PROMPT = /^(You are (Claude|Codex) in an Arkestra room|Közös szabályok és memória \(Arkestra|\[(You|you, earlier|[^\]\n]{1,80} \(agent\))\]\n|\[room\] )/;

/** Splits bytes into whole lines, keeping a partial last line for the next chunk; offsets in bytes. */
export class LineSplitter {
	private rest: Buffer = Buffer.alloc(0);

	constructor(private offset = 0) { }

	/** Where the next whole line starts: everything before it was handed out. */
	get position(): number { return this.offset; }

	/** Bytes read so far, the partial line included. */
	get read(): number { return this.offset + this.rest.length; }

	push(chunk: Buffer): { text: string; start: number }[] {
		const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
		const lines: { text: string; start: number }[] = [];
		let from = 0;
		let nl: number;
		while ((nl = buf.indexOf(10, from)) >= 0) {
			lines.push({ text: buf.toString('utf8', from, nl), start: this.offset + from });
			from = nl + 1;
		}
		this.offset += from;
		this.rest = Buffer.from(buf.subarray(from));
		return lines;
	}
}

/**
 * Lines into thread entries, as the history shows them: one user entry per message, one agent
 * entry per answer (its texts together, under the id of its first). With `mute`, a message
 * Arkestra sent and the answer to it are left out.
 */
export class EntryAssembler {
	private open: { entry: { id?: string; role: 'agent'; text: string; at?: string }; start: number } | undefined;
	/** Steps before the answer's first text: they go in front of it (the answer keeps the text's id). */
	private pending: { text: string; start: number } | undefined;

	constructor(private readonly options: { readonly mute?: boolean; readonly positional?: boolean } = {}, public muted = false) { }

	/** The entry this line made or changed, if any. */
	feed(piece: Piece, start: number): SessionEntry | undefined {
		if (!piece) {
			return undefined;
		}
		const id = piece.id ?? (this.options.positional ? `@${start}` : undefined);
		const base = { ...(id ? { id } : {}), ...(piece.at ? { at: piece.at } : {}) };
		if (piece.kind === 'step') {
			if (this.muted) {
				return undefined;
			}
			if (!this.open) {
				this.pending = { text: this.pending ? `${this.pending.text}\n\n${piece.text}` : piece.text, start: this.pending?.start ?? start };
				return undefined;
			}
			this.open.entry.text += `\n\n${piece.text}`;
			return { ...this.open.entry };
		}
		if (piece.kind !== 'agent') {
			this.open = undefined;
			this.pending = undefined;
			if (piece.kind === 'user' && this.options.mute) {
				this.muted = ARKESTRA_PROMPT.test(piece.text);
			}
			return this.muted ? undefined : { role: piece.kind === 'user' ? 'user' : 'system', text: piece.text, ...base };
		}
		if (this.muted) {
			return undefined;
		}
		if (this.open) {
			this.open.entry.text += `\n\n${piece.text}`;
		} else {
			this.open = { entry: { role: 'agent', text: this.pending ? `${this.pending.text}\n\n${piece.text}` : piece.text, ...base }, start: this.pending?.start ?? start };
			this.pending = undefined;
		}
		return { ...this.open.entry };
	}

	/** Where to read again from so that an answer still being written comes whole. */
	cursor(position: number): string {
		return `${this.open ? this.open.start : this.pending ? this.pending.start : position}${this.muted ? 'm' : ''}`;
	}
}

/** A cursor as offset and mute state; undefined: none or not one. */
export function parseCursor(cursor: string | undefined): { offset: number; muted: boolean } | undefined {
	const m = cursor ? /^(\d+)(m?)$/.exec(cursor) : null;
	return m ? { offset: Number(m[1]), muted: !!m[2] } : undefined;
}

/** A whole session text as entries (the history import), each entry once and in order. */
export function assemble(text: string, classify: (line: string) => Piece, limit: number): SessionEntry[] {
	const assembler = new EntryAssembler();
	const entries: SessionEntry[] = [];
	const lines = text.split('\n');
	let offset = 0;
	for (const line of lines) {
		const entry = line.trim() ? assembler.feed(classify(line), offset) : undefined;
		offset += Buffer.byteLength(line) + 1;
		if (!entry) {
			continue;
		}
		const last = entries.at(-1);
		if (entry.role === 'agent' && last?.role === 'agent') {
			entries[entries.length - 1] = entry; // the same answer, grown
		} else {
			entries.push(entry);
		}
	}
	return entries.slice(-limit);
}

export interface Disposable {
	dispose(): void;
}

export interface FollowOptions {
	/** Reads one line of the session file. */
	readonly classify: (line: string) => Piece;
	/** Where to go on from (a cursor this follower gave earlier); none: the end of the file now. */
	readonly cursor?: string;
	/**
	 * Entries made or changed since the last call, and the cursor to go on from later. The
	 * first call comes once what was there is read, even with nothing new.
	 */
	readonly onEntries: (entries: LiveEntry[], cursor: string, meta?: SessionMeta, lines?: readonly string[]) => void;
	/** Reads what a line says about the session itself (its model, its context fill); the latest goes with `onEntries` when it changed. */
	readonly meta?: (line: string) => SessionMeta | undefined;
	/**
	 * The raw lines to hand over with the entries (what the agent produced with its tools, AR26):
	 * a batch of such lines alone is handed over too. Kept only until that call.
	 */
	readonly keep?: (line: string) => boolean;
	/** How often the file is checked besides the change events, and how long a cursor-only change waits. */
	readonly pollMs?: number;
	readonly cursorDelayMs?: number;
	/** How long a file that is not there is left before it is looked for again. */
	readonly locateMs?: number;
}

/** Lines into entries and calls: what both followers share. */
class Feed {
	private splitter = new LineSplitter();
	private assembler: EntryAssembler;
	private changed = new Map<string, LiveEntry>();
	private sent: string | undefined;
	private first = true;
	private meta: SessionMeta | undefined;
	private metaChanged = false;
	private lines: string[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: FollowOptions, offset: number, muted: boolean) {
		this.splitter = new LineSplitter(offset);
		this.assembler = new EntryAssembler({ mute: true, positional: true }, muted);
	}

	get read(): number { return this.splitter.read; }

	/** The cursor now: the open answer's start, or the end of the last whole line. */
	get cursor(): string { return this.assembler.cursor(this.splitter.position); }

	/** Starts again at `offset` (a file read anew, a connection restarted at a cursor). */
	restart(offset: number, muted: boolean): void {
		this.lines = [];
		this.splitter = new LineSplitter(offset);
		this.assembler = new EntryAssembler({ mute: true, positional: true }, muted);
	}

	push(chunk: Buffer): void {
		for (const line of this.splitter.push(chunk)) {
			const entry = line.text.trim() ? this.assembler.feed(this.options.classify(line.text), line.start) : undefined;
			if (entry?.id) {
				this.changed.delete(entry.id); // its latest state, in the order last changed
				this.changed.set(entry.id, entry as LiveEntry);
			}
			const meta = this.options.meta && line.text.trim() ? this.options.meta(line.text) : undefined;
			if (meta && ((meta.model !== undefined && meta.model !== this.meta?.model) || (meta.context !== undefined && meta.context !== this.meta?.context))) {
				this.meta = { ...this.meta, ...meta };
				this.metaChanged = true;
			}
			if (this.options.keep && line.text.trim() && this.options.keep(line.text)) {
				this.lines.push(line.text);
			}
		}
	}

	/** Hands over what changed; a cursor-only change waits a little and goes with the next one. */
	flush(force = false): void {
		const cursor = this.cursor;
		if (this.changed.size || this.first || force || this.metaChanged || this.lines.length) {
			const entries = [...this.changed.values()];
			this.changed.clear();
			this.first = false;
			this.send(entries, cursor);
		} else if (cursor !== this.sent && !this.timer) {
			this.timer = setTimeout(() => { this.timer = undefined; if (this.cursor !== this.sent) { this.send([], this.cursor); } }, this.options.cursorDelayMs ?? 5000);
		}
	}

	private send(entries: LiveEntry[], cursor: string): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.sent = cursor;
		const lines = this.lines;
		this.lines = [];
		const meta = this.metaChanged ? this.meta : undefined;
		this.metaChanged = false;
		if (lines.length) {
			this.options.onEntries(entries, cursor, meta, lines);
		} else if (meta) {
			this.options.onEntries(entries, cursor, meta);
		} else {
			this.options.onEntries(entries, cursor);
		}
	}

	dispose(): void {
		clearTimeout(this.timer);
	}
}

const READ_CHUNK = 1 << 20;

/**
 * Follows a session file on this machine: change events, and a slow poll for when they do not
 * come (network folders, editors that replace the file). A file replaced or cut short is read
 * again from its start (the room drops what it already has, by id).
 */
export function followLocal(locate: () => Promise<string | undefined>, options: FollowOptions): Disposable {
	let disposed = false;
	let file: string | undefined;
	let ino: number | undefined;
	let feed: Feed | undefined;
	let watcher: FSWatcher | undefined;
	let busy = false;
	let again = false;
	let nextLocate = 0;
	const start = parseCursor(options.cursor);

	const check = async (): Promise<void> => {
		if (busy) {
			again = true;
			return;
		}
		busy = true;
		try {
			do {
				again = false;
				await step();
			} while (again && !disposed);
		} catch {
			/* the next poll tries again */
		} finally {
			busy = false;
		}
	};

	const step = async (): Promise<void> => {
		if (disposed) {
			return;
		}
		if (!file) {
			// A search can walk many folders: not on every poll while the file is not there.
			if (Date.now() < nextLocate) {
				return;
			}
			file = await locate().catch(() => undefined);
			if (!file || disposed) {
				nextLocate = Date.now() + (options.locateMs ?? 10_000);
				return;
			}
			try {
				watcher = watch(file, () => void check());
				watcher.on('error', () => { watcher?.close(); watcher = undefined; });
			} catch { /* polling only */ }
		}
		const stat = await fs.stat(file).catch(() => undefined);
		if (!stat) {
			// Gone (moved, replaced): found again on the next check.
			watcher?.close();
			watcher = undefined;
			file = undefined;
			return;
		}
		if (!feed) {
			// A cursor past the end: the file was replaced, so all of it is new.
			const from = !start ? { offset: stat.size, muted: false } : start.offset <= stat.size ? start : { offset: 0, muted: false };
			feed = new Feed(options, from.offset, from.muted);
			ino = stat.ino;
		} else if (stat.ino !== ino || stat.size < feed.read) {
			feed.restart(0, false);
			ino = stat.ino;
		}
		if (stat.size > feed.read) {
			const handle = await fs.open(file, 'r');
			try {
				for (let pos = feed.read; pos < stat.size && !disposed;) {
					const buf = Buffer.alloc(Math.min(READ_CHUNK, stat.size - pos));
					const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
					if (!bytesRead) {
						break;
					}
					feed.push(buf.subarray(0, bytesRead));
					pos += bytesRead;
				}
			} finally {
				await handle.close();
			}
		}
		if (!disposed) {
			feed.flush();
		}
	};

	const poll = setInterval(() => void check(), options.pollMs ?? 2000);
	void check();
	return {
		dispose: () => {
			disposed = true;
			clearInterval(poll);
			watcher?.close();
			feed?.dispose();
		},
	};
}

/**
 * The script that follows a session file on a POSIX machine. `locate` sets `f` to the file (or
 * leaves it empty); the first line says where reading starts and how long the file is, then
 * `tail -F` sends every byte from there on. `offset` < 0: the end of the file now.
 */
export function tailScript(locate: string, offset: number): string {
	return [
		locate,
		'[ -n "$f" ] && [ -f "$f" ] || exit 3',
		`s=$(wc -c < "$f" | tr -d ' ')`,
		`n=${Math.floor(offset)}`,
		'[ "$n" -lt 0 ] && n=$s',
		'[ "$n" -gt "$s" ] && n=0',
		`printf '\\036AT %s %s\\n' "$n" "$s"`,
		'exec tail -c +$((n + 1)) -F "$f"',
	].join('\n');
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Follows a session file on an SSH machine: one long-running `tail -F` over the machine's
 * spawn, started again with a growing pause when the connection drops, closed on dispose.
 */
export function followRemote(spawn: SpawnFn, locate: string, options: FollowOptions & { readonly backoffMs?: readonly number[] }): Disposable {
	const backoff = options.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000];
	let disposed = false;
	let child: ChildProcess | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	let feed: Feed | undefined;
	const initial = parseCursor(options.cursor);

	const run = () => {
		if (disposed) {
			return;
		}
		const at = feed ? parseCursor(feed.cursor)! : initial ?? { offset: -1, muted: false };
		const proc = spawn('sh', ['-c', tailScript(locate, at.offset)], { stdio: ['ignore', 'pipe', 'pipe'] });
		child = proc;
		let head: Buffer | undefined = Buffer.alloc(0);
		let size = 0;
		let caughtUp = false;
		let restartFromZero = false;
		proc.stdout?.on('data', (chunk: Buffer) => {
			if (disposed || child !== proc) {
				return;
			}
			if (head) {
				head = Buffer.concat([head, chunk]);
				const nl = head.indexOf(10);
				if (nl < 0) {
					return;
				}
				const m = /^\u001eAT (\d+) (\d+)$/.exec(head.toString('utf8', 0, nl));
				chunk = head.subarray(nl + 1);
				head = undefined;
				if (!m) {
					proc.kill();
					return;
				}
				const n = Number(m[1]);
				size = Number(m[2]);
				failures = 0;
				// The machine moved the start (the file got shorter): the old place means nothing there.
				const muted = n === at.offset ? at.muted : false;
				if (!feed) {
					feed = new Feed(options, n, muted);
				} else {
					feed.restart(n, muted);
				}
			}
			feed!.push(chunk);
			if (caughtUp || feed!.read >= size) {
				caughtUp = true;
				feed!.flush();
			}
		});
		proc.stderr?.setEncoding('utf8');
		proc.stderr?.on('data', (text: string) => {
			// tail -F on a file cut short or replaced goes on from its start: so do we.
			if (/truncated|replaced|has appeared/.test(text)) {
				restartFromZero = true;
				proc.kill();
			}
		});
		proc.on('error', () => { /* 'close' follows */ });
		proc.on('close', () => {
			if (child !== proc) {
				return;
			}
			child = undefined;
			if (disposed) {
				return;
			}
			if (restartFromZero && feed) {
				feed.restart(0, false);
			}
			const wait = restartFromZero ? 0 : backoff[Math.min(failures++, backoff.length - 1)];
			timer = setTimeout(run, wait);
		});
	};

	run();
	return {
		dispose: () => {
			disposed = true;
			clearTimeout(timer);
			child?.kill();
			child = undefined;
			feed?.dispose();
		},
	};
}

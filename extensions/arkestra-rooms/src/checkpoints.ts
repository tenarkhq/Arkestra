/*---------------------------------------------------------------------------------------------
 *  Arkestra. Checkpoints and change acceptance for what agents change in the workspace.
 *  A shadow git repository beside the workspace (never the project's own .git) keeps, per
 *  room, a checkpoint before and after agent turns and the accepted state: what changed
 *  since the accepted state can be kept or discarded file by file, and the workspace can be
 *  restored to any checkpoint (a checkpoint is taken first, so a restore can be undone).
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface Checkpoint {
	/** The ref, `refs/arkestra/<room>/cp/<n>`. */
	readonly ref: string;
	readonly n: number;
	readonly label: string;
	/** ISO time. */
	readonly at: string;
	readonly commit: string;
}

export interface Change {
	readonly path: string;
	/** A added, M modified, D deleted (relative to the accepted state). */
	readonly status: 'A' | 'M' | 'D';
}

const IDENTITY = { GIT_AUTHOR_NAME: 'Arkestra', GIT_AUTHOR_EMAIL: 'arkestra@localhost', GIT_COMMITTER_NAME: 'Arkestra', GIT_COMMITTER_EMAIL: 'arkestra@localhost' };

export class Checkpoints {
	/**
	 * @param gitDir the shadow repository (created on first use)
	 * @param workTree the workspace folder
	 */
	constructor(private readonly gitDir: string, private readonly workTree: string, private readonly now: () => Date = () => new Date()) { }

	private run(args: string[], options: { index?: string; input?: string } = {}): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', `--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`, ...args], {
				cwd: this.workTree,
				maxBuffer: 64 * 1024 * 1024,
				env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: '0', ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) },
			}, (error, out, err) => error ? reject(new Error(String(err).trim().split('\n').at(-1) || error.message)) : resolve(String(out)));
			if (options.input !== undefined) {
				child.stdin?.end(options.input);
			}
		});
	}

	private async ensure(): Promise<void> {
		if (this.ready) {
			return;
		}
		await mkdir(this.gitDir, { recursive: true });
		await new Promise<void>((resolve, reject) => execFile('git', ['init', '-q', '--bare', this.gitDir], error => error ? reject(error) : resolve()));
		await this.run(['config', 'core.bare', 'false']);
		// What the project ignores, and Arkestra's own work trees, stay out of checkpoints.
		await mkdir(path.join(this.gitDir, 'info'), { recursive: true });
		await writeFile(path.join(this.gitDir, 'info', 'exclude'), '/.arkestra/\n/.git/\n');
		this.ready = true;
	}
	private ready = false;

	private index(room: string): string {
		return path.join(this.gitDir, `index-${room.replace(/[^A-Za-z0-9-]/g, '')}`);
	}

	private refs(room: string) {
		const base = `refs/arkestra/${room.replace(/[^A-Za-z0-9-]/g, '')}`;
		return { cp: `${base}/cp`, accepted: `${base}/accepted` };
	}

	/** The workspace as a tree, right now. */
	private async currentTree(room: string): Promise<string> {
		const index = this.index(room);
		await this.run(['add', '-A', '--', '.'], { index });
		return (await this.run(['write-tree'], { index })).trim();
	}

	private async resolve(ref: string): Promise<string | undefined> {
		return this.run(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).then(s => s.trim(), () => undefined);
	}

	async list(room: string): Promise<Checkpoint[]> {
		await this.ensure();
		const out = await this.run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(contents:subject)%00%(contents:body)', `${this.refs(room).cp}/`]);
		return out.split('\n').filter(Boolean).map(line => {
			const [ref, commit, label, body] = line.split('\0');
			return { ref, commit, label, at: /^at: (.+)$/m.exec(body ?? '')?.[1]?.trim() ?? '', n: Number(ref.split('/').at(-1)) };
		}).sort((a, b) => b.n - a.n);
	}

	/**
	 * Takes a checkpoint when the workspace differs from the last one (or `force`). The first
	 * checkpoint of a room is also its accepted state.
	 */
	async take(room: string, label: string, force = false): Promise<Checkpoint | undefined> {
		await this.ensure();
		const refs = this.refs(room);
		const tree = await this.currentTree(room);
		const last = (await this.list(room))[0];
		if (last && !force && (await this.run(['rev-parse', `${last.commit}^{tree}`])).trim() === tree) {
			return undefined;
		}
		const at = this.now().toISOString();
		const commit = (await this.run(['commit-tree', tree, ...(last ? ['-p', last.commit] : []), '-m', label, '-m', `at: ${at}`])).trim();
		const n = (last?.n ?? 0) + 1;
		const ref = `${refs.cp}/${n}`;
		await this.run(['update-ref', ref, commit]);
		if (!(await this.resolve(refs.accepted))) {
			await this.run(['update-ref', refs.accepted, commit]);
		}
		return { ref, n, label, at, commit };
	}

	/** What changed in the workspace since the accepted state. */
	async changes(room: string): Promise<Change[]> {
		await this.ensure();
		const accepted = await this.resolve(this.refs(room).accepted);
		if (!accepted) {
			return [];
		}
		const tree = await this.currentTree(room);
		const out = await this.run(['diff-tree', '-r', '--no-renames', '--name-status', '-z', `${accepted}^{tree}`, tree]);
		const parts = out.split('\0').filter(Boolean);
		const changes: Change[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			changes.push({ status: parts[i][0] as Change['status'], path: parts[i + 1] });
		}
		return changes.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** The files that differ between two commits. */
	async changedBetween(from: string, to: string): Promise<Change[]> {
		await this.ensure();
		const parts = (await this.run(['diff-tree', '-r', '--no-renames', '--name-status', '-z', from, to])).split('\0').filter(Boolean);
		const changes: Change[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			changes.push({ status: parts[i][0] as Change['status'], path: parts[i + 1] });
		}
		return changes;
	}

	/** The accepted content of a file, or undefined when it did not exist then. */
	async acceptedContent(room: string, file: string): Promise<string | undefined> {
		const accepted = await this.resolve(this.refs(room).accepted);
		return accepted ? this.run(['show', `${accepted}:${file}`]).catch(() => undefined) : undefined;
	}

	/** A file's content at a commit or ref, or undefined. */
	async contentAt(ref: string, file: string): Promise<string | undefined> {
		await this.ensure();
		return this.run(['show', `${ref}:${file}`]).catch(() => undefined);
	}

	/** Keeps these files as they are now: the accepted state takes them over. */
	async keep(room: string, files: readonly string[]): Promise<void> {
		await this.ensure();
		const refs = this.refs(room);
		const accepted = await this.resolve(refs.accepted);
		if (!accepted) {
			return;
		}
		const current = await this.currentTree(room);
		const temp = `${this.index(room)}-keep`;
		try {
			await this.run(['read-tree', `${accepted}^{tree}`], { index: temp });
			for (const file of files) {
				const entry = (await this.run(['ls-tree', current, '--', file])).trim();
				if (entry) {
					const [meta] = entry.split('\t');
					const [mode, , sha] = meta.split(' ');
					await this.run(['update-index', '--add', '--cacheinfo', `${mode},${sha},${file}`], { index: temp });
				} else {
					await this.run(['update-index', '--force-remove', '--', file], { index: temp });
				}
			}
			const tree = (await this.run(['write-tree'], { index: temp })).trim();
			const commit = (await this.run(['commit-tree', tree, '-p', accepted, '-m', `kept: ${files.join(', ')}`])).trim();
			await this.run(['update-ref', refs.accepted, commit]);
		} finally {
			await rm(temp, { force: true });
		}
	}

	/** Puts these files back as they were in the accepted state (removes the ones that were added). */
	async discard(room: string, files: readonly string[]): Promise<void> {
		await this.ensure();
		const accepted = await this.resolve(this.refs(room).accepted);
		if (!accepted) {
			return;
		}
		await this.put(room, accepted, files);
	}

	private async put(room: string, commit: string, files: readonly string[]): Promise<void> {
		const index = this.index(room);
		for (const file of files) {
			const exists = (await this.run(['ls-tree', commit, '--', file])).trim();
			if (exists) {
				await this.run(['checkout', commit, '--', file], { index });
			} else {
				await rm(path.join(this.workTree, file), { force: true });
			}
		}
	}

	/**
	 * Brings the workspace back to a checkpoint. A checkpoint of the state before is taken
	 * first, so the restore itself can be undone; the restored state becomes the accepted one.
	 */
	async restore(room: string, checkpoint: Checkpoint, beforeLabel: string): Promise<Checkpoint | undefined> {
		const before = await this.take(room, beforeLabel);
		const current = await this.currentTree(room);
		const diff = await this.run(['diff-tree', '-r', '--no-renames', '--name-only', '-z', `${checkpoint.commit}^{tree}`, current]);
		await this.put(room, checkpoint.commit, diff.split('\0').filter(Boolean));
		await this.run(['update-ref', this.refs(room).accepted, checkpoint.commit]);
		return before;
	}
}

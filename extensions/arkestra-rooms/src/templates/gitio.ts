/*---------------------------------------------------------------------------------------------
 *  Arkestra. Git for template rooms: one work tree and branch per agent inside the project
 *  (.arkestra/rooms/<room>/<agent>), commits on [SZELET KÉSZ], the merge on [ÁTEMELÉS] and
 *  the test command on [KÉSZ], and the landing of the finished work in the base branch.
 *  Commits run without the repository's hooks and signing.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { LandResult, TemplateIO, WorkTreeState } from './engine';
import type { Role } from './signals';

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false'];

export function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; out: string; err: string }> {
	return new Promise(resolve => {
		execFile('git', [...NO_HOOKS, ...args], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, out, err) => {
			resolve({ ok: !error, out: String(out), err: String(err) });
		});
	});
}

async function must(cwd: string, args: string[]): Promise<string> {
	const r = await git(cwd, args);
	if (!r.ok) {
		throw new Error(r.err.trim().split('\n').at(-1) || `git ${args[0]} failed`);
	}
	return r.out.trim();
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

/** The repository root of a folder, or undefined when it is not in one. */
export async function repoRoot(folder: string): Promise<string | undefined> {
	const r = await git(folder, ['rev-parse', '--show-toplevel']);
	return r.ok ? r.out.trim() : undefined;
}

/** Creates the two work trees on their own branches from `base`; reuses them when they exist. */
export async function createWorkTrees(repo: string, base: string, roomId: string, names: Record<Role, string>): Promise<{ dirs: Record<Role, string>; branches: Record<Role, string> }> {
	await must(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
	const exclude = path.join(await must(repo, ['rev-parse', '--git-common-dir']).then(d => path.resolve(repo, d)), 'info', 'exclude');
	const current = await readFile(exclude, 'utf8').catch(() => '');
	if (!current.split('\n').includes('/.arkestra/')) {
		await mkdir(path.dirname(exclude), { recursive: true });
		await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/.arkestra/\n`);
	}
	const short = roomId.replace(/[^A-Za-z0-9]/g, '').slice(-8);
	const dirs = {} as Record<Role, string>;
	const branches = {} as Record<Role, string>;
	for (const role of ['A', 'B'] as Role[]) {
		const name = slug(names[role]) + (names.A === names.B ? `-${role.toLowerCase()}` : '');
		dirs[role] = path.join(repo, '.arkestra', 'rooms', short, name);
		branches[role] = `arkestra/${short}-${name}`;
		if (!(await stat(dirs[role]).then(s => s.isDirectory(), () => false))) {
			const exists = (await git(repo, ['rev-parse', '--verify', `refs/heads/${branches[role]}`])).ok;
			await must(repo, exists ? ['worktree', 'add', dirs[role], branches[role]] : ['worktree', 'add', '-b', branches[role], dirs[role], base]);
		}
	}
	return { dirs, branches };
}

export class GitTemplateIO implements TemplateIO {
	constructor(private readonly code: () => { repo: string; base: string; dirs: Record<Role, string>; branches: Record<Role, string>; coordinator: Role } | undefined) { }

	async fileExists(file: string): Promise<boolean> {
		return stat(file).then(s => s.isFile(), () => false);
	}

	async readFile(file: string): Promise<string | undefined> {
		return readFile(file, 'utf8').catch(() => undefined);
	}

	private dir(role: Role): string {
		const c = this.code();
		if (!c) {
			throw new Error('this room has no work trees');
		}
		return c.dirs[role];
	}

	async commitAll(role: Role, title: string): Promise<{ sha: string; files: number } | null> {
		const dir = this.dir(role);
		await must(dir, ['add', '-A']);
		if ((await git(dir, ['diff', '--cached', '--quiet'])).ok) {
			return null;
		}
		await must(dir, ['commit', '-q', '--no-verify', '-m', title]);
		const files = (await must(dir, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').filter(Boolean).length;
		return { sha: await must(dir, ['rev-parse', '--short', 'HEAD']), files };
	}

	async workTree(role: Role): Promise<WorkTreeState> {
		const dir = this.dir(role);
		return { head: await must(dir, ['rev-parse', '--short', 'HEAD']), dirty: (await must(dir, ['status', '--porcelain'])).length > 0 };
	}

	async integrate(): Promise<{ merged: string; conflicts?: string[]; synced?: boolean; syncReason?: 'dirty' | 'diverged' | 'error' }> {
		const c = this.code()!;
		const lead = c.coordinator;
		const peer: Role = lead === 'A' ? 'B' : 'A';
		const dir = c.dirs[lead];
		const merge = await git(dir, ['merge', '--no-edit', '--no-verify', c.branches[peer]]);
		if (!merge.ok) {
			const conflicts = (await must(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
			if (conflicts.length) {
				return { merged: await must(dir, ['rev-parse', '--short', 'HEAD']), conflicts };
			}
			throw new Error(merge.err.trim().split('\n').at(-1) || 'git merge failed');
		}
		const merged = await must(dir, ['rev-parse', '--short', 'HEAD']);
		// The peer continues from the merged state when its tree is clean and its branch is behind.
		const peerDir = c.dirs[peer];
		if ((await must(peerDir, ['status', '--porcelain'])).length) {
			return { merged, synced: false, syncReason: 'dirty' };
		}
		if (!(await git(peerDir, ['merge-base', '--is-ancestor', 'HEAD', c.branches[lead]])).ok) {
			return { merged, synced: false, syncReason: 'diverged' };
		}
		const ff = await git(peerDir, ['merge', '--ff-only', '-q', c.branches[lead]]);
		return ff.ok ? { merged, synced: true } : { merged, synced: false, syncReason: 'error' };
	}

	async unmerged(role: Role): Promise<number> {
		const c = this.code()!;
		const r = await git(c.dirs[c.coordinator], ['rev-list', '--count', `${c.branches[c.coordinator]}..${c.branches[role]}`]);
		return r.ok ? Number(r.out.trim()) || 0 : 0;
	}

	async land(title: string): Promise<LandResult> {
		const c = this.code()!;
		const branch = c.branches[c.coordinator];
		const baseRef = `refs/heads/${c.base}`;
		if (!(await git(c.repo, ['rev-parse', '--verify', '-q', baseRef])).ok) {
			return { ok: false, reason: 'error', detail: `nincs ${c.base} ág` };
		}
		const short = (dir: string, ref: string) => must(dir, ['rev-parse', '--short', ref]);
		if ((await git(c.repo, ['merge-base', '--is-ancestor', branch, baseRef])).ok) {
			return { ok: true, how: 'already', head: await short(c.repo, baseRef), where: c.repo };
		}
		// Where the base branch is checked out (the project itself or another work tree).
		const list = (await must(c.repo, ['worktree', 'list', '--porcelain'])).split('\n\n');
		const where = list.map(block => ({ dir: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch (.+)$/m.exec(block)?.[1] })).find(w => w.branch === baseRef)?.dir;
		if (!where) {
			// Not checked out anywhere: only a fast-forward of the branch itself is safe.
			if (!(await git(c.repo, ['merge-base', '--is-ancestor', baseRef, branch])).ok) {
				return { ok: false, reason: 'diverged' };
			}
			const old = await must(c.repo, ['rev-parse', baseRef]);
			const sha = await must(c.repo, ['rev-parse', branch]);
			const r = await git(c.repo, ['update-ref', '-m', `arkestra: ${title}`, baseRef, sha, old]);
			return r.ok ? { ok: true, how: 'fast-forward', head: await short(c.repo, baseRef), where: c.repo } : { ok: false, reason: 'error', detail: r.err.trim().split('\n').at(-1) };
		}
		const ff = (await git(where, ['merge-base', '--is-ancestor', 'HEAD', branch])).ok;
		const merge = await git(where, ['merge', '--no-edit', '--no-verify', '-m', `Arkestra: ${title}`, branch]);
		if (merge.ok) {
			// The coordinator goes on from the base it landed in (a merge commit is new to it).
			await git(c.dirs[c.coordinator], ['merge', '--ff-only', '-q', baseRef]);
			return { ok: true, how: ff ? 'fast-forward' : 'merge', head: await short(where, 'HEAD'), where };
		}
		const conflicts = (await git(where, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
		if (conflicts.length) {
			await git(where, ['merge', '--abort']);
			return { ok: false, reason: 'conflict', files: conflicts, where };
		}
		const text = `${merge.out}\n${merge.err}`;
		if (/local changes|untracked working tree files|would be overwritten/i.test(text)) {
			const files = text.split('\n').filter(l => /^\s+\S/.test(l)).map(l => l.trim());
			return { ok: false, reason: 'dirty', files, detail: files.slice(0, 5).join(', '), where };
		}
		return { ok: false, reason: 'error', detail: merge.err.trim().split('\n').at(-1), where };
	}

	runTests(command: string, timeoutMs = 20 * 60_000): Promise<{ ok: boolean; why?: string; tail?: string }> {
		const c = this.code()!;
		return new Promise(resolve => {
			const child = spawn('bash', ['-lc', command], { cwd: c.dirs[c.coordinator], env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' }, detached: process.platform !== 'win32' });
			let output = '';
			const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
			child.stdout.on('data', keep);
			child.stderr.on('data', keep);
			const timer = setTimeout(() => {
				try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
			}, timeoutMs);
			child.on('error', e => { clearTimeout(timer); resolve({ ok: false, why: e.message, tail: output }); });
			child.on('close', (code, signal) => {
				clearTimeout(timer);
				resolve(code === 0 ? { ok: true } : { ok: false, why: signal ? `leállítva (${signal})` : `kilépési kód ${code}`, tail: output.slice(-4000) });
			});
		});
	}
}

/*---------------------------------------------------------------------------------------------
 *  Arkestra. Best-of-N (AR24): the same task for several agents (or several tries of one),
 *  each in its own git work tree and branch from the same base; afterwards the attempts are
 *  committed, measured and compared, and the chosen one is brought into the base branch.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { excludeArkestraFolder, git } from './templates/gitio';

export interface BestAttempt {
	readonly n: number;
	readonly agentId: string;
	readonly agentName: string;
	readonly dir: string;
	readonly branch: string;
	state: 'waiting' | 'running' | 'done' | 'failed';
	head?: string;
	files?: number;
	added?: number;
	removed?: number;
	/** The first lines of the agent's last answer. */
	summary?: string;
	error?: string;
	tests?: { ok: boolean; why?: string };
}

export interface BestRun {
	readonly id: string;
	readonly task: string;
	readonly repo: string;
	readonly base: string;
	readonly baseHead: string;
	readonly test?: string;
	attempts: BestAttempt[];
	state: 'running' | 'done' | 'chosen' | 'discarded';
	chosen?: number;
}

/** Attempts at most in one run. */
export const MAX_ATTEMPTS = 6;

/**
 * `/best [N] task`: N tries per agent (the leading number, or `x3` / `3x`); without it one try
 * per agent, two when only one agent is in the room.
 */
export function parseBest(prompt: string, agents: number): { perAgent: number; task: string } {
	const m = /^\s*(?:x(\d)|(\d)x?)\s+([\s\S]+)$/i.exec(prompt);
	const asked = m ? Number(m[1] ?? m[2]) : undefined;
	const task = (m ? m[3] : prompt).trim();
	const perAgent = Math.max(1, asked ?? (agents === 1 ? 2 : 1));
	return { perAgent, task };
}

/** Which agent does which attempt: round by round, so a cut keeps every agent in. */
export function planAttempts(agents: readonly { id: string; name: string }[], perAgent: number, max = MAX_ATTEMPTS): { n: number; agentId: string; agentName: string }[] {
	const out: { n: number; agentId: string; agentName: string }[] = [];
	for (let round = 0; round < perAgent; round++) {
		for (const a of agents) {
			if (out.length < max) {
				out.push({ n: out.length + 1, agentId: a.id, agentName: perAgent > 1 ? `${a.name} #${round + 1}` : a.name });
			}
		}
	}
	return out;
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

/** The work trees and branches of a run, from the base's current commit. */
export async function createAttempts(repo: string, base: string, runId: string, plan: readonly { n: number; agentId: string; agentName: string }[]): Promise<{ baseHead: string; attempts: BestAttempt[] }> {
	const head = await git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
	if (!head.ok) {
		throw new Error(`no such branch: ${base}`);
	}
	const baseHead = head.out.trim();
	await excludeArkestraFolder(repo);
	const attempts: BestAttempt[] = [];
	for (const p of plan) {
		const name = `${p.n}-${slug(p.agentName)}`;
		const dir = path.join(repo, '.arkestra', 'best', runId, name);
		const branch = `arkestra/best-${runId}-${name}`;
		await mkdir(path.dirname(dir), { recursive: true });
		const r = await git(repo, ['worktree', 'add', '-q', '-b', branch, dir, baseHead]);
		if (!r.ok) {
			throw new Error(r.err.trim().split('\n').at(-1) || 'git worktree add failed');
		}
		attempts.push({ ...p, dir, branch, state: 'waiting' });
	}
	return { baseHead, attempts };
}

/** What the attempt's agent gets: the task, its own folder, and that it works alone. */
export function attemptPrompt(task: string, attempt: BestAttempt, total: number): string {
	return [
		`Best-of-N: ugyanezt a feladatot ${total} próba oldja meg egymástól függetlenül, mindegyik a saját munkafájában. Ez a(z) ${attempt.n}. próba.`,
		`A munkafád: ${attempt.dir} (git ág: ${attempt.branch}). Csak itt dolgozz; más mappához ne nyúlj.`,
		'Egyedül dolgozol, nem kell egyeztetned senkivel. A végén az Arkestra commitol helyetted; a válaszod végén röviden írd le, mit csináltál és hogyan ellenőrizted.',
		`A feladat:\n\n${task}`,
	].join('\n\n');
}

/** Commits what the attempt left and measures it against the base. */
export async function collectAttempt(attempt: BestAttempt, baseHead: string, title: string): Promise<void> {
	await git(attempt.dir, ['add', '-A']);
	if (!(await git(attempt.dir, ['diff', '--cached', '--quiet'])).ok) {
		await git(attempt.dir, ['-c', 'user.name=Arkestra', '-c', 'user.email=arkestra@localhost', 'commit', '-q', '--no-verify', '-m', title]);
	}
	attempt.head = (await git(attempt.dir, ['rev-parse', '--short', 'HEAD'])).out.trim();
	const numstat = (await git(attempt.dir, ['diff', '--numstat', baseHead, 'HEAD'])).out.trim();
	const rows = numstat ? numstat.split('\n').map(l => l.split('\t')) : [];
	attempt.files = rows.length;
	attempt.added = rows.reduce((n, r) => n + (Number(r[0]) || 0), 0);
	attempt.removed = rows.reduce((n, r) => n + (Number(r[1]) || 0), 0);
}

/** The files an attempt changed: status letter and path (a rename shows its new path). */
export async function attemptFiles(attempt: BestAttempt, baseHead: string): Promise<{ status: string; path: string }[]> {
	const out = (await git(attempt.dir, ['diff', '--name-status', '-M', baseHead, 'HEAD'])).out.trim();
	return out ? out.split('\n').map(l => { const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] }; }) : [];
}

/** An attempt's whole diff, for the comparison round. */
export async function attemptDiff(attempt: BestAttempt, baseHead: string, limit = 30_000): Promise<string> {
	const d = (await git(attempt.dir, ['diff', '--no-color', baseHead, 'HEAD'])).out;
	return d.length > limit ? `${d.slice(0, d.lastIndexOf('\n', limit))}\n… (levágva)` : d;
}

/** Runs the test command in an attempt's work tree. */
export function runAttemptTests(dir: string, command: string, timeoutMs = 20 * 60_000): Promise<{ ok: boolean; why?: string }> {
	return new Promise(resolve => {
		const child = spawn('bash', ['-lc', command], { cwd: dir, env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' }, stdio: 'ignore', detached: process.platform !== 'win32' });
		const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }, timeoutMs);
		child.on('error', e => { clearTimeout(timer); resolve({ ok: false, why: e.message }); });
		child.on('close', (code, signal) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, why: signal ? `stopped (${signal})` : `exit ${code}` }); });
	});
}

/** The comparison table for the chat. */
export function comparisonTable(run: BestRun): string {
	const rows = run.attempts.map(a => {
		const change = a.state === 'failed' ? `hiba: ${a.error ?? '?'}` : a.files ? `${a.files} fájl · +${a.added} −${a.removed}` : 'nincs változás';
		const tests = run.test ? (a.tests ? (a.tests.ok ? '✓' : `✗ ${a.tests.why ?? ''}`) : '–') : '';
		const summary = (a.summary ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 140);
		return `| ${a.n} | ${a.agentName} | ${change} |${run.test ? ` ${tests} |` : ''} ${summary} |`;
	});
	const head = `| # | Agent | Változás |${run.test ? ' Teszt |' : ''} Összefoglaló |\n|---|---|---|${run.test ? '---|' : ''}---|`;
	return `${head}\n${rows.join('\n')}`;
}

/** The comparison round's request: every attempt's diff and summary, and what to judge. */
export function comparePrompt(run: BestRun, diffs: readonly string[]): string {
	const parts = run.attempts.map((a, i) => `### ${a.n}. próba · ${a.agentName}${a.tests ? ` · teszt: ${a.tests.ok ? 'zöld' : 'piros'}` : ''}\n\n${a.summary ? `Összefoglaló: ${a.summary}\n\n` : ''}\`\`\`diff\n${diffs[i] || '(nincs változás)'}\n\`\`\``);
	return [
		`Best-of-N összevetés. A feladat ugyanaz volt mind a ${run.attempts.length} próbánál:\n\n${run.task}`,
		...parts,
		'Vessétek össze a próbákat: melyik oldja meg legjobban a feladatot (helyesség, teljesség, egyszerűség, kockázat, tesztek)? Mondjátok meg, melyiket választanátok és miért, és mi hiányzik belőle. A választás a felhasználóé.',
	].join('\n\n');
}

/** Removes a run's work trees and branches (a landed branch is already in the base). */
export async function cleanupRun(run: BestRun): Promise<void> {
	for (const a of run.attempts) {
		await git(run.repo, ['worktree', 'remove', '--force', a.dir]);
		await git(run.repo, ['branch', '-D', a.branch]);
	}
	await git(run.repo, ['worktree', 'prune']);
}

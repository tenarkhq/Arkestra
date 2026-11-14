/*---------------------------------------------------------------------------------------------
 *  Arkestra. What the Plan view's branch rails need from the local repository (AR31): the
 *  base branch, its recent history and tags, and where each open branch stands.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { parseCounts, parseLog, parseRefs, type GitInfo } from './plan';

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise(resolve => execFile('git', args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout)));
}

/** The repository's state for the given branches; undefined when the folder is not a git repository. */
export async function readGitInfo(cwd: string, wanted: readonly string[]): Promise<GitInfo | undefined> {
	if ((await git(cwd, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') {
		return undefined;
	}
	const originHead = (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
	const refs = parseRefs(await git(cwd, ['for-each-ref', '--format=%(refname:short)%09%(objectname:short)', 'refs/heads', 'refs/remotes/origin']) ?? '');
	const base = originHead?.replace(/^origin\//, '') || (refs.has('main') ? 'main' : refs.has('master') ? 'master' : (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || 'main');
	const baseRef = (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])) ? base : `origin/${base}`;
	const [log, tags] = await Promise.all([
		git(cwd, ['log', '--first-parent', '-n', '8', '--format=%h%x09%s%x09%D', baseRef]),
		git(cwd, ['tag', '--sort=-v:refname']),
	]);
	const branches = new Map<string, { sha: string; ahead?: number; behind?: number }>();
	await Promise.all(wanted.filter(b => refs.has(b)).slice(0, 12).map(async b => {
		const local = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
		const counts = parseCounts(await git(cwd, ['rev-list', '--left-right', '--count', `${baseRef}...${local ? b : `origin/${b}`}`]) ?? '');
		branches.set(b, { sha: refs.get(b)!, ...(counts ? counts : {}) });
	}));
	return { base, ...(refs.get(base) ? { baseHead: refs.get(base)! } : {}), tags: (tags ?? '').split('\n').filter(Boolean).slice(0, 20), log: parseLog(log ?? ''), branches };
}

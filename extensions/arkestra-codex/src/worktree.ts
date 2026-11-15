/*---------------------------------------------------------------------------------------------
 *  Arkestra. What a session's folder has changed, as the Claude and Codex apps count it: the
 *  git working tree against its last commit, files added and removed lines, new files too.
 *--------------------------------------------------------------------------------------------*/

export interface WorktreeChange {
	readonly path: string;
	/** Lines added and removed; undefined for a binary or a new file. */
	readonly added?: number;
	readonly removed?: number;
	/** `M`: changed, `?`: new (not in git yet). */
	readonly status: 'M' | '?';
}

const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

/** The POSIX script that prints the folder's changes (nothing outside a git work tree, or without git). */
export function worktreeScript(cwd: string): string {
	return [
		`cd ${quote(cwd)} 2>/dev/null || exit 0`,
		// A Mac without the command line tools: its git is a stub that asks to install them.
		'if [ "$(uname)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then exit 0; fi',
		'command -v git >/dev/null 2>&1 || exit 0',
		'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0',
		'git diff --numstat HEAD -- 2>/dev/null | head -n 400',
		"git ls-files --others --exclude-standard 2>/dev/null | head -n 200 | sed 's/^/?\t?\t/'",
		'exit 0',
	].join('\n');
}

export function parseWorktree(out: string): WorktreeChange[] {
	const changes: WorktreeChange[] = [];
	for (const line of out.split('\n')) {
		const m = /^(\d+|-|\?)\t(\d+|-|\?)\t(.+)$/.exec(line);
		if (!m) {
			continue;
		}
		const fresh = m[1] === '?';
		changes.push({ path: m[3], status: fresh ? '?' : 'M', ...(/^\d+$/.test(m[1]) ? { added: Number(m[1]) } : {}), ...(/^\d+$/.test(m[2]) ? { removed: Number(m[2]) } : {}) });
	}
	return changes;
}

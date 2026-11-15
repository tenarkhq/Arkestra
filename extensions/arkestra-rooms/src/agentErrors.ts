/*---------------------------------------------------------------------------------------------
 *  Arkestra. An agent's failed turn in plain words: a CLI that is not installed or may not run
 *  (`spawn claude ENOENT`, a remote shell's "command not found") says so, the rest stays as the
 *  agent said it. Also read for threads that stored the raw text before. No VS Code.
 *--------------------------------------------------------------------------------------------*/

/** The CLI an agent runs, without its machine (as sessionHome's; kept here so room.ts imports no cycle). */
const agentKind = (agentId: string) => agentId.split('@')[0];
const isLocalAgent = (agentId: string) => !agentId.includes('@');

/** An error as the thread shows it. */
export interface ReadableError {
	readonly text: string;
	/** The agent's CLI is not on that computer (or may not run there): another machine can take over. */
	readonly missing?: boolean;
}

/** The product a CLI command or agent id stands for: `claude` → Claude Code. */
export function productOf(name: string): string | undefined {
	const base = name.split(/[\\/]/).pop()!.replace(/\.(exe|cmd)$/i, '').toLowerCase();
	return base.startsWith('claude') ? 'Claude Code' : base.startsWith('codex') ? 'Codex' : undefined;
}

const NOT_INSTALLED = / is not installed on (this computer|[^.\s]+)\./;
const NOT_ALLOWED = / could not be started on (this computer|[^:\s]+): it is not allowed to run\./;

/**
 * The plain text of an agent's error. `machine`: the SSH machine the agent runs on (none: this
 * computer). A text that is already plain (the agents say it so now) is kept as it is.
 */
export function readableAgentError(raw: string, agentId: string, machine?: string): ReadableError {
	const text = raw.trim();
	if (NOT_INSTALLED.test(text) || NOT_ALLOWED.test(text)) {
		return { text, missing: true };
	}
	const local = isLocalAgent(agentId);
	const spawned = /\bspawn (\S+) (ENOENT|EACCES)\b/.exec(text);
	if (spawned && local) {
		const product = productOf(spawned[1]) ?? productOf(agentKind(agentId)) ?? spawned[1];
		return {
			text: spawned[2] === 'ENOENT'
				? `${product} is not installed on this computer. Install it or connect a machine that has it.`
				: `${product} could not be started on this computer: it is not allowed to run. Reinstall it or connect a machine that has it.`,
			missing: true,
		};
	}
	// The SSH machine's shell: `sh: 1: claude: not found`, `bash: codex: command not found`.
	const notFound = /(?:^|\s)(?:[\w./-]+: )?(?:\d+: )?([\w./-]+): (?:command )?not found$/.exec(text);
	if (notFound && !local) {
		const product = productOf(notFound[1]) ?? productOf(agentKind(agentId));
		if (product) {
			const where = machine ?? agentId.slice(agentId.indexOf('@') + 1);
			return { text: `${product} is not installed on ${where}. Install it there or choose another machine.`, missing: true };
		}
	}
	// The session's folder is not on the machine (`sh: 1: cd: can't cd to /x`, `cd: /x: No such file or directory`).
	const folder = /\bcd: (?:can't cd to (\S.*?)|(\S.*?): No such file or directory)\s*$/.exec(text);
	if (folder) {
		const where = local ? 'this computer' : machine ?? agentId.slice(agentId.indexOf('@') + 1);
		return { text: `The session's folder ${folder[1] ?? folder[2]} does not exist on ${where}, so it cannot go on there. Open the session from the machine that has the folder.` };
	}
	return { text };
}

/** The agent's answer and the error it ended with (the room stores it as `[error] …` after what was written). */
export function splitError(text: string): { answer: string; error?: string } {
	const m = /(?:^|\n\n)\[error\] ([\s\S]*)$/.exec(text);
	if (!m) {
		return { answer: text };
	}
	return { answer: text.slice(0, m.index).trim(), error: m[1].trim() };
}

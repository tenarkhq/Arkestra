/*---------------------------------------------------------------------------------------------
 *  Arkestra. Step lines of adopted sessions (see below).
 *--------------------------------------------------------------------------------------------*/

/**
 * What an adopted session's agent did with its tools, kept in its answer as lines by the agent
 * extensions (`<arkestra-step kind="…">label</arkestra-step>`): shown folded between the texts,
 * as the Claude and Codex apps show them, and left out of what goes on (the agents, the clipboard).
 */
const STEP = /<arkestra-step kind="(\w+)">([\s\S]*?)<\/arkestra-step>/g;

export interface Step { readonly kind: string; readonly label: string }

/** The answer as texts and runs of steps between them, in order. */
export function stepParts(text: string): ({ readonly md: string } | { readonly steps: readonly Step[] })[] {
	const out: ({ md: string } | { steps: Step[] })[] = [];
	let at = 0;
	for (const m of text.matchAll(STEP)) {
		const before = text.slice(at, m.index);
		const last = out.at(-1);
		if (before.trim()) {
			out.push({ md: before.trim() });
			out.push({ steps: [{ kind: m[1], label: m[2] }] });
		} else if (last && 'steps' in last) {
			last.steps.push({ kind: m[1], label: m[2] });
		} else {
			out.push({ steps: [{ kind: m[1], label: m[2] }] });
		}
		at = m.index + m[0].length;
	}
	const rest = text.slice(at);
	if (rest.trim() || !out.length) {
		out.push({ md: rest.trim() });
	}
	return out;
}

/** The answer without its step lines: what an agent or the clipboard gets. */
export function withoutSteps(text: string): string {
	return text.includes('<arkestra-step') ? text.replace(STEP, '').replace(/\n{3,}/g, '\n\n').trim() : text;
}

const STEP_WORDS: Record<string, [string, string, string]> = {
	command: ['Ran', 'command', 'commands'], read: ['Read', 'file', 'files'], edit: ['Edited', 'file', 'files'],
	search: ['Ran', 'search', 'searches'], web: ['Looked up', 'page', 'pages'], agent: ['Ran', 'agent', 'agents'], other: ['Used', 'tool', 'tools'],
};

/** A run of steps as one line: a single step by its own name, more by what they were ("Ran 3 commands and edited 2 files"). */
export function stepsLabel(steps: readonly Step[]): string {
	if (steps.length === 1) {
		return steps[0].label;
	}
	const counts = new Map<string, number>();
	for (const s of steps) {
		const kind = STEP_WORDS[s.kind] ? s.kind : 'other';
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	const parts = [...counts].map(([kind, n], i) => {
		const [verb, one, many] = STEP_WORDS[kind];
		return `${i ? verb.toLowerCase() : verb} ${n} ${n === 1 ? one : many}`;
	});
	return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

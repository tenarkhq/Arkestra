/*---------------------------------------------------------------------------------------------
 *  Arkestra. What an agent did with its tools, as one line in its answer (the Claude app's
 *  "Checked the test progress", the Codex app's "Edited files and ran commands"). The rooms
 *  extension shows these lines folded between the answer's texts and leaves them out of what
 *  goes on to the agents and the clipboard.
 *--------------------------------------------------------------------------------------------*/

export type StepKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'other';

/** One step as a line of the answer's text. */
export function stepToken(kind: StepKind, label: string): string {
	const clean = label.replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›');
	return `<arkestra-step kind="${kind}">${clean.length > 140 ? `${clean.slice(0, 139)}…` : clean}</arkestra-step>`;
}

const IRREGULAR: Record<string, string> = {
	run: 'ran', read: 'read', find: 'found', get: 'got', make: 'made', build: 'built', write: 'wrote', set: 'set', put: 'put',
	send: 'sent', take: 'took', give: 'gave', show: 'showed', begin: 'began', keep: 'kept', let: 'let', do: 'did', see: 'saw',
	rebuild: 'rebuilt', rerun: 'reran', reset: 'reset', split: 'split', cut: 'cut', shut: 'shut', quit: 'quit', hold: 'held',
	leave: 'left', bring: 'brought', catch: 'caught', go: 'went', redo: 'redid', rewrite: 'rewrote', reread: 'reread',
	stop: 'stopped', drop: 'dropped', skip: 'skipped', ship: 'shipped', plan: 'planned', grep: 'grepped', commit: 'committed',
	submit: 'submitted', rerunning: 'reran', tag: 'tagged', diff: 'diffed', log: 'logged', zip: 'zipped', unzip: 'unzipped', scan: 'scanned',
};

/** A command's description ("Check the test progress") as the apps show a done step ("Checked the test progress"). */
export function pastTense(description: string): string {
	const m = /^(\s*)([A-Za-z]+)(.*)$/s.exec(description);
	if (!m) {
		return description;
	}
	const word = m[2];
	const lower = word.toLowerCase();
	let past: string;
	if (IRREGULAR[lower]) {
		past = IRREGULAR[lower];
	} else if (/ed$/.test(lower)) {
		return description; // already a past form
	} else if (/e$/.test(lower)) {
		past = `${lower}d`;
	} else if (/[^aeiou]y$/.test(lower)) {
		past = `${lower.slice(0, -1)}ied`;
	} else {
		past = `${lower}ed`;
	}
	const cased = word[0] === word[0].toUpperCase() ? past[0].toUpperCase() + past.slice(1) : past;
	return `${m[1]}${cased}${m[3]}`;
}

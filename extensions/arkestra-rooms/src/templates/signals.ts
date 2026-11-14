/*---------------------------------------------------------------------------------------------
 *  Arkestra. 2ARK room signals: the last line of an answer, alone on its line, not quoted.
 *  The signal words are 2ARK's protocol identifiers and stay Hungarian.
 *--------------------------------------------------------------------------------------------*/

export type Role = 'A' | 'B';
export const other = (role: Role): Role => role === 'A' ? 'B' : 'A';

/** The last non-empty line of an answer outside a fenced code block ("" when it is inside one). */
export function terminalLine(text: string): string {
	let fence: string | null = null;
	let last = '';
	let lastFenced = false;
	for (const line of String(text).split('\n')) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marker) {
			if (!fence) {
				fence = marker[1];
			} else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
				fence = null;
			}
			continue;
		}
		if (line.trim()) {
			last = line.trim();
			lastFenced = fence !== null;
		}
	}
	return lastFenced ? '' : last;
}

export const AGREE = 'EGYETÉRTEK';
const CODE_SIGNAL = /^\[(SZELET KÉSZ|KIOSZTÁS|TERV KÉSZ|ÁTEMELÉS|DÖNTÉS KELL|KÉSZ)\]$/u;
const AUDIT_SIGNAL = /^\[(AUDIT KÉSZ|ÖSSZEVETÉS KÉSZ|EGYETÉRTEK|DÖNTÉS KELL)\]$/u;

export type CodeSignal = 'SZELET KÉSZ' | 'KIOSZTÁS' | 'TERV KÉSZ' | 'ÁTEMELÉS' | 'DÖNTÉS KELL' | 'KÉSZ';
export type AuditSignal = 'AUDIT KÉSZ' | 'ÖSSZEVETÉS KÉSZ' | 'EGYETÉRTEK' | 'DÖNTÉS KELL';

export function codeSignal(text: string): CodeSignal | null {
	return (CODE_SIGNAL.exec(terminalLine(text))?.[1] as CodeSignal | undefined) ?? null;
}

export function auditSignal(text: string): AuditSignal | null {
	return (AUDIT_SIGNAL.exec(terminalLine(text))?.[1] as AuditSignal | undefined) ?? null;
}

export function verdictOf(text: string): 'PASS' | 'FAIL' | null {
	return (/^VERDIKT:\s*(PASS|FAIL)$/i.exec(terminalLine(text))?.[1]?.toUpperCase() as 'PASS' | 'FAIL' | undefined) ?? null;
}

/** The question before a [DÖNTÉS KELL] line: the last paragraph before the signal. */
export function questionOf(answer: string): string {
	const lines = answer.split('\n');
	while (lines.length && (!lines.at(-1)!.trim() || /^\[DÖNTÉS KELL\]$/.test(lines.at(-1)!.trim()))) {
		lines.pop();
	}
	const paragraphs = lines.join('\n').split(/\n\s*\n/);
	return (paragraphs.at(-1) ?? '').trim().slice(0, 400);
}

/** A commit title from an answer: the first real line, after the agent's name. */
export function commitTitle(who: string, answer: string): string {
	const first = answer.split('\n').map(l => l.replace(/^[#*\s>-]+/, '').trim()).find(l => l && !CODE_SIGNAL.test(l)) ?? 'szelet';
	return `${who}: ${first.slice(0, 72)}`;
}

/** Findings of an audit document: "### F3 · P1 · title" headings. */
export function auditFindings(text: string): { id: string; level: string; title: string }[] {
	const out: { id: string; level: string; title: string }[] = [];
	for (const m of text.matchAll(/^#{2,4}\s*(F\d+)\s*·\s*(P[0-3])\s*·\s*(.+?)\s*$/gm)) {
		if (!out.some(f => f.id === m[1])) {
			out.push({ id: m[1], level: m[2], title: m[3] });
		}
	}
	return out;
}

/** Which findings a reply picks: "P0 és P1", "P0–P2", "mind", "F2, F5". */
export function pickFindings(text: string, findings: readonly { id: string; level: string }[]): string[] {
	const t = text.toUpperCase();
	if (/\b(MIND|ALL|ÖSSZES)\b/u.test(t)) {
		return findings.map(f => f.id);
	}
	const ids = new Set<string>();
	for (const m of t.matchAll(/\bF(\d+)\b/g)) {
		ids.add(`F${m[1]}`);
	}
	const range = /\bP([0-3])\s*[–-]\s*P([0-3])\b/.exec(t);
	const levels = new Set<string>();
	if (range) {
		for (let n = Number(range[1]); n <= Number(range[2]); n++) {
			levels.add(`P${n}`);
		}
	}
	for (const m of t.matchAll(/\bP([0-3])\b/g)) {
		levels.add(`P${m[1]}`);
	}
	return findings.filter(f => ids.has(f.id) || levels.has(f.level)).map(f => f.id);
}

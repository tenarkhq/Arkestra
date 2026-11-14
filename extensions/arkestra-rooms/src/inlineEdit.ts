/*---------------------------------------------------------------------------------------------
 *  Arkestra. ⌘K edit in place: the request one agent gets for a selection (or the cursor),
 *  and reading the replacement code out of its answer. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import type { Message } from './room';

export interface InlineRequest {
	/** Workspace-relative path, for the agent's orientation. */
	readonly file: string;
	readonly language: string;
	/** The lines being replaced (whole lines); empty when code is inserted at the cursor. */
	readonly selected: string;
	/** Lines before and after the selection, as context. */
	readonly before: string;
	readonly after: string;
	/** First line number (1-based) of the selection or insertion point. */
	readonly line: number;
	readonly instruction: string;
	/** Earlier rounds of this edit: what was asked and what the agent proposed. */
	readonly history?: readonly { readonly instruction: string; readonly proposal: string }[];
}

/** Lines of context sent before and after the selection. */
export const CONTEXT_LINES = 80;

const fence = (text: string, language: string) => {
	const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map(m => m[0].length + 1)));
	return `${ticks}${language}\n${text}${text.endsWith('\n') || !text ? '' : '\n'}${ticks}`;
};

/** The request text: the instruction, the code around it and the strict answer format. */
export function inlinePrompt(req: InlineRequest): string {
	const target = req.selected
		? `A kijelölt kód (${req.file}, ${req.line}. sortól):\n\n${fence(req.selected, req.language)}`
		: `A kurzor helye: ${req.file}, ${req.line}. sor. Ide kell új kódot írni; a kijelölés üres.`;
	const history = (req.history ?? []).map((h, i) => `${i + 1}. kérés: ${h.instruction}\nA javaslatod erre:\n\n${fence(h.proposal, req.language)}`).join('\n\n');
	return [
		'Helyben szerkesztés (⌘K) az Arkestrában. Egyetlen kódrészletet kell megírnod; a fájlhoz ne nyúlj, eszközt ne használj, parancsot ne futtass.',
		`Környezet előtte (${req.file}):\n\n${fence(req.before, req.language)}`,
		target,
		`Környezet utána:\n\n${fence(req.after, req.language)}`,
		...(history ? [`Eddig ebben a szerkesztésben:\n\n${history}`] : []),
		`A kérés: ${req.instruction}`,
		req.selected
			? 'A válaszod egyetlen kódblokk legyen: a kijelölés helyére kerülő teljes kód, ugyanazzal a behúzással. Magyarázat nélkül.'
			: 'A válaszod egyetlen kódblokk legyen: a kurzor helyére beszúrandó kód, a környezet behúzásával. Magyarázat nélkül.',
	].join('\n\n');
}

/** The one-message transcript an agent turn gets for the request. */
export function inlineTranscript(req: InlineRequest, at: Date): Message[] {
	return [{ id: `inline-${at.getTime().toString(36)}`, at: at.toISOString(), author: { kind: 'user', id: 'user', name: 'You' }, text: inlinePrompt(req) }];
}

/**
 * The replacement code in an answer: the longest fenced block (agents sometimes add a
 * short example block too), else the whole answer when it has no fence at all.
 * `undefined` when the answer has no code (an apology, an error).
 */
export function extractCode(answer: string): string | undefined {
	const blocks: string[] = [];
	const re = /^([ \t]*)(`{3,}|~{3,})[^\n`]*\n([\s\S]*?)^\1\2[ \t]*$/gm;
	for (const m of answer.matchAll(re)) {
		const indent = m[1];
		blocks.push(m[3].split('\n').map(l => l.startsWith(indent) ? l.slice(indent.length) : l).join('\n'));
	}
	if (blocks.length) {
		return blocks.reduce((a, b) => (b.length > a.length ? b : a)).replace(/\n$/, '');
	}
	const text = answer.trim();
	return text && !/^\[error\]/.test(text) && !/```/.test(text) ? text : undefined;
}

/**
 * Fits the code to the lines it replaces: a selection ending in a newline keeps it, and
 * when the agent dropped the selection's common indentation, it is put back.
 */
export function fitReplacement(code: string, selected: string, indentAt = ''): string {
	const lead = (text: string) => {
		const lines = text.split('\n').filter(l => l.trim());
		return lines.length ? lines.reduce((min, l) => {
			const ws = /^[ \t]*/.exec(l)![0];
			return ws.length < min.length ? ws : min;
		}, /^[ \t]*/.exec(lines[0])![0]) : '';
	};
	const want = selected ? lead(selected) : indentAt;
	let out = code;
	if (want && !lead(code)) {
		out = code.split('\n').map(l => (l.trim() ? want + l : l)).join('\n');
	}
	if (selected.endsWith('\n') && !out.endsWith('\n')) {
		out += '\n';
	}
	return out;
}

/** A proposal's place in the document, as whole lines [start, end) (0-based). */
export interface LineSpan {
	readonly start: number;
	readonly end: number;
}

/**
 * Keeps a proposal's lines in place while the document changes around it: an edit above
 * moves it, an edit touching it grows or shrinks it, an edit below leaves it.
 * `change`: the replaced lines [start, end] (0-based, inclusive) and how many lines the
 * new text has (a text without newline is one line).
 */
export function shiftSpan(span: LineSpan, change: { start: number; end: number; lines: number }): LineSpan {
	const delta = change.lines - (change.end - change.start + 1);
	if (change.end < span.start) {
		return { start: span.start + delta, end: span.end + delta };
	}
	if (change.start >= span.end) {
		return span;
	}
	return { start: Math.min(span.start, change.start), end: Math.max(span.start, span.end + delta) };
}

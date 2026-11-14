/*---------------------------------------------------------------------------------------------
 *  Arkestra. Shared rules and memory for every agent (AR23): the user's and the project's
 *  rules (the user's rules.md, AGENTS.md, CLAUDE.md, .arkestra/rules.md) and memory, one
 *  block every agent gets when it has not seen this version yet. Agents add to the memory
 *  with an [EMLÉK] line. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

export interface SharedSource {
	/** `Szabályok · projekt (AGENTS.md)` */
	readonly label: string;
	readonly text: string;
	readonly kind: 'rules' | 'memory';
}

/** Characters of the whole block; memory keeps its newest entries when cut. */
export const SHARED_LIMIT = 40_000;

export const MEMORY_HOWTO = 'Ha olyat tudsz meg, amit minden agentnek érdemes megjegyeznie (döntés, konvenció, buktató), írd a válaszodba egy külön sorba: [EMLÉK] a megjegyzés. Az Arkestra felveszi a projekt közös memóriájába.';

/** The block and its version (a hash: a changed rule or a new memory makes a new version). */
export function sharedBlock(sources: readonly SharedSource[]): { text: string; version: string } {
	const parts: string[] = [];
	let room = SHARED_LIMIT;
	// Rules first and whole as far as they fit; memory after, newest entries kept.
	for (const s of [...sources.filter(s => s.kind === 'rules'), ...sources.filter(s => s.kind === 'memory')]) {
		const body = s.text.trim();
		if (!body || room <= 0) {
			continue;
		}
		let text = body;
		if (text.length > room) {
			text = s.kind === 'memory' ? text.slice(text.length - room).replace(/^[^\n]*\n/, '') : `${text.slice(0, room)}\n…`;
		}
		room -= text.length;
		parts.push(`## ${s.label}\n\n${text}`);
	}
	const text = ['Közös szabályok és memória (Arkestra; minden agent ugyanezt kapja):', ...parts, MEMORY_HOWTO].join('\n\n');
	return { text, version: createHash('sha1').update(text).digest('hex').slice(0, 16) };
}

/** Lines outside code blocks. */
function plainLines(text: string): string[] {
	const out: string[] = [];
	let fence: string | undefined;
	for (const line of text.split('\n')) {
		const m = /^\s*(`{3,}|~{3,})/.exec(line);
		if (m) {
			fence = fence ? (m[1].startsWith(fence) ? undefined : fence) : m[1];
			continue;
		}
		if (!fence) {
			out.push(line);
		}
	}
	return out;
}

/** The [EMLÉK] / [MEMORY] lines of an answer, outside code blocks, each once. */
export function extractMemories(answer: string): string[] {
	const found = plainLines(answer)
		.map(l => /^\s*(?:[-*]\s*)?\[(?:EMLÉK|EMLEK|MEMORY)\]\s*:?\s*(.+?)\s*$/i.exec(l)?.[1])
		.filter((x): x is string => !!x && x.length > 2);
	return [...new Set(found)];
}

/** A memory entry line: date, who, what. */
export function memoryEntry(text: string, author: string, at: Date): string {
	return `- ${at.toISOString().slice(0, 10)} · ${author}: ${text.replace(/\s+/g, ' ').trim()}`;
}

/** Entries not in the memory yet (the same text from another agent is not repeated). */
export function newEntries(memory: string, texts: readonly string[]): string[] {
	const known = new Set(memory.split('\n').map(l => /^- \d{4}-\d{2}-\d{2} · [^:]+: (.*)$/.exec(l)?.[1]?.trim().toLowerCase()).filter(Boolean));
	return texts.filter(t => !known.has(t.replace(/\s+/g, ' ').trim().toLowerCase()));
}

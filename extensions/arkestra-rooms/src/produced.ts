/*---------------------------------------------------------------------------------------------
 *  Arkestra. What an agent produced to keep (AR26), read from its tool uses: the files it wrote
 *  (pages, documents, SVG, diagrams: Claude Code's Write and Edit, Codex's apply_patch adds) and
 *  the claude.ai artifacts it published (the Artifact tool and the address its result gave).
 *  Shell commands and code files are not artifacts. Reads Claude Code session or stream-json
 *  lines and Codex rollout lines alike. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

/** One thing an agent produced, as the room keeps it. */
export interface ProducedArtifact {
	/** The tool use's id: the same tool use read again is not kept twice. */
	readonly id: string;
	readonly agentId: string;
	readonly at: string;
	readonly kind: 'diagram' | 'document' | 'page' | 'image';
	/** The file's name. */
	readonly title: string;
	/** The file's text; empty when only its path is known (an edit of a file written elsewhere). */
	readonly content: string;
	readonly path?: string;
	/** Replacements an edit made, applied to the latest version when the room has one. */
	readonly edits?: readonly { readonly old: string; readonly new: string; readonly all?: boolean }[];
	/** The published artifact's address (claude.ai). */
	readonly url?: string;
	readonly language?: string;
}

/** The longest text kept per produced file (a preview, not an archive). */
export const PRODUCED_LIMIT = 200_000;

const KIND_BY_EXTENSION: Record<string, ProducedArtifact['kind']> = {
	html: 'page', htm: 'page', md: 'document', markdown: 'document', mdx: 'document', svg: 'image', mmd: 'diagram', mermaid: 'diagram',
};

/** The kind a file of this name is kept as; undefined: not an artifact (code, config, logs). */
export function producedKind(file: string): ProducedArtifact['kind'] | undefined {
	const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
	return ext ? KIND_BY_EXTENSION[ext] : undefined;
}

/** A claude.ai artifact address: claude.ai/artifact/<id> or claude.ai/code/artifact/<uuid>. */
export const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g;

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const parse = (line: string): any => {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
};
const textOf = (content: unknown): string => typeof content === 'string' ? content
	: Array.isArray(content) ? content.map(c => typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : '').join('\n') : '';

/** The files a Codex patch adds, with their text. */
export function patchAdds(patch: string): { path: string; content: string }[] {
	const out: { path: string; content: string }[] = [];
	let current: { path: string; lines: string[] } | undefined;
	for (const line of patch.split('\n')) {
		const add = /^\*\*\* Add File: (.+)$/.exec(line);
		if (add || line.startsWith('*** ')) {
			if (current) {
				out.push({ path: current.path, content: current.lines.join('\n') });
			}
			current = add ? { path: add[1].trim(), lines: [] } : undefined;
		} else if (current && line.startsWith('+')) {
			current.lines.push(line.slice(1));
		}
	}
	if (current) {
		out.push({ path: current.path, content: current.lines.join('\n') });
	}
	return out;
}

/** The patch text of a Codex tool call: apply_patch itself, or a shell command that runs it. */
function codexPatch(payload: any): string | undefined {
	const name = String(payload?.name ?? '');
	let input: unknown = payload?.input;
	if (input === undefined && typeof payload?.arguments === 'string') {
		const args = parse(payload.arguments);
		input = args?.input ?? args?.patch ?? args?.command ?? args?.cmd;
	}
	const text = Array.isArray(input) ? input.join(' ') : typeof input === 'string' ? input : '';
	return (name === 'apply_patch' || text.includes('*** Begin Patch')) && text.includes('*** Add File:') ? text : undefined;
}

/**
 * The artifacts in a stretch of session lines, in order. A publish (the Artifact tool) is kept
 * once its result names the address; its text is the file's text written before, if seen.
 */
export function artifactsFromSessionLines(lines: readonly string[], agentId: string): ProducedArtifact[] {
	const out: ProducedArtifact[] = [];
	const written = new Map<string, string>();
	const publishes = new Map<string, { path: string; at: string }>();
	const file = (id: string, at: string, path: string, content: string, extra: Partial<ProducedArtifact> = {}) => {
		const kind = producedKind(path);
		if (!kind) {
			return;
		}
		out.push({ id, agentId, at, kind, title: baseName(path), content: content.slice(0, PRODUCED_LIMIT), path, ...extra });
	};
	for (const line of lines) {
		const row = line.trim() ? parse(line) : undefined;
		if (!row || typeof row !== 'object') {
			continue;
		}
		const at = typeof row.timestamp === 'string' ? row.timestamp : '';
		// Codex: response items of its rollout file.
		if (row.type === 'response_item' && row.payload) {
			const patch = codexPatch(row.payload);
			if (patch) {
				patchAdds(patch).forEach((a, i) => file(`${row.payload.call_id ?? row.payload.id ?? at}:${i}`, at, a.path, a.content));
			}
			continue;
		}
		const content = row.message?.content;
		if (!Array.isArray(content)) {
			continue;
		}
		for (const block of content) {
			if (block?.type === 'tool_use' && typeof block.id === 'string') {
				const name = String(block.name ?? '').replace(/^mcp__.*__/, '');
				const input = block.input ?? {};
				const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '';
				if (name === 'Write' && path && typeof input.content === 'string') {
					written.set(path, input.content);
					file(block.id, at, path, input.content);
				} else if ((name === 'Edit' || name === 'MultiEdit') && path) {
					const edits = (name === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits : [])
						.filter((e: any) => typeof e?.old_string === 'string' && typeof e?.new_string === 'string')
						.map((e: any) => ({ old: e.old_string, new: e.new_string, ...(e.replace_all ? { all: true } : {}) }));
					if (edits.length) {
						file(block.id, at, path, '', { edits });
					}
				} else if (name === 'Artifact' && path && (input.action === undefined || input.action === 'publish') && !input.asset) {
					publishes.set(block.id, { path, at });
				}
			} else if (block?.type === 'tool_result' && publishes.has(block.tool_use_id)) {
				const publish = publishes.get(block.tool_use_id)!;
				const url = textOf(block.content).match(ARTIFACT_URL)?.[0];
				if (url && !block.is_error) {
					file(block.tool_use_id, at || publish.at, publish.path, written.get(publish.path) ?? '', { url });
				}
			}
		}
	}
	return out;
}

/** The room's list with these added; a tool use it already has is not added again. */
export function mergeProduced(have: readonly ProducedArtifact[] | undefined, found: readonly ProducedArtifact[]): ProducedArtifact[] | undefined {
	const ids = new Set((have ?? []).map(p => p.id));
	const fresh = found.filter(p => !ids.has(p.id) && (ids.add(p.id), true));
	return fresh.length ? [...(have ?? []), ...fresh] : undefined;
}

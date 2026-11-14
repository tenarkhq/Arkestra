/*---------------------------------------------------------------------------------------------
 *  Arkestra. Permission lists per machine and per project: what agents may do without asking
 *  (allow) and what they may never do (deny). One rule syntax for every agent, the same as
 *  Claude Code's: `Bash(npm test:*)`, `Bash(git status)`, `Edit(src/**)`, `Read`,
 *  `WebFetch(domain:github.com)`, `mcp__server__tool`, `*`. Deny wins over allow; a request no
 *  rule covers is asked. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

export interface PermissionRules {
	readonly allow: readonly string[];
	readonly deny: readonly string[];
}

/** What an agent wants to do, in the rules' terms. */
export interface PermissionRequest {
	/** `Bash`, `Edit`, `Read`, `WebFetch`, or another tool's own name (an MCP tool). */
	readonly tool: string;
	readonly command?: string;
	readonly path?: string;
	readonly url?: string;
	/** For the question shown to the user. */
	readonly title: string;
}

export type Decision = 'allow' | 'deny';

export const EMPTY_RULES: PermissionRules = { allow: [], deny: [] };

/** Rules from settings: strings only, trimmed, without duplicates. */
export function readRules(value: unknown): PermissionRules {
	const list = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean))] : [];
	const o = (value && typeof value === 'object' ? value : {}) as { allow?: unknown; deny?: unknown };
	return { allow: list(o.allow), deny: list(o.deny) };
}

/** Machine and project rules together: both lists are joined, deny still wins. */
export function combine(...sets: readonly PermissionRules[]): PermissionRules {
	return { allow: [...new Set(sets.flatMap(s => s.allow))], deny: [...new Set(sets.flatMap(s => s.deny))] };
}

/** `Tool(spec)` → tool and spec; a bare `Tool` has no spec. Undefined for a malformed rule. */
export function parseRule(rule: string): { tool: string; spec?: string } | undefined {
	const m = /^([A-Za-z_*][\w.*-]*)(?:\((.*)\))?$/s.exec(rule.trim());
	return m ? { tool: m[1], ...(m[2] !== undefined ? { spec: m[2] } : {}) } : undefined;
}

/** Glob → RegExp: `**` any depth, `*` within a segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
			i += glob[i + 2] === '/' ? 2 : 1;
		} else if (c === '*') {
			re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${re}$`);
}

const normalizeCommand = (command: string) => command.trim().replace(/\s+/g, ' ');

/**
 * A shell command's parts: `a && b; c | d` → four commands. Quotes are respected; a
 * subshell or command substitution makes the whole line one part (it is matched as is).
 */
export function commandParts(command: string): string[] {
	if (/\$\(|`/.test(command)) {
		return [normalizeCommand(command)];
	}
	const parts: string[] = [];
	let current = '';
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			current += c;
			if (c === quote) {
				quote = undefined;
			}
		} else if (c === '"' || c === "'") {
			quote = c;
			current += c;
		} else if (c === ';' || c === '\n' || (c === '&' && command[i + 1] === '&') || (c === '|')) {
			parts.push(current);
			current = '';
			if ((c === '&' || c === '|') && command[i + 1] === c) {
				i++;
			}
		} else {
			current += c;
		}
	}
	parts.push(current);
	return parts.map(normalizeCommand).filter(Boolean);
}

/**
 * Whether one command matches a Bash rule's spec: `npm test:*` (or `npm test *`) is the
 * command with any arguments, `npm test*` any command starting so, anything else exact.
 */
function commandMatches(spec: string, command: string): boolean {
	const s = normalizeCommand(spec);
	if (s.endsWith(':*') || s.endsWith(' *')) {
		const base = s.slice(0, -2).trimEnd();
		return command === base || command.startsWith(`${base} `);
	}
	if (s.endsWith('*')) {
		return command.startsWith(s.slice(0, -1));
	}
	return command === s;
}

/** Relative to the project when inside it, with forward slashes. */
export function relativePath(path: string, root?: string): string {
	const p = path.replace(/\\/g, '/');
	const r = root?.replace(/\\/g, '/').replace(/\/+$/, '');
	return r && (p === r || p.startsWith(`${r}/`)) ? p.slice(r.length + 1) || '.' : p;
}

/** Whether a rule covers a request (for one command part, when it is a command). */
function ruleMatches(rule: string, req: PermissionRequest, command: string | undefined, root?: string): boolean {
	if (rule.trim() === '*') {
		return true;
	}
	const parsed = parseRule(rule);
	if (!parsed) {
		return false;
	}
	const tool = parsed.tool === 'Write' || parsed.tool === 'MultiEdit' ? 'Edit' : parsed.tool;
	if (tool !== req.tool) {
		return false;
	}
	if (parsed.spec === undefined || parsed.spec === '*' || parsed.spec === '**') {
		return true;
	}
	switch (tool) {
		case 'Bash':
			return command !== undefined && commandMatches(parsed.spec, command);
		case 'Edit':
		case 'Read': {
			if (!req.path) {
				return false;
			}
			const rel = relativePath(req.path, root);
			const glob = parsed.spec.replace(/^\.\//, '');
			return globToRegExp(glob).test(rel) || (glob.endsWith('/') && rel.startsWith(glob)) || globToRegExp(`${glob.replace(/\/$/, '')}/**`).test(rel);
		}
		case 'WebFetch': {
			const domain = /^domain:(.+)$/.exec(parsed.spec)?.[1]?.toLowerCase();
			if (!domain || !req.url) {
				return false;
			}
			try {
				const host = new URL(req.url).hostname.toLowerCase();
				return host === domain || host.endsWith(`.${domain}`);
			} catch {
				return false;
			}
		}
		default:
			return globToRegExp(parsed.spec).test(req.title);
	}
}

/**
 * The decision for a request: 'deny' when any deny rule covers it (any part of a compound
 * command), 'allow' when allow rules cover all of it, else undefined (ask).
 */
export function decide(rules: PermissionRules, req: PermissionRequest, root?: string): Decision | undefined {
	const parts = req.tool === 'Bash' && req.command ? commandParts(req.command) : [undefined];
	const covered = (list: readonly string[], part: string | undefined) => list.some(rule => ruleMatches(rule, req, part, root));
	if (parts.some(part => covered(rules.deny, part))) {
		return 'deny';
	}
	return parts.every(part => covered(rules.allow, part)) ? 'allow' : undefined;
}

/** The rule "always allow" adds for a request: the command's first two words, the file's folder. */
export function suggestRule(req: PermissionRequest, root?: string): string {
	switch (req.tool) {
		case 'Bash': {
			const first = commandParts(req.command ?? '')[0] ?? '';
			const words = first.split(' ');
			return words.length > 2 || (words.length === 2 && !/^-/.test(words[1])) ? `Bash(${words.slice(0, 2).join(' ')}:*)` : `Bash(${first})`;
		}
		case 'Edit':
		case 'Read': {
			if (!req.path) {
				return req.tool;
			}
			const rel = relativePath(req.path, root);
			const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
			return `${req.tool}(${dir ? `${dir}/**` : rel})`;
		}
		case 'WebFetch':
			try {
				return `WebFetch(domain:${new URL(req.url ?? '').hostname})`;
			} catch {
				return 'WebFetch';
			}
		default:
			return req.tool;
	}
}

/** Claude Code's flags for the rules (its syntax is ours). */
export function claudeArgs(rules: PermissionRules): string[] {
	return [
		...(rules.allow.length ? ['--allowedTools', ...rules.allow] : []),
		...(rules.deny.length ? ['--disallowedTools', ...rules.deny] : []),
	];
}

/** An ACP tool call in the rules' terms (its kind, raw input and locations). */
export function fromAcpToolCall(call: { kind?: string; title?: string; rawInput?: unknown; locations?: { path?: string }[] }): PermissionRequest {
	const raw = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
	const str = (v: unknown) => typeof v === 'string' ? v : Array.isArray(v) && v.every(x => typeof x === 'string') ? v.join(' ') : undefined;
	const path = call.locations?.find(l => typeof l.path === 'string')?.path ?? str(raw.path ?? raw.file_path ?? raw.filePath);
	const title = call.title ?? call.kind ?? 'tool';
	switch (call.kind) {
		case 'execute':
			return { tool: 'Bash', command: str(raw.command ?? raw.cmd) ?? title, title };
		case 'edit':
		case 'delete':
		case 'move':
			return { tool: 'Edit', ...(path ? { path } : {}), title };
		case 'read':
		case 'search':
			return { tool: 'Read', ...(path ? { path } : {}), title };
		case 'fetch':
			return { tool: 'WebFetch', ...(str(raw.url) ? { url: str(raw.url) } : {}), title };
		default:
			return { tool: str(raw.tool ?? raw.name) ?? 'Other', title };
	}
}

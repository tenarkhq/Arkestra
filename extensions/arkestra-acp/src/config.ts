/*---------------------------------------------------------------------------------------------
 *  Arkestra. The ACP agents kept in the `arkestra.acp.agents` setting.
 *--------------------------------------------------------------------------------------------*/

export interface AcpAgentConfig {
	readonly id: string;
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	/** A connections machine id; `local` (the default) is this machine. */
	readonly machine: string;
}

/** Valid entries of the raw setting; broken ones are skipped, never thrown on. */
export function readAgents(raw: unknown): AcpAgentConfig[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	const agents: AcpAgentConfig[] = [];
	for (const entry of raw) {
		const e = entry as Record<string, unknown> | null;
		if (!e || typeof e.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(e.id) || typeof e.command !== 'string' || !e.command.trim()) {
			continue;
		}
		const machine = typeof e.machine === 'string' && /^[A-Za-z0-9-]+$/.test(e.machine) ? e.machine : 'local';
		const key = `${e.id}@${machine}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const env: Record<string, string> = {};
		if (e.env && typeof e.env === 'object' && !Array.isArray(e.env)) {
			for (const [k, v] of Object.entries(e.env)) {
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') {
					env[k] = v;
				}
			}
		}
		agents.push({
			id: e.id,
			name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : e.id,
			command: e.command.trim(),
			args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [],
			env,
			machine,
		});
	}
	return agents;
}

/** The registry id: the plain id on this machine, `id@machine` elsewhere. */
export function registryId(agent: AcpAgentConfig): string {
	return agent.machine === 'local' ? agent.id : `${agent.id}@${agent.machine}`;
}

/** Splits a command line typed by the user into command and arguments (quotes respected). */
export function splitCommandLine(line: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quote: string | undefined;
	let has = false;
	for (const ch of line.trim()) {
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
			has = true;
		} else if (/\s/.test(ch)) {
			if (current || has) {
				parts.push(current);
			}
			current = '';
			has = false;
		} else {
			current += ch;
		}
	}
	if (current || has) {
		parts.push(current);
	}
	return parts;
}

/*---------------------------------------------------------------------------------------------
 *  Arkestra. The ACP Registry (cdn.agentclientprotocol.com): agents and how to start them.
 *--------------------------------------------------------------------------------------------*/

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export interface RegistryAgent {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly website?: string;
	/** How Arkestra starts it: an npx package runs as is, a binary has to be on the PATH. */
	readonly command: string;
	readonly args: readonly string[];
	readonly needsInstall: boolean;
}

/** Registry entries Arkestra can start, sorted by name; entries it cannot start are left out. */
export function readRegistry(raw: unknown, platform: string = process.platform, arch: string = process.arch): RegistryAgent[] {
	const agents = (raw as { agents?: unknown } | null)?.agents;
	if (!Array.isArray(agents)) {
		return [];
	}
	const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux';
	const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
	const out: RegistryAgent[] = [];
	for (const a of agents) {
		if (!a || typeof a.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(a.id) || typeof a.name !== 'string') {
			continue;
		}
		const strings = (x: unknown): string[] => Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
		const base = {
			id: a.id,
			name: a.name,
			...(typeof a.description === 'string' ? { description: a.description } : {}),
			...(typeof a.website === 'string' ? { website: a.website } : typeof a.repository === 'string' ? { website: a.repository } : {}),
		};
		const npx = a.distribution?.npx;
		const binary = a.distribution?.binary?.[`${os}-${cpu}`];
		if (npx && typeof npx.package === 'string') {
			out.push({ ...base, command: 'npx', args: ['-y', npx.package, ...strings(npx.args)], needsInstall: false });
		} else if (binary && typeof binary.cmd === 'string') {
			const name = binary.cmd.split('/').pop()!;
			out.push({ ...base, command: name, args: strings(binary.args), needsInstall: true });
		}
	}
	return out.sort((x, y) => x.name.localeCompare(y.name));
}

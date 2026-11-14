/*---------------------------------------------------------------------------------------------
 *  Arkestra. The machine list kept in the `arkestra.connections.machines` setting.
 *--------------------------------------------------------------------------------------------*/

import type { Machine } from './ssh';

/** Valid machines from the raw setting; broken entries are skipped, never thrown on. */
export function readMachines(raw: unknown): Machine[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>(['local']);
	const machines: Machine[] = [];
	for (const entry of raw) {
		const e = entry as Partial<Machine> | null;
		if (!e || typeof e.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(e.id) || seen.has(e.id) || typeof e.host !== 'string' || !e.host.trim()) {
			continue;
		}
		seen.add(e.id);
		machines.push({
			id: e.id,
			name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : e.host.trim(),
			host: e.host.trim(),
			...(typeof e.port === 'number' && e.port > 0 ? { port: e.port } : {}),
			...(typeof e.folder === 'string' && e.folder.trim() ? { folder: e.folder.trim() } : {}),
		});
	}
	return machines;
}

/** An id for a new machine from its name, unique among the existing ones. */
export function newMachineId(name: string, existing: readonly Machine[]): string {
	const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
	const taken = new Set(['local', ...existing.map(m => m.id)]);
	let id = base;
	for (let n = 2; taken.has(id); n++) {
		id = `${base}-${n}`;
	}
	return id;
}

/** Host aliases from an OpenSSH config file's text: `Host` lines without wildcards. */
export function sshConfigHosts(text: string): string[] {
	const hosts: string[] = [];
	for (const line of text.split('\n')) {
		const match = /^\s*Host\s+(.+)$/i.exec(line);
		if (match) {
			for (const host of match[1].trim().split(/\s+/)) {
				if (!/[*?!]/.test(host) && !hosts.includes(host)) {
					hosts.push(host);
				}
			}
		}
	}
	return hosts;
}

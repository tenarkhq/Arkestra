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

/** What a connection form (the Machines and Connections pages) sends: the SSH destination with an optional :port, a name, a folder. */
export interface ConnectionInput {
	readonly host?: unknown;
	readonly name?: unknown;
	readonly folder?: unknown;
}

/** The form's problems in the interface language. */
export interface ConnectionFormStrings {
	readonly hostRequired: string;
	readonly hostInvalid: string;
	readonly portInvalid: string;
	readonly nameTaken: string;
}

/**
 * A machine from a connection form, or the field that is wrong: a new one gets an id from its
 * name; an edited one keeps its id (its threads keep their agents). An empty name is the host's
 * name without the user; an empty folder is the home folder.
 */
export function connectionFromForm(input: ConnectionInput, existing: readonly Machine[], t: ConnectionFormStrings, id?: string): { machine: Machine } | { field: 'host' | 'name' | 'folder'; message: string } {
	const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
	const raw = text(input.host);
	if (!raw) {
		return { field: 'host', message: t.hostRequired };
	}
	if (/\s/.test(raw) || raw.startsWith('-')) {
		return { field: 'host', message: t.hostInvalid };
	}
	const port = /^(.+):(\d*)$/.exec(raw);
	const host = port ? port[1] : raw;
	const portNumber = port ? Number(port[2]) : undefined;
	if (port && (!port[2] || !Number.isInteger(portNumber) || portNumber! < 1 || portNumber! > 65535)) {
		return { field: 'host', message: t.portInvalid };
	}
	const name = text(input.name) || host.replace(/^.*@/, '');
	const others = existing.filter(m => m.id !== id);
	if (others.some(m => m.name.toLowerCase() === name.toLowerCase())) {
		return { field: 'name', message: t.nameTaken };
	}
	const folder = text(input.folder);
	return {
		machine: {
			id: id ?? newMachineId(name, existing),
			name,
			host,
			...(portNumber ? { port: portNumber } : {}),
			...(folder ? { folder } : {}),
		},
	};
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

/*---------------------------------------------------------------------------------------------
 *  Arkestra. Finds the relay without a form: the server that runs the relay leaves its address
 *  and this client's token in ~/.config/arkestra/relay.json, and Arkestra reads that file on
 *  this machine and over every SSH connection it already has. Nobody copies a token by hand;
 *  the Remote Control page's form stays only for a relay somewhere else.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface RelayAccess {
	readonly url: string;
	readonly token: string;
}

/** Where the relay's server leaves the file, relative to the account's home. */
export const RELAY_FILE = '.config/arkestra/relay.json';

/** The file's address and token when both are usable, else undefined (never throws). */
export function parseRelayFile(text: string): RelayAccess | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	const o = raw as { url?: unknown; token?: unknown } | null;
	if (!o || typeof o.url !== 'string' || typeof o.token !== 'string') {
		return undefined;
	}
	const url = o.url.trim().replace(/\/+$/, '');
	const token = o.token.trim();
	if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(url) || token.length < 24 || /\s/.test(token)) {
		return undefined;
	}
	return { url, token };
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Reads the relay file through a spawn function (an SSH machine's); undefined on any failure. */
export function readRelayFile(spawn: SpawnFn, timeoutMs = 10_000): Promise<RelayAccess | undefined> {
	return new Promise(resolve => {
		let out = '';
		let done = false;
		const finish = (v: RelayAccess | undefined) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
		let child: ChildProcess;
		try {
			child = spawn('sh', ['-c', `cat "$HOME/${RELAY_FILE}" 2>/dev/null`], { stdio: ['ignore', 'pipe', 'ignore'] });
		} catch {
			resolve(undefined);
			return;
		}
		const timer = setTimeout(() => { child.kill(); finish(undefined); }, timeoutMs);
		child.stdout?.on('data', (b: Buffer) => { if (out.length < 64 * 1024) { out += b.toString('utf8'); } });
		child.on('error', () => finish(undefined));
		child.on('close', () => finish(parseRelayFile(out)));
	});
}

/** The first usable relay file: the local one first, then each reader in order. */
export async function discoverRelay(local: () => Promise<string | undefined>, readers: readonly (() => Promise<RelayAccess | undefined>)[]): Promise<RelayAccess | undefined> {
	const own = await local().catch(() => undefined);
	const mine = own === undefined ? undefined : parseRelayFile(own);
	if (mine) {
		return mine;
	}
	const found = await Promise.all(readers.map(r => r().catch(() => undefined)));
	return found.find((f): f is RelayAccess => !!f);
}

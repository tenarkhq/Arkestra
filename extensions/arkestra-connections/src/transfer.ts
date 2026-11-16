/*---------------------------------------------------------------------------------------------
 *  Arkestra. File transfer to SSH machines (AR27): local files and folders go up as one tar
 *  stream over ssh (`tar -c` here, `tar -x` there), so folders keep their layout and no
 *  extra tool is needed on either side; remote folders are listed for the machine tree; a
 *  drop into an SSH terminal is recognised from the paths it types.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn } from 'node:child_process';
import * as path from 'node:path';
import { remotePath, shQuote, sshArgs, type Machine, type SpawnFn } from './ssh';

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** Shell words of a line: single and double quotes, backslash escapes. */
export function shellWords(text: string): string[] {
	const words: string[] = [];
	let word = '';
	let started = false;
	let quote: '"' | '\'' | undefined;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) {
				quote = undefined;
			} else if (c === '\\' && quote === '"' && i + 1 < text.length) {
				word += text[++i];
			} else {
				word += c;
			}
		} else if (c === '"' || c === '\'') {
			quote = c;
			started = true;
		} else if (c === '\\' && i + 1 < text.length) {
			word += text[++i];
			started = true;
		} else if (/\s/.test(c)) {
			if (started) {
				words.push(word);
				word = '';
				started = false;
			}
		} else {
			word += c;
			started = true;
		}
	}
	if (started) {
		words.push(word);
	}
	return words;
}

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/**
 * The local paths a drop typed into a terminal, or undefined when the input is something
 * else: every word must be an absolute path that exists here.
 */
export function droppedPaths(input: string, exists: (p: string) => boolean): string[] | undefined {
	const text = input.split(PASTE_START).join('').split(PASTE_END).join('');
	if (!text.trim() || /[\r\n]/.test(text)) {
		return undefined;
	}
	const words = shellWords(text);
	return words.length && words.every(w => isAbsolute(w) && exists(w)) ? words : undefined;
}

/** A remote path joined for the shell scripts (`~` stays the remote home). */
export function joinRemote(dir: string, name: string): string {
	return dir === '~' ? `~/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

/** The folder one up from a remote folder (`~` and `~/…` through `..`, as the shell resolves them); none above `/`. */
export function remoteParent(dir: string): string | undefined {
	if (dir === '/') {
		return undefined;
	}
	return dir === '~' || dir.startsWith('~/') ? joinRemote(dir, '..') : path.posix.dirname(dir.replace(/\/+$/, '') || '/');
}

/** The remote side of an upload: the folder is created, the tar stream unpacked into it. */
export function untarScript(remoteDir: string): string {
	const dir = remotePath(remoteDir);
	return `mkdir -p ${dir} && tar -C ${dir} -xf -`;
}

/** The remote listing of a folder: one entry per line, folders end in '/'. */
export function listScript(remoteDir: string): string {
	return `cd ${remotePath(remoteDir)} && ls -1Ap`;
}

export interface RemoteEntry {
	readonly name: string;
	readonly folder: boolean;
}

/** `ls -1Ap` output as entries: folders first, then files, each by name. */
export function parseListing(out: string): RemoteEntry[] {
	return out.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l && l !== './' && l !== '../')
		.map(l => ({ name: l.replace(/\/$/, ''), folder: l.endsWith('/') }))
		.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
}

/** Local paths grouped by their folder: one tar per folder keeps each name as it is. */
export function groupByParent(paths: readonly string[]): { parent: string; names: string[] }[] {
	const groups = new Map<string, string[]>();
	for (const p of paths) {
		const parent = path.dirname(p);
		groups.set(parent, [...(groups.get(parent) ?? []), path.basename(p)]);
	}
	return [...groups].map(([parent, names]) => ({ parent, names }));
}

export interface TransferOptions {
	readonly ssh: string;
	readonly spawn?: SpawnFn;
}

/** Runs one script on the machine and collects its output. */
export function runRemote(machine: Machine, script: string, options: TransferOptions, timeoutMs = 30_000): Promise<{ ok: boolean; out: string; err: string }> {
	return new Promise(resolve => {
		const child = (options.spawn ?? nodeSpawn)(options.ssh, sshArgs(machine, script), { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => { out += c; });
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (c: string) => { err = (err + c).slice(-4000); });
		child.on('error', e => { clearTimeout(timer); resolve({ ok: false, out, err: e.message }); });
		child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
	});
}

/** The remote read of a text file: at most `max` bytes; exit 3 when it is not a file. */
export function readScript(remoteFile: string, max: number): string {
	const file = remotePath(remoteFile);
	return `[ -f ${file} ] || { echo 'No such file.' >&2; exit 3; }; head -c ${Math.max(1, Math.floor(max))} -- ${file}`;
}

/** A remote file's text (its first `max` bytes); throws with the remote error when it cannot be read. */
export async function readRemote(machine: Machine, remoteFile: string, options: TransferOptions, max = 512 * 1024): Promise<string> {
	const r = await runRemote(machine, readScript(remoteFile, max), options);
	if (!r.ok) {
		throw new Error(r.err.trim().split('\n').at(-1) || 'cat failed');
	}
	return r.out;
}

/** A remote folder's entries; throws with the remote error when it cannot be read. */
export async function listRemote(machine: Machine, remoteDir: string, options: TransferOptions): Promise<RemoteEntry[]> {
	const r = await runRemote(machine, listScript(remoteDir), options);
	if (!r.ok) {
		throw new Error(r.err.trim().split('\n').at(-1) || 'ls failed');
	}
	return parseListing(r.out);
}

/**
 * Uploads local files and folders into a remote folder: `tar -c` here piped into
 * `tar -x` there, one stream per local parent folder. `local` runs the local tar (tests).
 */
export async function upload(machine: Machine, localPaths: readonly string[], remoteDir: string, options: TransferOptions & { local?: SpawnFn }): Promise<void> {
	for (const { parent, names } of groupByParent(localPaths)) {
		await new Promise<void>((resolve, reject) => {
			const tar = (options.local ?? nodeSpawn)('tar', ['-C', parent, '-cf', '-', '--', ...names], { stdio: ['ignore', 'pipe', 'pipe'] });
			const remote = (options.spawn ?? nodeSpawn)(options.ssh, sshArgs(machine, untarScript(remoteDir)), { env: process.env, stdio: ['pipe', 'ignore', 'pipe'] });
			let err = '';
			let pending = 2;
			let failed = false;
			const done = (error?: string) => {
				if (failed) {
					return;
				}
				if (error) {
					failed = true;
					tar.kill();
					remote.kill();
					reject(new Error(error));
					return;
				}
				if (--pending === 0) {
					resolve();
				}
			};
			tar.stderr?.setEncoding('utf8');
			tar.stderr?.on('data', (c: string) => { err = (err + c).slice(-2000); });
			remote.stderr?.setEncoding('utf8');
			remote.stderr?.on('data', (c: string) => { err = (err + c).slice(-2000); });
			remote.stdin?.on('error', () => { /* the remote side closed; its exit code tells why */ });
			tar.stdout?.pipe(remote.stdin!);
			tar.on('error', e => done(e.message));
			remote.on('error', e => done(e.message));
			tar.on('close', code => done(code === 0 ? undefined : err.trim().split('\n').at(-1) || `tar exited with ${code}`));
			remote.on('close', code => done(code === 0 ? undefined : err.trim().split('\n').at(-1) || `remote tar exited with ${code}`));
		});
	}
}

/** The absolute path of a remote folder (made if missing): `~/…` resolved by the remote shell. */
export async function remoteFolder(machine: Machine, remoteDir: string, options: TransferOptions): Promise<string> {
	const r = await runRemote(machine, `mkdir -p ${remotePath(remoteDir)} && cd ${remotePath(remoteDir)} && pwd`, options);
	const dir = r.out.trim().split('\n').at(-1) ?? '';
	if (!r.ok || !dir.startsWith('/')) {
		throw new Error(r.err.trim().split('\n').at(-1) || 'the folder could not be made');
	}
	return dir;
}

/** The remote paths of uploaded items, quoted for the remote shell. */
export function uploadedPaths(localPaths: readonly string[], remoteDir: string): string {
	return localPaths.map(p => {
		const target = joinRemote(remoteDir, path.basename(p));
		return target.startsWith('~/') ? `~/${shQuote(target.slice(2))}` : shQuote(target);
	}).join(' ');
}

/** ssh arguments for an interactive shell in a folder, sized to the terminal. */
export function shellArgs(machine: Machine, folder: string, size?: { columns: number; rows: number }): string[] {
	const script = [
		...(size ? [`stty rows ${size.rows} cols ${size.columns} 2>/dev/null`] : []),
		`cd ${remotePath(folder)} || exit 98`,
		'exec "${SHELL:-sh}" -l',
	].join('; ');
	return ['-tt', ...(machine.port ? ['-p', String(machine.port)] : []), machine.host, `sh -c ${shQuote(script)}`];
}

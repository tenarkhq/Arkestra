/*---------------------------------------------------------------------------------------------
 *  Arkestra. The relay found by itself, and the pairing link's QR code.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { discoverRelay, parseRelayFile, readRelayFile } from '../relayDiscovery';
import { qrMatrix, qrPath } from '../qr';

const TOKEN = 'f'.repeat(48);

test('relay file: https address and a long token; anything else is not used', () => {
	assert.deepEqual(parseRelayFile(`{ "url": "https://tenark.dev/arkestra/", "token": "${TOKEN}" }`), { url: 'https://tenark.dev/arkestra', token: TOKEN });
	assert.equal(parseRelayFile(`{ "url": "http://tenark.dev/arkestra", "token": "${TOKEN}" }`), undefined);
	assert.equal(parseRelayFile('{ "url": "https://tenark.dev/arkestra", "token": "short" }'), undefined);
	assert.equal(parseRelayFile('not json'), undefined);
	assert.equal(parseRelayFile(''), undefined);
});

function fakeSpawn(out: string | Error): (c: string, a: string[]) => ChildProcess {
	return (_c, args) => {
		assert.match(args[1], /\.config\/arkestra\/relay\.json/);
		const child = new EventEmitter() as ChildProcess & EventEmitter;
		const stdout = new EventEmitter();
		Object.assign(child, { stdout, kill: () => true });
		setImmediate(() => {
			if (out instanceof Error) {
				child.emit('error', out);
			} else {
				stdout.emit('data', Buffer.from(out));
				child.emit('close', 0);
			}
		});
		return child;
	};
}

test('discovery: this machine first, then the SSH machines; a machine that fails is skipped', async () => {
	const good = `{ "url": "https://tenark.dev/arkestra", "token": "${TOKEN}" }`;
	assert.deepEqual(await discoverRelay(async () => good, []), { url: 'https://tenark.dev/arkestra', token: TOKEN });
	const viaSsh = await discoverRelay(async () => { throw new Error('ENOENT'); }, [
		() => readRelayFile(fakeSpawn(new Error('ssh failed'))),
		() => readRelayFile(fakeSpawn('')),
		() => readRelayFile(fakeSpawn(good)),
	]);
	assert.deepEqual(viaSsh, { url: 'https://tenark.dev/arkestra', token: TOKEN });
	assert.equal(await discoverRelay(async () => undefined, [() => readRelayFile(fakeSpawn(''))]), undefined);
});

test('QR: the smallest version for the pairing link, finder patterns in three corners, quiet zone in the path', () => {
	const link = `https://tenark.dev/arkestra/remote/app#c=${'a'.repeat(22)}&k=${'b'.repeat(43)}`;
	const m = qrMatrix(link);
	assert.equal(m.length, 45); // version 7, level M
	const finder = (x: number, y: number) => [0, 1, 2, 3, 4, 5, 6].every(i => m[y][x + i] && m[y + 6][x + i] && m[y + i][x] && m[y + i][x + 6]) && !m[y + 1][x + 1] && m[y + 3][x + 3];
	assert.ok(finder(0, 0) && finder(m.length - 7, 0) && finder(0, m.length - 7));
	assert.equal(qrMatrix('hi').length, 21);
	const p = qrPath('hi');
	assert.equal(p.size, 29);
	assert.match(p.d, /^M4 4h1v1h-1z/);
});

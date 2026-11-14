// AR33 · The update feed: the paths and fields the update patch reads, the commit the
// build writes into product.json, and macOS only when signed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('./update-feed.sh', import.meta.url).pathname;
const V = '1.143.17651';
const names = [`Arkestra-linux-x64-${V}.tar.gz`, `ArkestraSetup-x64-${V}.exe`, `ArkestraUserSetup-x64-${V}.exe`, `Arkestra-win32-x64-${V}.zip`, `Arkestra-darwin-arm64-${V}.zip`];

function run(env) {
	const dir = mkdtempSync(join(tmpdir(), 'feed-'));
	const assets = join(dir, 'assets');
	const feed = join(dir, 'feed');
	execFileSync('mkdir', ['-p', assets]);
	for (const n of names) {
		writeFileSync(join(assets, n), n);
	}
	writeFileSync(join(assets, names[1] + '.sha256'), 'abc  ' + names[1] + '\n');
	execFileSync('bash', [script, assets, feed], { env: { ...process.env, RELEASE_VERSION: V, ASSETS_REPOSITORY: 'tenarkhq/Arkestra', ...env }, stdio: 'pipe' });
	return feed;
}

test('feed: one latest.json per platform and installer, with the build commit and hashes', () => {
	const feed = run({});
	const linux = JSON.parse(readFileSync(join(feed, 'stable/linux/x64/latest.json'), 'utf8'));
	assert.equal(linux.url, `https://github.com/tenarkhq/Arkestra/releases/download/${V}/Arkestra-linux-x64-${V}.tar.gz`);
	assert.equal(linux.name, V);
	assert.equal(linux.productVersion, '1.143.17651.0');
	assert.equal(linux.version, createHash('sha1').update(V + '\n').digest('hex'), 'the commit version.sh writes into product.json');
	assert.equal(linux.hash, createHash('sha1').update(names[0]).digest('hex'));
	assert.equal(linux.sha256hash, createHash('sha256').update(names[0]).digest('hex'));
	assert.match(linux.timestamp, /^\d{13}$/);
	assert.equal(JSON.parse(readFileSync(join(feed, 'stable/win32/x64/system/latest.json'), 'utf8')).sha256hash, 'abc', 'a .sha256 file from the build wins');
	for (const p of ['win32/x64/user', 'win32/x64/archive']) {
		assert.ok(existsSync(join(feed, 'stable', p, 'latest.json')), p);
	}
	assert.ok(!existsSync(join(feed, 'stable/darwin')), 'an unsigned Mac build cannot update itself: no feed');
	assert.ok(existsSync(join(run({ FEED_DARWIN: 'yes' }), 'stable/darwin/arm64/latest.json')));
});

test('feed: a missing installer stops the release', () => {
	assert.throws(() => run({ RELEASE_VERSION: '1.143.10000' }), /missing/);
});

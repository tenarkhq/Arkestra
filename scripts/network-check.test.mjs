// Arkestra network check (AR04) tests: node --test scripts/network-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify, staticCheck } from './network-check.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'network-check.mjs');

test('hosts are classified: Microsoft services, deliberate Microsoft-owned ones, others', () => {
	assert.equal(classify('mobile.events.data.microsoft.com:443'), 'microsoft');
	assert.equal(classify('main.vscode-cdn.net'), 'microsoft');
	assert.equal(classify('vscode.dev'), 'microsoft');
	assert.equal(classify('api.githubcopilot.com'), 'microsoft');
	assert.equal(classify('api.github.com:443'), 'deliberate');
	assert.equal(classify('registry.npmjs.org'), 'deliberate');
	assert.equal(classify('open-vsx.org'), 'other');
	assert.equal(classify('notmicrosoft.com'), 'other');
});

function tree(product, loopback = 'local("Segoe UI")', imported = true) {
	const dir = mkdtempSync(path.join(tmpdir(), 'netcheck-'));
	writeFileSync(path.join(dir, 'product.json'), JSON.stringify(product));
	mkdirSync(path.join(dir, 'src/vs/workbench/api/node'), { recursive: true });
	writeFileSync(path.join(dir, 'src/vs/workbench/api/node/loopbackServer.ts'), loopback);
	writeFileSync(path.join(dir, 'src/vs/workbench/workbench.common.main.ts'), imported ? "import './contrib/arkestra/browser/arkestraDefaults.contribution.js';" : '');
	return dir;
}

const good = {
	extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' },
	defaultChatAgent: { entitlementUrl: '', tokenEntitlementUrl: '', managedSettingsUrl: '', mcpRegistryDataUrl: '', documentationUrl: 'https://aka.ms/github-copilot-overview' },
	extensionAllowedBadgeProviders: ['img.shields.io'],
	updateUrl: 'https://raw.githubusercontent.com/tenarkhq/Arkestra/refs/heads/versions',
};

test('static: a fixed tree passes and lists the remaining links', () => {
	const { problems, notes } = staticCheck(tree(good));
	assert.deepEqual(problems, []);
	assert.deepEqual(notes, ['defaultChatAgent.documentationUrl: https://aka.ms/github-copilot-overview']);
});

test('static: every way of calling Microsoft by itself is reported', () => {
	const bad = {
		...good,
		updateUrl: 'https://update.code.visualstudio.com',
		voiceWsUrl: 'wss://falcon-caas.mai.microsoft.com/voice',
		extensionsGallery: { serviceUrl: 'https://marketplace.visualstudio.com/_apis/public/gallery' },
		defaultChatAgent: { ...good.defaultChatAgent, entitlementUrl: 'https://api.github.com/copilot_internal/user' },
		extensionAllowedBadgeProviders: ['marketplace.visualstudio.com'],
	};
	const { problems } = staticCheck(tree(bad, 'url("https://c.s-microsoft.com/x.woff")', false));
	assert.equal(problems.length, 7, problems.join('\n'));
});

test('capture: the proxy sees every host the app contacts and fails on Microsoft', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'netcheck-app-'));
	const app = path.join(dir, 'app.mjs');
	// A stand-in app: opens tunnels through the proxy it was given, like Electron and the extension host do.
	writeFileSync(app, `
import http from 'node:http';
const proxy = new URL(process.env.HTTPS_PROXY);
const tunnel = host => new Promise(r => http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: host }).on('connect', (_, s) => { s.destroy(); r(); }).on('error', r).end());
await tunnel('open-vsx.org:443');
await tunnel('mobile.events.data.microsoft.com:443');
await tunnel('api.github.com:443');
`);
	const out = spawnSync(process.execPath, [SCRIPT, 'capture', '--seconds', '20', '--no-forward', '--', process.execPath, app], { encoding: 'utf8' });
	assert.equal(out.status, 1, out.stdout + out.stderr);
	assert.match(out.stdout, /microsoft\s+mobile\.events\.data\.microsoft\.com/);
	assert.match(out.stdout, /deliberate\s+api\.github\.com/);
	assert.match(out.stdout, /other\s+open-vsx\.org/);
	assert.match(out.stdout, /FAIL 1 Microsoft host/);
});

#!/usr/bin/env node
// Arkestra network check (AR04): nothing goes to Microsoft services on its own.
//
//   node scripts/network-check.mjs static [work/vscode]
//     Checks a prepared source tree: the product.json keys that would make the app
//     call Microsoft services by itself, and the source spots after-prepare.sh fixes.
//
//   node scripts/network-check.mjs capture [--seconds 120] -- <app> [args...]
//     Runs the built app (first milestone build) with a fresh profile behind a logging
//     proxy and lists every host it contacted. Exits 1 if any is a Microsoft service.
//     DNS lookups that bypass the proxy are not seen; run it on a clean network namespace
//     or with a firewall log for that.

import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Microsoft services: the host itself or any subdomain. */
export const MICROSOFT_DOMAINS = [
	'microsoft.com', 'microsoftonline.com', 'live.com', 'msauth.net', 'msftauth.net', 'office.com', 'office.net',
	'azure.com', 'azure.net', 'azureedge.net', 'azurefd.net', 'windows.net', 'trafficmanager.net', 'msedge.net', 'msecnd.net',
	'visualstudio.com', 'vsassets.io', 'vscode-cdn.net', 'vscode.dev', 'vscodeexperiments.azureedge.net', 'exp-tas.com',
	's-microsoft.com', 'aka.ms', 'bing.com', 'windowsupdate.com', 'githubcopilot.com',
	'copilot-telemetry.githubusercontent.com', 'copilot-proxy.githubusercontent.com', 'origin-tracker.githubusercontent.com',
];

/** Microsoft-owned, but used on purpose: GitHub (Arkestra's GitHub integration), npm (type acquisition, package hovers). */
export const DELIBERATE_DOMAINS = ['github.com', 'api.github.com', 'githubusercontent.com', 'npmjs.org', 'npmjs.com'];

export function domainOf(host) {
	return host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function matches(host, domains) {
	const h = domainOf(host);
	return domains.some(d => h === d || h.endsWith('.' + d));
}

/** 'microsoft' (a failure), 'deliberate' (Microsoft-owned, used on purpose) or 'other'. */
export function classify(host) {
	if (matches(host, MICROSOFT_DOMAINS)) {
		return 'microsoft';
	}
	return matches(host, DELIBERATE_DOMAINS) ? 'deliberate' : 'other';
}

// ---- static ----------------------------------------------------------------------------

/** product.json keys whose presence makes the app call Microsoft by itself. */
const PRODUCT_MUST_BE_EMPTY = [
	'updateUrl', 'voiceWsUrl', 'tunnelApplicationName', 'tunnelApplicationConfig', 'aiConfig', 'appCenter', 'crashReporter',
	'tasConfig', 'surveys', 'configurationSync.store', 'editSessions.store', 'sendASmile', 'npsSurveyUrl', 'releaseNotesUrl',
	'defaultChatAgent.entitlementUrl', 'defaultChatAgent.tokenEntitlementUrl', 'defaultChatAgent.managedSettingsUrl', 'defaultChatAgent.mcpRegistryDataUrl',
];

/** Source files that must not carry these after after-prepare.sh. */
const SOURCE_MUST_NOT_CONTAIN = [
	['src/vs/workbench/api/node/loopbackServer.ts', 's-microsoft.com'],
];

function get(obj, dotted) {
	if (dotted in obj) {
		return obj[dotted];
	}
	return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function staticCheck(tree) {
	const problems = [];
	const notes = [];
	const product = JSON.parse(readFileSync(path.join(tree, 'product.json'), 'utf8'));
	for (const key of PRODUCT_MUST_BE_EMPTY) {
		const value = get(product, key);
		if (value !== undefined && value !== '' && value !== null) {
			problems.push(`product.json ${key} is set: ${JSON.stringify(value).slice(0, 100)}`);
		}
	}
	const gallery = product.extensionsGallery?.serviceUrl ?? '';
	if (!gallery || classify(new URL(gallery).host) === 'microsoft') {
		problems.push(`extension gallery is not Open VSX: ${gallery || '(none)'}`);
	}
	for (const badge of product.extensionAllowedBadgeProviders ?? []) {
		if (classify(badge) === 'microsoft') {
			problems.push(`badge images allowed from a Microsoft host: ${badge}`);
		}
	}
	// Remaining Microsoft URLs in product.json are links a person opens or opt-in features; list them.
	const walk = (value, at) => {
		if (typeof value === 'string' && /^(https?|wss?):\/\//.test(value)) {
			try {
				if (classify(new URL(value.replace(/\{\{?[^}]+\}?\}/g, 'x')).host) === 'microsoft') {
					notes.push(`${at}: ${value}`);
				}
			} catch { /* not a URL */ }
		} else if (value && typeof value === 'object') {
			for (const [k, v] of Object.entries(value)) {
				walk(v, at ? `${at}.${k}` : k);
			}
		}
	};
	walk(product, '');
	for (const [file, needle] of SOURCE_MUST_NOT_CONTAIN) {
		const full = path.join(tree, file);
		if (existsSync(full) && readFileSync(full, 'utf8').includes(needle)) {
			problems.push(`${file} still contains ${needle}`);
		}
	}
	const main = path.join(tree, 'src/vs/workbench/workbench.common.main.ts');
	if (existsSync(main) && !readFileSync(main, 'utf8').includes('arkestraDefaults.contribution.js')) {
		problems.push('the Arkestra defaults overlay is not imported (telemetry, recommendations and sign-in defaults missing)');
	}
	return { problems, notes };
}

// ---- capture ---------------------------------------------------------------------------

/**
 * A logging HTTP proxy: records the host of every CONNECT and plain request. With
 * forward=false it answers 502 instead of connecting (tests, offline runs).
 */
export function startProxy({ forward = true } = {}) {
	const hosts = new Map();
	const seen = host => hosts.set(domainOf(host), (hosts.get(domainOf(host)) ?? 0) + 1);
	const server = createServer((req, res) => {
		let target;
		try {
			target = new URL(req.url);
		} catch {
			res.writeHead(400).end();
			return;
		}
		seen(target.host);
		if (!forward) {
			res.writeHead(502).end();
			return;
		}
		const upstream = httpRequest(target, { method: req.method, headers: req.headers }, up => {
			res.writeHead(up.statusCode ?? 502, up.headers);
			up.pipe(res);
		});
		upstream.on('error', () => res.destroy());
		req.pipe(upstream);
	});
	server.on('connect', (req, socket, head) => {
		seen(req.url ?? '');
		if (!forward) {
			socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
			return;
		}
		const [host, port] = (req.url ?? '').split(':');
		const upstream = connect(Number(port) || 443, host, () => {
			socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on('error', () => socket.destroy());
		socket.on('error', () => upstream.destroy());
	});
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
		url: `http://127.0.0.1:${server.address().port}`,
		hosts,
		close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
	})));
}

export function report(hosts) {
	const rows = [...hosts.entries()].map(([host, count]) => ({ host, count, kind: classify(host) })).sort((a, b) => a.host.localeCompare(b.host));
	return { rows, microsoft: rows.filter(r => r.kind === 'microsoft') };
}

async function capture(seconds, app, args, forward) {
	const proxy = await startProxy({ forward });
	const profile = mkdtempSync(path.join(tmpdir(), 'arkestra-netcheck-'));
	const child = spawn(app, [
		...args,
		`--user-data-dir=${path.join(profile, 'user')}`,
		`--extensions-dir=${path.join(profile, 'extensions')}`,
		`--proxy-server=${proxy.url}`,
		'--proxy-bypass-list=<-loopback>',
	], {
		stdio: 'inherit',
		env: { ...process.env, HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url, NO_PROXY: '' },
	});
	await new Promise(resolve => {
		const timer = setTimeout(() => { child.kill('SIGTERM'); }, seconds * 1000);
		child.on('exit', () => { clearTimeout(timer); resolve(); });
	});
	await proxy.close();
	return report(proxy.hosts);
}

async function main(argv) {
	const [mode, ...rest] = argv;
	if (mode === 'static') {
		const tree = rest[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'work', 'vscode');
		const { problems, notes } = staticCheck(tree);
		for (const note of notes) {
			console.log(`not called by itself (a link, an opt-in feature or web-only): ${note}`);
		}
		for (const problem of problems) {
			console.log(`FAIL ${problem}`);
		}
		console.log(problems.length ? `${problems.length} problem(s)` : 'static check passed');
		return problems.length ? 1 : 0;
	}
	if (mode === 'capture') {
		const dash = rest.indexOf('--');
		const opts = dash >= 0 ? rest.slice(0, dash) : rest;
		const command = dash >= 0 ? rest.slice(dash + 1) : [];
		if (!command.length) {
			console.error('usage: network-check.mjs capture [--seconds N] [--no-forward] -- <app> [args...]');
			return 2;
		}
		const seconds = Number(opts[opts.indexOf('--seconds') + 1]) || 120;
		const { rows, microsoft } = await capture(seconds, command[0], command.slice(1), !opts.includes('--no-forward'));
		for (const r of rows) {
			console.log(`${r.kind.padEnd(10)} ${r.host} (${r.count})`);
		}
		console.log(microsoft.length ? `FAIL ${microsoft.length} Microsoft host(s)` : 'capture passed: no Microsoft host');
		return microsoft.length ? 1 : 0;
	}
	console.error('usage: network-check.mjs static [tree] | capture [--seconds N] -- <app> [args...]');
	return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

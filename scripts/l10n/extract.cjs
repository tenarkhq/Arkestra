#!/usr/bin/env node
// Arkestra l10n (AR09): the English source strings of a prepared VS Code tree.
//
//   node scripts/l10n/extract.cjs <work/vscode> <out.json>
//
// Output: { core: { <module>: { <key>: <message> } },
//           extensions: { <publisher.name>: { package: {...}, bundle: { <message>: <message> } } } }
// Core strings are the nls localize/localize2 calls of src/vs; an extension's strings are its
// package.nls.json and its vscode.l10n.t calls (the bundle key is the message itself).
// Needs TypeScript: the tree's own node_modules, or TSLIB=<path to typescript>.
'use strict';
const fs = require('fs');
const path = require('path');

const [tree, out] = process.argv.slice(2);
if (!tree || !out) {
	console.error('usage: extract.cjs <work/vscode> <out.json>');
	process.exit(2);
}
const ts = require(process.env.TSLIB || require.resolve('typescript', { paths: [tree] }));

function literal(n) {
	if (!n) { return undefined; }
	if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { return n.text; }
	if (ts.isParenthesizedExpression(n)) { return literal(n.expression); }
	if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const a = literal(n.left), b = literal(n.right);
		return a !== undefined && b !== undefined ? a + b : undefined;
	}
	return undefined;
}

function property(obj, name) {
	for (const p of obj.properties) {
		if (ts.isPropertyAssignment(p) && p.name && p.name.text === name) { return p.initializer; }
	}
	return undefined;
}

function sourceFiles(dir, skip) {
	const files = [];
	const walk = d => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) {
				if (!skip.has(e.name)) { walk(p); }
			} else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$|\.test\.tsx?$/.test(e.name)) {
				files.push(p);
			}
		}
	};
	if (fs.existsSync(dir)) { walk(dir); }
	return files;
}

function calls(file, pattern, visit) {
	const text = fs.readFileSync(file, 'utf8');
	if (!pattern.test(text)) { return; }
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const walk = n => {
		if (ts.isCallExpression(n)) { visit(n, n.expression.getText(sf)); }
		ts.forEachChild(n, walk);
	};
	walk(sf);
}

const SKIP = new Set(['test', 'node_modules', 'out', 'fixtures']);

// ---- core ----
const core = {};
const src = path.join(tree, 'src');
for (const file of sourceFiles(path.join(src, 'vs'), SKIP)) {
	const module = path.relative(src, file).split(path.sep).join('/').replace(/\.tsx?$/, '');
	calls(file, /\blocalize2?\s*\(/, (n, callee) => {
		if (!/(^|\.)localize2?$/.test(callee) || n.arguments.length < 2) { return; }
		const first = n.arguments[0];
		const key = literal(first) ?? (ts.isObjectLiteralExpression(first) ? literal(property(first, 'key')) : undefined);
		const message = literal(n.arguments[1]);
		if (key !== undefined && message !== undefined) { (core[module] ??= {})[key] = message; }
	});
}

// ---- extensions ----
const extensions = {};
const extRoot = path.join(tree, 'extensions');
for (const name of fs.readdirSync(extRoot).sort()) {
	const dir = path.join(extRoot, name);
	const manifestPath = path.join(dir, 'package.json');
	if (!fs.existsSync(manifestPath)) { continue; }
	let manifest;
	try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
	if (!manifest.publisher || !manifest.name || manifest.contributes?.localizations) { continue; }
	const nlsPath = path.join(dir, 'package.nls.json');
	const pkg = {};
	if (fs.existsSync(nlsPath)) {
		for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(nlsPath, 'utf8')))) {
			const message = typeof v === 'string' ? v : v && typeof v.message === 'string' ? v.message : undefined;
			if (message !== undefined) { pkg[k] = message; }
		}
	}
	const bundle = {};
	for (const file of sourceFiles(path.join(dir, 'src'), SKIP)) {
		calls(file, /\bl10n\.t\s*\(/, (n, callee) => {
			if (!/(^|\.)l10n\.t$/.test(callee) || !n.arguments.length) { return; }
			const first = n.arguments[0];
			let message = literal(first);
			if (message === undefined && ts.isObjectLiteralExpression(first) && !property(first, 'comment')) {
				message = literal(property(first, 'message'));
			}
			if (message !== undefined) { bundle[message] = message; }
		});
	}
	if (Object.keys(pkg).length || Object.keys(bundle).length) {
		extensions[`${manifest.publisher}.${manifest.name}`] = { package: pkg, bundle };
	}
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ core, extensions }, null, '\t') + '\n');
const count = o => Object.values(o).reduce((n, v) => n + Object.keys(v).length, 0);
console.log(`core: ${count(core)} strings in ${Object.keys(core).length} modules; extensions: ${Object.keys(extensions).length}, ${Object.values(extensions).reduce((n, e) => n + Object.keys(e.package).length + Object.keys(e.bundle).length, 0)} strings`);

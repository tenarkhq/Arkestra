#!/usr/bin/env node
// Arkestra l10n (AR09): builds the built-in language pack from the translation catalogue.
//
//   node scripts/l10n/pack.mjs <en.json> [--lang hu] [--check]
//
// <en.json> comes from extract.cjs on the prepared tree. The catalogue is l10n/<lang>/core.json
// ({ module: { key: text } }) and l10n/<lang>/extensions.json ({ id: { package, bundle } }).
// Only keys the current source still has are written, and a translation whose placeholders
// ({0}, {name}) differ from the English is left out, so the English shows instead. Untranslated
// strings fall back to English at run time. --check exits 1 when anything was left out.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const enPath = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--lang');
const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'hu';
if (!enPath) {
	console.error('usage: pack.mjs <en.json> [--lang hu] [--check]');
	process.exit(2);
}

export const placeholders = text => [...text.matchAll(/\{(\d+|[A-Za-z_]\w*)\}/g)].map(m => m[0]).sort().join(' ');

const read = p => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
const en = JSON.parse(readFileSync(enPath, 'utf8'));
const catalogue = { core: read(path.join(repo, 'l10n', lang, 'core.json')), extensions: read(path.join(repo, 'l10n', lang, 'extensions.json')) };
const dropped = [];

function pick(source, translated, where) {
	const out = {};
	let done = 0;
	for (const [key, english] of Object.entries(source)) {
		const text = translated?.[key];
		if (typeof text !== 'string' || !text.trim()) {
			continue;
		}
		if (placeholders(text) !== placeholders(english)) {
			dropped.push(`${where} ${JSON.stringify(key)}: placeholders ${placeholders(english) || '(none)'} → ${placeholders(text) || '(none)'}`);
			continue;
		}
		out[key] = text;
		done++;
	}
	return { out, done, total: Object.keys(source).length };
}

const packDir = path.join(repo, 'extensions', `arkestra-language-pack-${lang}`);
const transDir = path.join(packDir, 'translations');
rmSync(transDir, { recursive: true, force: true });
mkdirSync(path.join(transDir, 'extensions'), { recursive: true });

let coreDone = 0, coreTotal = 0;
const contents = {};
for (const [module, keys] of Object.entries(en.core)) {
	const r = pick(keys, catalogue.core[module], module);
	coreDone += r.done;
	coreTotal += r.total;
	if (r.done) {
		contents[module] = r.out;
	}
}
writeFileSync(path.join(transDir, 'main.i18n.json'), JSON.stringify({ version: '1.0.0', contents }, null, '\t') + '\n');

const translations = [{ id: 'vscode', path: './translations/main.i18n.json' }];
const rows = [];
for (const [id, source] of Object.entries(en.extensions)) {
	const t = catalogue.extensions[id] ?? {};
	const p = pick(source.package, t.package, `${id} package`);
	const b = pick(source.bundle, t.bundle, `${id} bundle`);
	rows.push({ id, done: p.done + b.done, total: p.total + b.total });
	if (p.done + b.done) {
		const file = `./translations/extensions/${id}.i18n.json`;
		writeFileSync(path.join(packDir, file), JSON.stringify({ version: '1.0.0', contents: { package: p.out, bundle: b.out } }, null, '\t') + '\n');
		translations.push({ id, path: file });
	}
}

const manifestPath = path.join(packDir, 'package.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {
	name: `arkestra-language-pack-${lang}`,
	displayName: `Arkestra language pack (${lang})`,
	version: '0.1.0',
	publisher: 'vscode',
	license: 'MIT',
	engines: { vscode: '^1.100.0' },
	categories: ['Language Packs'],
	contributes: { localizations: [{ languageId: lang, languageName: lang, localizedLanguageName: lang, translations: [] }] },
};
manifest.contributes.localizations[0].translations = translations;
writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');

const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
console.log(`core ${coreDone}/${coreTotal} (${pct(coreDone, coreTotal)})`);
const extDone = rows.reduce((n, r) => n + r.done, 0), extTotal = rows.reduce((n, r) => n + r.total, 0);
console.log(`extensions ${extDone}/${extTotal} (${pct(extDone, extTotal)})`);
for (const r of rows.filter(r => r.id.includes('arkestra') && r.done < r.total)) {
	console.log(`  missing: ${r.id} ${r.done}/${r.total}`);
}
for (const d of dropped.slice(0, 20)) {
	console.log(`left out: ${d}`);
}
if (dropped.length > 20) {
	console.log(`left out: … ${dropped.length - 20} more`);
}
if (args.includes('--check') && (dropped.length || rows.some(r => r.id.includes('arkestra') && r.done < r.total))) {
	process.exitCode = 1;
}

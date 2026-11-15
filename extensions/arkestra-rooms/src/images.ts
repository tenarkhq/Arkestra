/*---------------------------------------------------------------------------------------------
 *  Arkestra. Images in a thread: markdown images, image files named in the text (@file:, a
 *  path), what may be loaded (data: images, https, files under the allowed folders only), and
 *  the files pasted into the composer. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** File names the thread shows as images. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i;
/** `![alt](src)`, `![alt](<src with spaces>)`, an optional "title". */
const MD_IMAGE = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g;
const FILE_REF = /(^|[\s([{])@file:(?:"([^"\n]+)"|([^\s)\]}]+))/g;
const EXT = '(?:png|jpe?g|gif|webp|bmp|svg|avif)';
/** A path in running text: absolute (POSIX or Windows), from the home folder, or a file:// URL. */
const BARE_PATH = new RegExp(`(^|[\\s(\`'"\\[])((?:file:\\/\\/\\/?|~\\/|\\/|[A-Za-z]:[\\\\/])[^\\s\`'"()<>\\[\\]]*\\.${EXT})(?=$|[\\s)\`'".,;:!?\\]])`, 'gim');
const FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*|(?![\s\S]))/gm;

/** Turns an image's source into the address the page loads; undefined: it may not be shown. */
export type ImageResolver = (src: string) => string | undefined;

export type ImageSource =
	| { readonly kind: 'data' | 'web'; readonly url: string }
	| { readonly kind: 'file'; readonly path: string };

/**
 * What an image source is: a data: image, an https image, or a local image file (a relative
 * path against `base`, `~/` against `home`). Undefined: nothing the page may load.
 */
export function imageSource(src: string, opts: { readonly home?: string; readonly base?: string } = {}): ImageSource | undefined {
	const s = src.trim().replace(/^<(.*)>$/, '$1');
	if (!s) {
		return undefined;
	}
	if (/^data:/i.test(s)) {
		return DATA_IMAGE.test(s) ? { kind: 'data', url: s } : undefined;
	}
	if (/^https:\/\//i.test(s)) {
		return /^https:\/\/[^\s"'<>\\]+$/i.test(s) ? { kind: 'web', url: s } : undefined;
	}
	let file: string | undefined;
	if (/^file:/i.test(s)) {
		try {
			file = fileURLToPath(s);
		} catch {
			return undefined;
		}
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|vbscript|blob):/i.test(s)) {
		return undefined;
	} else if (s.startsWith('~/') || s.startsWith('~\\')) {
		file = opts.home ? path.join(opts.home, s.slice(2)) : undefined;
	} else if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) {
		file = s;
	} else {
		file = opts.base ? path.resolve(opts.base, s) : undefined;
	}
	if (!file) {
		return undefined;
	}
	file = path.normalize(file);
	return IMAGE_FILE.test(file) ? { kind: 'file', path: file } : undefined;
}

/** Whether `file` is `root` itself or inside it (no `..` way out). */
export function isInside(root: string, file: string, caseless = process.platform === 'win32' || process.platform === 'darwin'): boolean {
	const fold = (p: string) => caseless ? p.toLowerCase() : p;
	const rel = path.relative(fold(path.resolve(root)), fold(path.resolve(file)));
	return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** An image file the page may load: an image by its name, and under one of the allowed folders. */
export function allowedImage(file: string, roots: readonly string[]): boolean {
	return IMAGE_FILE.test(file) && roots.some(root => !!root && isInside(root, file));
}

/** The markdown images of a text, in order. */
export function markdownImages(text: string): { alt: string; src: string }[] {
	return [...text.matchAll(MD_IMAGE)].map(m => ({ alt: m[1], src: m[2] ?? m[3] }));
}

/** Image files named outside markdown images: @file: references and paths; code blocks left out; each once. */
export function imageRefs(text: string, limit = 8): string[] {
	const t = text.replace(FENCE, ' ').replace(MD_IMAGE, ' ');
	const out: string[] = [];
	const add = (p: string) => {
		const clean = p.replace(/#L\d+(?:-L?\d+)?$/, '');
		if (IMAGE_FILE.test(clean) && !out.includes(clean) && out.length < limit) {
			out.push(clean);
		}
	};
	for (const m of t.matchAll(FILE_REF)) {
		add(m[2] ?? m[3]);
	}
	for (const m of t.replace(FILE_REF, ' ').matchAll(BARE_PATH)) {
		add(m[2]);
	}
	return out;
}

/**
 * A user's message for the bubble: its markdown images and @file: image references come out
 * of the text and show as pictures; paths in the words stay and show as pictures too.
 */
export function userImages(text: string): { text: string; images: string[] } {
	const images: string[] = [];
	const add = (src: string) => { if (!images.includes(src)) { images.push(src); } };
	let rest = text.replace(MD_IMAGE, (_all, _alt, a: string | undefined, b: string | undefined) => { add(a ?? b ?? ''); return ''; });
	rest = rest.replace(/(?<=^|[\s([{])@file:(?:"([^"\n]+)"|([^\s)\]}]+))[ \t]*/gm, (all, q: string | undefined, plain: string | undefined) => {
		const p = (q ?? plain ?? '').replace(/#L\d+(?:-L?\d+)?$/, '');
		if (!IMAGE_FILE.test(p)) {
			return all;
		}
		add(p);
		return '';
	});
	for (const p of imageRefs(rest)) {
		add(p);
	}
	return { text: rest.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(), images: images.filter(Boolean) };
}

/** A short name for an image that cannot be shown. */
export function imageName(src: string): string {
	if (/^data:/i.test(src)) {
		return 'image';
	}
	const clean = src.replace(/^<(.*)>$/, '$1').replace(/[?#].*$/, '');
	return clean.split(/[\\/]/).filter(Boolean).pop() || 'image';
}

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

/**
 * The name a file pasted or dropped into the composer is kept under in the room's folder: its
 * own name cleaned (no folders, no odd characters), a pasted picture named by the time, and a
 * suffix so nothing already there is overwritten.
 */
export function attachmentName(name: string, mime: string, taken: (candidate: string) => boolean, now = new Date()): string {
	// eslint-disable-next-line no-control-regex
	let base = (name.split(/[\\/]/).pop() ?? '').normalize('NFC').replace(/[\u0000-\u001f<>:"|?*]+/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
	let ext = path.extname(base).slice(1).toLowerCase();
	if (!base || base === `.${ext}`) {
		const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
		ext = TYPES[mime.toLowerCase()] ?? (ext || 'bin');
		base = `kep-${stamp}.${ext}`;
	} else if (!ext && TYPES[mime.toLowerCase()]) {
		ext = TYPES[mime.toLowerCase()];
		base = `${base}.${ext}`;
	}
	if (base.length > 120) {
		const e = path.extname(base);
		base = base.slice(0, 120 - e.length) + e;
	}
	if (!taken(base)) {
		return base;
	}
	const e = path.extname(base);
	const stem = base.slice(0, base.length - e.length);
	for (let i = 2; ; i++) {
		const candidate = `${stem}-${i}${e}`;
		if (!taken(candidate)) {
			return candidate;
		}
	}
}

/** The reference a kept file goes to the agents with (references.ts expands it). */
/** The files a text names with `@file:` by an absolute path (POSIX or Windows), each once. */
export function absoluteReferences(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(FILE_REF)) {
		const file = (m[2] ?? m[3]).replace(/#L\d+(?:-L?\d+)?$/, '');
		if ((path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) && !out.includes(file)) {
			out.push(file);
		}
	}
	return out;
}

/** The text with the `@file:` references of moved files pointing at their new place (`moved`: old path → new). */
export function movedReferences(text: string, moved: ReadonlyMap<string, string>): string {
	return text.replace(FILE_REF, (all, lead: string, quoted: string | undefined, bare: string | undefined) => {
		const ref = quoted ?? bare ?? '';
		const lines = /#L\d+(?:-L?\d+)?$/.exec(ref)?.[0] ?? '';
		const target = moved.get(ref.slice(0, ref.length - lines.length));
		return target ? `${lead}${fileReference(target + lines)}` : all;
	});
}

export function fileReference(file: string): string {
	return `@file:${/[\s"]/.test(file) ? `"${file.replace(/"/g, '')}"` : file}`;
}

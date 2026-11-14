/*---------------------------------------------------------------------------------------------
 *  Arkestra. Pictures in a CLI session (a pasted screenshot): kept once on this machine, named
 *  by their content, and put into the entry's text as a markdown image, so the thread shows
 *  them and no new field is needed. The same file in arkestra-claude and arkestra-codex.
 *  No VS Code.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** A picture as a session holds it: base64 bytes, a file on the agent's machine, or a web address. */
export type SessionImage =
	| { readonly data: string; readonly mime: string }
	| { readonly path: string }
	| { readonly url: string };

/** Keeps a picture on this machine; its file, or undefined when it cannot be kept. */
export type ImageStore = (image: SessionImage) => string | undefined;

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };
const PICTURE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_BYTES = 25 * 1024 * 1024;

/** A data: URL's picture, if it is one of the known kinds. */
export function dataUrlImage(url: string): { data: string; mime: string } | undefined {
	const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url.trim());
	const mime = m?.[1].toLowerCase();
	return m && mime && TYPES[mime] ? { mime, data: m[2].replace(/\s+/g, '') } : undefined;
}

/** A picture's file as a markdown image (angle brackets when the path has spaces). */
export function imageMarkdown(file: string): string {
	return `![image](${/[\s()<>]/.test(file) ? `<${file.replace(/[<>]/g, '')}>` : file})`;
}

/** A store in a folder: each picture once, its name the hash of its bytes. */
export function folderStore(dir: string): ImageStore {
	return image => {
		if ('url' in image) {
			return undefined;
		}
		try {
			let bytes: Buffer;
			let ext: string | undefined;
			if ('path' in image) {
				if (!PICTURE.test(image.path)) {
					return undefined;
				}
				const stat = statSync(image.path);
				if (!stat.isFile() || stat.size > MAX_BYTES) {
					return undefined;
				}
				bytes = readFileSync(image.path);
				ext = path.extname(image.path).slice(1).toLowerCase().replace('jpeg', 'jpg');
			} else {
				ext = TYPES[image.mime.toLowerCase()];
				bytes = Buffer.from(image.data, 'base64');
			}
			if (!ext || !bytes.length || bytes.length > MAX_BYTES) {
				return undefined;
			}
			const file = path.join(dir, `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`);
			if (!existsSync(file)) {
				mkdirSync(dir, { recursive: true });
				const temp = `${file}.${process.pid}.tmp`;
				writeFileSync(temp, bytes);
				renameSync(temp, file);
			}
			return file;
		} catch {
			return undefined;
		}
	};
}

/**
 * An entry's text with its pictures under it as markdown images. A picture that cannot be kept
 * here: a file keeps its own path, a web address stays, bytes become a short note.
 */
export function withImages(text: string, images: readonly SessionImage[], store: ImageStore): string {
	if (!images.length) {
		return text;
	}
	const refs = images.map(image => {
		const file = store(image);
		if (file) {
			return imageMarkdown(file);
		}
		if ('url' in image) {
			return /^https:\/\/\S+$/i.test(image.url) ? imageMarkdown(image.url) : '';
		}
		return 'path' in image ? imageMarkdown(image.path) : '[kép]';
	}).filter(Boolean);
	return [text.trim(), refs.join('\n')].filter(Boolean).join('\n\n');
}

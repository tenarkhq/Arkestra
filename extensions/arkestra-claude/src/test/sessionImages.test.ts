/*---------------------------------------------------------------------------------------------
 *  Arkestra. Pictures in a Claude Code session: kept once on this machine by their content and
 *  shown in the thread as markdown images; tool results and odd data never.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { claudeImages, claudePiece, parseHistory, setImageStore } from '../sessions';
import { dataUrlImage, folderStore, imageMarkdown, withImages } from '../sessionImages';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const line = (content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-15T08:00:00Z', message: { role: 'user', content }, ...extra });

test('a pasted picture is kept once, named by its bytes, and shows under the words', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'ark-img-'));
	setImageStore(folderStore(dir));
	const piece = claudePiece(line([{ type: 'text', text: 'Mi ez? [Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]));
	assert.equal(piece?.kind, 'user');
	const files = readdirSync(dir);
	assert.equal(files.length, 1);
	assert.match(files[0], /^[0-9a-f]{32}\.png$/);
	assert.deepEqual(readFileSync(path.join(dir, files[0])), Buffer.from(PNG, 'base64'));
	assert.equal(piece?.text, `Mi ez?\n\n![image](${path.join(dir, files[0])})`);
	// The same picture again: the same file, nothing new.
	claudePiece(line([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]));
	assert.equal(readdirSync(dir).length, 1);
	// A picture alone is a message too; the history keeps it.
	const history = parseHistory([line([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]), JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Egy kép.' }] } })].join('\n'));
	assert.deepEqual(history.map(e => [e.role, e.text]), [['user', imageMarkdown(path.join(dir, files[0]))], ['agent', 'Egy kép.']]);
});

test('tool results, command echoes and unknown kinds bring no pictures', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'ark-img-'));
	setImageStore(folderStore(dir));
	assert.equal(claudePiece(line([{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }])), undefined);
	assert.equal(claudePiece(line([{ type: 'text', text: '<command-name>/x</command-name>' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }])), undefined);
	assert.deepEqual(claudeImages([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'image', source: { type: 'url', url: 'https://e.com/a.png' } }, { type: 'image', source: { type: 'file', file_id: 'f' } }, 'x']), [{ data: PNG, mime: 'image/png' }, { url: 'https://e.com/a.png' }]);
	assert.equal(folderStore(dir)({ data: PNG, mime: 'image/svg+xml' }), undefined, 'only raster kinds');
	assert.equal(folderStore(dir)({ path: '/etc/passwd' }), undefined, 'only picture files');
	assert.equal(readdirSync(dir).length, 0);
});

test('markdown for a picture: spaces in brackets; what cannot be kept stays as it is or a note', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'ark-img-'));
	assert.equal(imageMarkdown('/a b/c.png'), '![image](</a b/c.png>)');
	assert.equal(imageMarkdown('/a/c.png'), '![image](/a/c.png)');
	const none = () => undefined;
	assert.equal(withImages('nézd', [{ path: '/remote/x.png' }, { url: 'https://e.com/a.png' }, { url: 'javascript:x' }, { data: 'zz', mime: 'image/png' }], none), 'nézd\n\n![image](/remote/x.png)\n![image](https://e.com/a.png)\n[kép]');
	assert.equal(withImages('csak szöveg', [], none), 'csak szöveg');
	const src = path.join(dir, 'shot.PNG');
	await writeFile(src, Buffer.from(PNG, 'base64'));
	const kept = folderStore(path.join(dir, 'store'))({ path: src });
	assert.ok(kept && existsSync(kept) && kept.endsWith('.png'));
	assert.deepEqual(dataUrlImage(`data:image/jpeg;base64,${PNG}`), { mime: 'image/jpeg', data: PNG });
	assert.equal(dataUrlImage('data:text/html;base64,PGI+'), undefined);
});

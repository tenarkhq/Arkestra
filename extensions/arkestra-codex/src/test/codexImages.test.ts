/*---------------------------------------------------------------------------------------------
 *  Arkestra. Pictures in a Codex session: rollout items and events, the app server's history;
 *  kept once on this machine and shown in the thread as markdown images.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { codexHistory } from '../codexAgent';
import { codexImages, codexPiece, setImageStore } from '../codexFollow';
import { folderStore } from '../sessionImages';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const DATA = `data:image/png;base64,${PNG}`;
const event = (payload: object) => JSON.stringify({ timestamp: '2026-11-15T08:00:00Z', type: 'event_msg', payload });

test('rollout pictures: finished user items and older user_message events', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'ark-cimg-'));
	setImageStore(folderStore(dir));
	const local = path.join(dir, 'paste.png');
	await writeFile(local, Buffer.from(PNG, 'base64'));
	const item = codexPiece(event({ type: 'item_completed', item: { type: 'UserMessage', id: 'i1', content: [{ type: 'text', text: 'Mi ez?' }, { type: 'image', image_url: DATA }, { type: 'local_image', path: local }] } }));
	const files = readdirSync(dir).filter(f => f !== 'paste.png');
	assert.equal(files.length, 1, 'the same bytes are one file');
	const kept = path.join(dir, files[0]);
	assert.deepEqual(item, { kind: 'user', text: `Mi ez?\n\n![image](${kept})\n![image](${kept})`, id: 'i1', at: '2026-11-15T08:00:00Z' });
	const older = codexPiece(event({ type: 'user_message', message: '', images: [DATA] }));
	assert.deepEqual(older, { kind: 'user', text: `![image](${kept})`, at: '2026-11-15T08:00:00Z' });
	assert.equal(codexPiece(event({ type: 'user_message', message: '  ' })), undefined);
	assert.deepEqual(codexPiece(event({ type: 'agent_message', message: 'Kész.' })), { kind: 'agent', text: 'Kész.', at: '2026-11-15T08:00:00Z' });
});

test('the app server\'s history keeps the pictures too; odd items bring none', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'ark-cimg-'));
	setImageStore(folderStore(dir));
	const entries = codexHistory({ turns: [{ items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'image', url: DATA }] }, { type: 'agentMessage', id: 'a1', text: 'Egy kép.' }] }] });
	assert.equal(entries.length, 2);
	assert.match(entries[0].text, /^!\[image\]\(.+\.png\)$/);
	assert.deepEqual(codexImages([{ type: 'image', url: 'https://e.com/a.png' }, { type: 'localImage', path: '/remote/x.png' }, { type: 'image', url: 'data:text/html;base64,PGI+' }, { type: 'text', text: 'x' }]), [{ url: 'https://e.com/a.png' }, { path: '/remote/x.png' }]);
});

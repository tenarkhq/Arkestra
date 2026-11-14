/*---------------------------------------------------------------------------------------------
 *  Arkestra. The board page's script against a minimal fake DOM: board, drag to a column,
 *  start a room, table edit and sort, new issue form, empty screen.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { boardHtml } from '../boardHtml';
import { boardModel } from '../board';
import { planModel } from '../plan';

test('the board page draws and posts what the user does', async () => {
const html = boardHtml('n', 'c');
const g: any = globalThis;
const realTimeout = g.setTimeout;

const script = html.split('<script nonce="n">')[1].split('</script>')[0];

class Node_ { children: any[] = []; constructor() { } append(...k: any[]) { this.children.push(...k); } replaceChildren(...k: any[]) { this.children = k; } }
class Text_ extends Node_ { constructor(public text: string) { super(); } }
class El extends Node_ {
	attrs: any = {}; listeners: any = {}; style: any = {}; classList = { add() { }, remove() { } }; value: any = ''; constructor(public tag: string) { super(); }
	setAttribute(k: string, v: any) { this.attrs[k] = v; if (k === 'value') this.value = v; }
	addEventListener(k: string, f: any) { (this.listeners[k] ??= []).push(f); }
	querySelector() { return null; }
	focus() { }
	fire(k: string, e: any = {}) { for (const f of this.listeners[k] ?? []) f({ preventDefault() { }, stopPropagation() { }, ...e }); }
}
const posted: any[] = [];
const listeners: any = {};
const body = new El('body');
g.Node = Node_;
g.document = { createElement: (t: string) => new El(t), createTextNode: (t: string) => new Text_(t), body };
g.window = { addEventListener: (k: string, f: any) => { listeners[k] = f; } };
let state: any;
g.acquireVsCodeApi = () => ({ getState: () => state, setState: (s: any) => { state = s; }, postMessage: (m: any) => posted.push(m) });

g.setTimeout = (f: any) => f();
new Function(script)();

const find = (el: any, pred: (e: any) => boolean, acc: any[] = []): any[] => { if (pred(el)) acc.push(el); for (const k of el.children ?? []) find(k, pred, acc); return acc; };
const text = (el: any): string => el instanceof Text_ ? el.text : (el.children ?? []).map(text).join('');

const snap: any = {
	id: 'P1', owner: 'o', number: 3, title: 'Arkestra', url: 'https://github.com/orgs/o/projects/3', fetchedAt: 0,
	fields: [{ id: 'S', name: 'Status', type: 'single_select', options: [{ id: 'r', name: 'Ready', color: 'BLUE' }, { id: 'd', name: 'Done' }] }, { id: 'L', name: 'Line', type: 'text' }, { id: 'N', name: 'Estimate', type: 'number' }],
	items: [
		{ id: 'I1', type: 'issue', contentId: 'C1', number: 1, title: 'Board view', url: 'https://github.com/o/r/issues/1', state: 'OPEN', repository: 'o/r', labels: ['feature'], assignees: [], fields: { S: { kind: 'option', optionId: 'r', name: 'Ready' }, L: { kind: 'text', text: '0.9' } }, blockedBy: [], pullRequests: [] },
		...Array.from({ length: 5 }, (_: unknown, i: number) => ({ id: 'D' + i, type: 'issue', contentId: 'CD' + i, number: 10 + i, title: 'Old ' + i, state: 'CLOSED', repository: 'o/r', labels: [], assignees: [], fields: { S: { kind: 'option', optionId: 'd', name: 'Done' } }, blockedBy: [], pullRequests: [] })),
	],
};
const model = boardModel({ snapshot: snap, rooms: [{ roomId: 'x', title: 't', refs: ['#10'], type: 'coding', status: 'ended', phase: 'kész', agents: 2 }], status: { kind: 'synced', at: 0, live: true }, live: true, journal: [{ at: 0, direction: 'in', item: '#1', text: 'issues opened' }], clock: () => '14:12:08' });

listeners.message({ data: { type: 'model', model } });
const t1 = text(body); 
assert.ok(t1.includes('Line0.9') && t1.includes('Board view') && t1.includes('Start room ▸') && t1.includes('+ 2 more') && t1.includes('GitHub → here'), 'board drawn');
find(body, (e: any) => e.tag === 'button' && text(e) === 'Start room ▸')[0].fire('click');
assert.ok(posted.some((m: any) => m.type === 'startRoom' && m.itemId === 'I1'), 'start room posted');
// drag I1 to Done
const done = find(body, (e: any) => e.tag === 'section' && text(e).startsWith('Done'))[0];
done.fire('drop', { dataTransfer: { getData: () => 'I1', types: ['text/arkestra-item'] } });
assert.ok(posted.some((m: any) => m.type === 'move' && m.itemId === 'I1' && m.optionId === 'd'), 'move posted');
// table
find(body, (e: any) => e.tag === 'button' && text(e) === 'Table')[0].fire('click');
const t2 = text(body);
assert.ok(t2.includes('Estimate') && t2.includes('Prerequisites') && t2.includes('Progress'), 'table drawn');
const input = find(body, (e: any) => e.tag === 'input' && e.attrs.type === 'number')[0];
input.value = '3'; input.fire('change');
assert.ok(posted.some((m: any) => m.type === 'setField' && m.fieldId === 'N' && m.value === 3), 'number edit posted');
find(body, (e: any) => e.tag === 'th' && text(e) === 'Title')[0].fire('click');
// new issue form
find(body, (e: any) => e.tag === 'button' && text(e) === '+ New issue')[0].fire('click');
const title = find(body, (e: any) => e.tag === 'input' && e.attrs.placeholder === 'Title of the new issue')[0];
title.value = 'New task';
find(body, (e: any) => e.tag === 'button' && text(e) === 'Create')[0].fire('click');
assert.ok(posted.some((m: any) => m.type === 'createIssue' && m.title === 'New task' && m.repository === 'o/r'), 'create posted');
const plan = planModel({ snapshot: snap, rooms: [], git: { base: 'main', baseHead: 'abc1234', tags: ['v1.0'], log: [{ sha: 'abc1234', subject: 'Board (#70)', refs: [] }], branches: new Map() } });
listeners.message({ data: { type: 'model', model: { ...model, plan } } });
find(body, (e: any) => e.tag === 'button' && text(e) === 'Plan')[0].fire('click');
const t3 = text(body);
assert.ok(t3.includes('Release lanes') && t3.includes('Dependency staircase') && t3.includes('abc1234') && t3.includes('#70') && t3.includes('Live: v1.0'), 'plan drawn');
find(body, (e: any) => String(e.className ?? '').startsWith('cell') && text(e).includes('Board view'))[0].fire('click');
assert.ok(posted.some((m: any) => m.type === 'open' && m.url === 'https://github.com/o/r/issues/1'), 'cell opens the task');
listeners.message({ data: { type: 'screen', screen: { title: 'No GitHub Project for this workspace', text: 'x', actions: [{ label: 'Follow a project…', command: 'setProject' }] } } });
assert.ok(text(body).includes('No GitHub Project'), 'empty screen');


g.setTimeout = realTimeout;
});

/*---------------------------------------------------------------------------------------------
 *  Arkestra. The 2ARK template form as one page: the fields of each type, the agents chosen from
 *  the thread used last, a task's brief, and the room built from what came back.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readForm, visibleFields } from '../pageForm';
import { briefReference, templateFormSpec, templateRequest, type TemplateContext, type TemplateFormStrings } from '../templateSpec';

const t = new Proxy({}, { get: (_x, k) => k === 'reviewTitle' || k === 'codingTitle' || k === 'auditTitle' ? `${String(k)}: {0}` : k === 'sinceTitle' ? 'since {0}' : String(k) }) as unknown as TemplateFormStrings;
const agents = [{ id: 'claude', name: 'Claude' }, { id: 'codex@dev', name: 'Codex · dev' }, { id: 'gemini', name: 'Gemini' }];
const ctx: TemplateContext = { agents, repo: '/repo', branch: 'feature' };
const ids = (c: TemplateContext, values: Record<string, string>) => visibleFields(templateFormSpec(c, t), values).map(f => f.id);
const read = (c: TemplateContext, values: Record<string, string>) => {
	const r = readForm(templateFormSpec(c, t), values, 'Required');
	assert.ok(r.ok, JSON.stringify(r));
	return templateRequest(r.values, c, t);
};

test('each type shows its own fields; the audit lead only for two auditors, its test only when it fixes', () => {
	assert.deepEqual(ids(ctx, { type: 'review' }), ['type', 'first', 'second', 'reviewPrompt', 'reviewSource', 'reviewer', 'strict']);
	assert.deepEqual(ids(ctx, { type: 'coding' }), ['type', 'first', 'second', 'base', 'brief', 'coordinator', 'plan', 'codeTest', 'verify']);
	assert.deepEqual(ids(ctx, { type: 'audit', auditors: 'both', goal: 'doc' }), ['type', 'first', 'second', 'base', 'auditors', 'lead', 'since', 'focus', 'goal']);
	assert.deepEqual(ids(ctx, { type: 'audit', auditors: 'B', goal: 'P1' }), ['type', 'first', 'second', 'base', 'auditors', 'since', 'focus', 'goal', 'auditTest']);
	// Without a repository coding and audit say so instead of asking for a branch.
	assert.deepEqual(ids({ agents }, { type: 'coding' }).slice(0, 4), ['type', 'first', 'second', 'noRepo']);
});

test('the thread used last chooses the two agents; a task presets the type and the brief', () => {
	const spec = templateFormSpec({ ...ctx, preset: ['gemini', 'claude'], task: { type: 'audit', brief: 'https://github.com/o/r/issues/7' } }, t);
	const value = (id: string) => (spec.fields.find(f => f.id === id) as { value?: string }).value;
	assert.equal(value('type'), 'audit');
	assert.equal(value('first'), 'gemini');
	assert.equal(value('second'), 'claude');
	assert.equal(value('focus'), 'https://github.com/o/r/issues/7');
	assert.equal(value('base'), 'feature');
	// An unknown or doubled preset falls back to the first two different agents.
	const plain = templateFormSpec({ ...ctx, preset: ['claude', 'claude'] }, t);
	assert.deepEqual(['first', 'second'].map(id => (plain.fields.find(f => f.id === id) as { value?: string }).value), ['claude', 'codex@dev']);
});

test('the room from the form: a brief check, a coding room with an issue as its brief, an audit that fixes', () => {
	assert.deepEqual(read(ctx, { type: 'review', first: 'claude', second: 'gemini', reviewPrompt: 'Check the brief\nagainst AGENTS.md', reviewSource: 'docs/brief.md', reviewer: 'B', strict: 'major' }), {
		type: 'review', members: { A: { id: 'claude', name: 'Claude' }, B: { id: 'gemini', name: 'Gemini' } }, title: 'reviewTitle: Check the brief', max: 25,
		review: { reviewer: 'B', prompt: 'Check the brief\nagainst AGENTS.md', source: 'docs/brief.md', strict: 'major' },
	});
	const coding = read(ctx, { type: 'coding', first: 'claude', second: 'codex@dev', base: 'main', brief: '#42\nKeep it small', coordinator: 'A', plan: 'approve', codeTest: 'npm test', verify: 'no' });
	assert.ok(!('message' in coding));
	assert.equal(coding.title, 'codingTitle: #42');
	assert.deepEqual(coding.code, { repo: '/repo', base: 'main', coordinator: 'A', prompt: 'Keep it small', issue: '#42', plan: 'approve', test: 'npm test', verify: false });
	const audit = read(ctx, { type: 'audit', first: 'claude', second: 'codex@dev', base: 'main', auditors: 'B', since: 'v1.0', focus: '', goal: 'P2', auditTest: '' });
	assert.ok(!('message' in audit));
	assert.equal(audit.title, 'auditTitle: since v1.0');
	assert.deepEqual(audit.audit, { auditors: 'B', lead: 'B', since: 'v1.0', goal: 'fix', fix: 'auto', levels: 'P2' });
	assert.deepEqual(audit.code, { repo: '/repo', base: 'main', coordinator: 'B', prompt: '', plan: 'none', verify: true });
});

test('what cannot start says where: the same agent twice, no repository for coding', () => {
	assert.deepEqual(templateRequest({ type: 'review', first: 'claude', second: 'claude', reviewPrompt: 'x' }, ctx, t), { field: 'second', message: 'sameAgent' });
	assert.deepEqual(templateRequest({ type: 'coding', first: 'claude', second: 'gemini', brief: 'x' }, { agents }, t), { field: 'noRepo', message: 'noRepo' });
	// A required brief is the form's own check.
	assert.deepEqual(readForm(templateFormSpec(ctx, t), { type: 'coding', first: 'claude', second: 'gemini', brief: ' ' }, 'Required'), { ok: false, field: 'brief', message: 'Required' });
});

test('a brief that is a reference: an issue or PR link, #123 or a task number on its first line', () => {
	assert.deepEqual(briefReference('T88\ndo it'), { issue: 'T88', prompt: 'do it' });
	assert.deepEqual(briefReference('https://github.com/o/r/pull/9'), { issue: 'https://github.com/o/r/pull/9', prompt: '' });
	assert.deepEqual(briefReference('  write the thing  '), { prompt: 'write the thing' });
});

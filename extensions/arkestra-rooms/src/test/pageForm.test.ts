/*---------------------------------------------------------------------------------------------
 *  Arkestra. Forms in Arkestra's own pages: only the fields that show count, a choice only from
 *  its options, a required text not empty; a page form waits until its values pass or it is
 *  cancelled; the HTML is escaped and the page scripts compile. The ⌘K ⌘K field in the editor.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { FORM_CLIENT, FormRequests, fillLabel, formHtml, formPage, readForm, visibleFields, type FormSpec } from '../pageForm';
import { inlineEditHtml } from '../inlineEditHtml';

const spec: FormSpec = {
	id: 'f',
	title: 'New <thing>',
	submit: 'Save',
	cancel: 'Cancel',
	fields: [
		{ kind: 'choice', id: 'kind', label: 'Kind', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', detail: 'b & more' }] },
		{ kind: 'text', id: 'name', label: 'Name', value: 'x"y' },
		{ kind: 'text', id: 'note', label: 'Note', optional: true, when: { field: 'kind', in: ['a'] } },
		{ kind: 'choice', id: 'level', label: 'Level', style: 'select', options: [{ value: '1', label: 'One' }, { value: '2', label: 'Two' }], when: { field: 'kind', in: ['b'] } },
		{ kind: 'password', id: 'key', label: 'Key', when: { field: 'level', in: ['2'] } },
	],
};

test('only the fields that show: conditions follow the values, a hidden field hides the ones under it', () => {
	assert.deepEqual(visibleFields(spec, { kind: 'a' }).map(f => f.id), ['kind', 'name', 'note']);
	assert.deepEqual(visibleFields(spec, { kind: 'b', level: '1' }).map(f => f.id), ['kind', 'name', 'level']);
	assert.deepEqual(visibleFields(spec, { kind: 'b', level: '2' }).map(f => f.id), ['kind', 'name', 'level', 'key']);
	// level=2 left over from before does not show the key while kind is a.
	assert.deepEqual(visibleFields(spec, { kind: 'a', level: '2' }).map(f => f.id), ['kind', 'name', 'note']);
});

test('what came back is checked: trimmed, required, choices only from their options, hidden fields dropped', () => {
	assert.deepEqual(readForm(spec, { kind: 'a', name: '  n  ', note: '', level: '2', key: 'secret' }, 'Required'), { ok: true, values: { kind: 'a', name: 'n', note: '' } });
	assert.deepEqual(readForm(spec, { kind: 'b', name: 'n', level: '2', key: ' ' }, 'Required'), { ok: false, field: 'key', message: 'Required' });
	assert.deepEqual(readForm(spec, { kind: 'c', name: 'n' }, 'Required'), { ok: false, field: 'kind', message: 'Required' });
	assert.deepEqual(readForm(spec, { kind: 'a', name: '' }, 'Required'), { ok: false, field: 'name', message: 'Required' });
	// Not sent at all: the field's own starting value.
	assert.deepEqual(readForm(spec, {}, 'Required'), { ok: true, values: { kind: 'a', name: 'x"y', note: '' } });
	assert.deepEqual(readForm(spec, 'nonsense', 'Required'), { ok: true, values: { kind: 'a', name: 'x"y', note: '' } });
});

test('the form\'s HTML: escaped, conditions as data, the first option chosen, a password field', () => {
	const html = formHtml(spec);
	assert.ok(html.startsWith('<form class="pf" data-form="f" novalidate><div class="ft">New &lt;thing&gt;</div>'));
	assert.ok(html.includes('value="x&quot;y"'));
	assert.ok(html.includes('data-choice="a"') && html.includes('class="fo on" role="radio" aria-checked="true" data-value="a"'));
	assert.ok(html.includes('<small>b &amp; more</small>'));
	assert.ok(html.includes(`data-when="${'{&quot;field&quot;:&quot;kind&quot;,&quot;in&quot;:[&quot;a&quot;]}'}"`));
	assert.ok(html.includes('<select id="f-level" name="level"><option value="1" selected>One</option>'));
	assert.ok(html.includes('type="password"'));
	assert.ok(html.includes('data-cancel>Cancel</button><button type="submit" class="fbtn pri">Save</button>'));
	assert.doesNotThrow(() => new Script(FORM_CLIENT));
});

test('a page form waits: a wrong value is answered in place, its own check too, then the values; Cancel settles it empty', async () => {
	const posted: object[] = [];
	const forms = new FormRequests(m => posted.push(m), 'Required');
	let checked = 0;
	const answer = forms.open(spec, v => { checked++; return v.name === 'taken' ? { field: 'name', message: 'Taken' } : undefined; });
	assert.equal(await forms.receive({ type: 'other' }), false);
	await forms.receive({ type: 'form', form: 'f', values: { kind: 'a', name: '' } });
	assert.deepEqual(posted.pop(), { type: 'formError', form: 'f', field: 'name', message: 'Required' });
	await forms.receive({ type: 'form', form: 'f', values: { kind: 'a', name: 'taken' } });
	assert.deepEqual(posted.pop(), { type: 'formError', form: 'f', field: 'name', message: 'Taken' });
	assert.ok(forms.has('f'));
	await forms.receive({ type: 'form', form: 'f', values: { kind: 'a', name: 'ok', note: 'n' } });
	assert.deepEqual(posted.pop(), { type: 'formDone', form: 'f' });
	assert.deepEqual(await answer, { kind: 'a', name: 'ok', note: 'n' });
	assert.equal(checked, 2);
	assert.ok(!forms.has('f'));

	const cancelled = forms.open(spec);
	await forms.receive({ type: 'formCancel', form: 'f' });
	assert.equal(await cancelled, undefined);
	assert.deepEqual(posted.pop(), { type: 'formDone', form: 'f' });

	// A check that throws is a message under the form; a second form with the same id replaces the first.
	const first = forms.open(spec, () => { throw new Error('boom'); });
	await forms.receive({ type: 'form', form: 'f', values: { name: 'x' } });
	assert.deepEqual(posted.pop(), { type: 'formError', form: 'f', field: '', message: 'boom' });
	const second = forms.open(spec);
	assert.equal(await first, undefined);
	forms.cancelAll();
	assert.equal(await second, undefined);
});

test('a page that is one form is locked down, and its script compiles', () => {
	const page = formPage({ nonce: 'N', spec });
	assert.match(page, /default-src 'none'; style-src 'nonce-N'; script-src 'nonce-N';/);
	assert.ok(page.includes('<form class="pf" data-form="f"'));
	const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(page)![1];
	assert.doesNotThrow(() => new Script(script));
	const empty = formPage({ nonce: 'N', spec, empty: 'Needs <two> agents' });
	assert.ok(empty.includes('<p class="empty">Needs &lt;two&gt; agents</p>') && !empty.includes('<form'));
});

test('the ⌘K ⌘K field: in the editor, every agent listed and the ones not ready greyed with why; its script compiles', () => {
	const html = inlineEditHtml({
		nonce: 'N', agentId: 'claude',
		agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex@dev', name: 'Codex · dev', notReady: 'not <signed> in' }],
		t: { placeholder: 'What should change?', agent: 'Agent', edit: 'Edit', cancel: 'Cancel', hint: 'Enter edits' },
	});
	assert.match(html, /default-src 'none'; style-src 'nonce-N'; script-src 'nonce-N';/);
	assert.ok(html.includes('<option value="claude" selected>Claude</option>'));
	assert.ok(html.includes('<option value="codex@dev" disabled>Codex · dev · not &lt;signed&gt; in</option>'));
	const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(html)![1];
	assert.doesNotThrow(() => new Script(script));
	assert.ok(script.includes("type: 'submit', text: text.value.trim(), agentId: agent.value") && script.includes("type: 'cancel'"));
});

test('a choice names the agents chosen above it ({@first}), on the page and kept current there', () => {
	const spec: FormSpec = {
		id: 'tpl', title: 'New room', submit: 'Start',
		fields: [
			{ kind: 'choice', id: 'first', label: 'First agent', style: 'select', value: 'c', options: [{ value: 'c', label: 'Claude · tenark-claude' }, { value: 'x', label: 'Codex · tenark-codex' }] },
			{ kind: 'choice', id: 'second', label: 'Second agent', style: 'select', value: 'x', options: [{ value: 'c', label: 'Claude · tenark-claude' }, { value: 'x', label: 'Codex · tenark-codex' }] },
			{ kind: 'choice', id: 'auditors', label: 'Who audits?', options: [{ value: 'A', label: 'Only {@first}' }, { value: 'B', label: 'Only {@second}' }] },
		],
	};
	assert.equal(fillLabel(spec, 'Only {@first}'), 'Only Claude · tenark-claude');
	assert.equal(fillLabel(spec, '{@second} reviews, {@first} fixes'), 'Codex · tenark-codex reviews, Claude · tenark-claude fixes');
	assert.equal(fillLabel(spec, 'Only {@nobody}'), 'Only {@nobody}');
	const html = formHtml(spec);
	assert.ok(html.includes('Only Codex · tenark-codex'));
	assert.ok(html.includes('data-tpl="Only {@second}"'));
	assert.ok(FORM_CLIENT.includes("m.dataset.tpl.replace("));
});

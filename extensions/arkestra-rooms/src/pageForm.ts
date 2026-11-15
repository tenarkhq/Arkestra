/*---------------------------------------------------------------------------------------------
 *  Arkestra. Forms inside Arkestra's own pages instead of VS Code's input box and quick pick
 *  at the top: a popover under the button that was clicked, or a page section. Fields, their
 *  conditions and the check of what came back; the page script that runs them. No VS Code here,
 *  so it is testable; the texts come in already translated.
 *--------------------------------------------------------------------------------------------*/

import { fontFaces, fontSrc, TYPE_CSS, type PageFonts } from './fonts';

/** One choice of a choice field. */
export interface FormOption {
	readonly value: string;
	readonly label: string;
	readonly detail?: string;
}

/** The field shows only while another field's value is one of these. */
export interface FormCondition {
	readonly field: string;
	readonly in: readonly string[];
}

interface FieldBase {
	readonly id: string;
	readonly label: string;
	readonly hint?: string;
	readonly when?: FormCondition;
}

export interface TextField extends FieldBase {
	readonly kind: 'text' | 'password' | 'textarea';
	readonly value?: string;
	readonly placeholder?: string;
	/** Empty is allowed. */
	readonly optional?: boolean;
	/** Offered while typing (a datalist); anything else may be typed too. */
	readonly suggestions?: readonly string[];
}

export interface ChoiceField extends FieldBase {
	readonly kind: 'choice';
	readonly options: readonly FormOption[];
	readonly value?: string;
	/** `list`: rows with a check (the default); `select`: a drop-down. */
	readonly style?: 'list' | 'select';
}

/** A line of text between the fields. */
export interface NoteField extends FieldBase {
	readonly kind: 'note';
}

export type FormField = TextField | ChoiceField | NoteField;

export interface FormSpec {
	readonly id: string;
	readonly title?: string;
	readonly intro?: string;
	readonly fields: readonly FormField[];
	readonly submit: string;
	readonly cancel?: string;
	/** The submit button removes or overwrites something. */
	readonly danger?: boolean;
}

export type FormResult =
	| { readonly ok: true; readonly values: Readonly<Record<string, string>> }
	| { readonly ok: false; readonly field: string; readonly message: string };

function esc(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

/** The value a field starts with: its own, or a choice's first option. */
function initial(field: FormField): string {
	if (field.kind === 'note') {
		return '';
	}
	if (field.kind === 'choice') {
		return field.value !== undefined && field.options.some(o => o.value === field.value) ? field.value : field.options[0]?.value ?? '';
	}
	return field.value ?? '';
}

/** The fields that show with these values (a hidden field's condition hides the fields that depend on it too). */
export function visibleFields(spec: FormSpec, values: Readonly<Record<string, string>>): FormField[] {
	const shown = new Map<string, FormField>();
	for (const field of spec.fields) {
		const when = field.when;
		if (!when || (shown.has(when.field) && when.in.includes(values[when.field] ?? initial(shown.get(when.field)!)))) {
			shown.set(field.id, field);
		}
	}
	return [...shown.values()];
}

/**
 * What a page sent back, checked against the form: only the fields that show, trimmed, a
 * choice only from its options, a required text not empty. The first problem names its field.
 */
export function readForm(spec: FormSpec, raw: unknown, required: string): FormResult {
	const given = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
	const values: Record<string, string> = {};
	for (const field of spec.fields) {
		const v = given[field.id];
		values[field.id] = typeof v === 'string' ? v : initial(field);
	}
	const out: Record<string, string> = {};
	for (const field of visibleFields(spec, values)) {
		if (field.kind === 'note') {
			continue;
		}
		const value = field.kind === 'password' ? values[field.id].trim() : field.kind === 'textarea' ? values[field.id].replace(/\s+$/, '').replace(/^\s*\n/, '') : values[field.id].trim();
		if (field.kind === 'choice') {
			if (!field.options.some(o => o.value === value)) {
				return { ok: false, field: field.id, message: required };
			}
		} else if (!value && !field.optional) {
			return { ok: false, field: field.id, message: required };
		}
		out[field.id] = value;
	}
	return { ok: true, values: out };
}

/** What a form's own check says about values that passed readForm: nothing, or the problem (on a field, or under the form). */
export type FormCheck = (values: Readonly<Record<string, string>>) => PromiseLike<{ readonly field?: string; readonly message: string } | undefined> | { readonly field?: string; readonly message: string } | undefined;

/**
 * The forms a page shows, each waiting for its answer: the page's `form` message is checked
 * (readForm, then the form's own check) and either answered with `formError` or settles the
 * form (`formDone`); `formCancel` settles it empty. One page, one sender.
 */
export class FormRequests {
	private readonly pending = new Map<string, { spec: FormSpec; check?: FormCheck; resolve: (values: Readonly<Record<string, string>> | undefined) => void }>();

	constructor(private readonly post: (message: object) => void, private readonly required: string) { }

	/** Waits for the form's values; the caller shows `formHtml(spec)` in the page. A form with the same id replaces the waiting one. */
	open(spec: FormSpec, check?: FormCheck): Promise<Readonly<Record<string, string>> | undefined> {
		this.pending.get(spec.id)?.resolve(undefined);
		return new Promise(resolve => this.pending.set(spec.id, { spec, ...(check ? { check } : {}), resolve }));
	}

	/** Whether the form waits for an answer. */
	has(id: string): boolean {
		return this.pending.has(id);
	}

	/** Handles a page message about a form; false when it is about something else. */
	async receive(message: { type?: unknown; form?: unknown; values?: unknown }): Promise<boolean> {
		if ((message?.type !== 'form' && message?.type !== 'formCancel') || typeof message.form !== 'string') {
			return false;
		}
		const id = message.form;
		const entry = this.pending.get(id);
		if (!entry) {
			this.post({ type: 'formDone', form: id });
			return true;
		}
		if (message.type === 'formCancel') {
			this.pending.delete(id);
			this.post({ type: 'formDone', form: id });
			entry.resolve(undefined);
			return true;
		}
		const read = readForm(entry.spec, message.values, this.required);
		if (!read.ok) {
			this.post({ type: 'formError', form: id, field: read.field, message: read.message });
			return true;
		}
		let problem: { readonly field?: string; readonly message: string } | undefined;
		try {
			problem = await entry.check?.(read.values);
		} catch (error) {
			problem = { message: error instanceof Error ? error.message : String(error) };
		}
		if (problem) {
			this.post({ type: 'formError', form: id, field: problem.field ?? '', message: problem.message });
			return true;
		}
		if (this.pending.get(id) === entry) {
			this.pending.delete(id);
		}
		this.post({ type: 'formDone', form: id });
		entry.resolve(read.values);
		return true;
	}

	/** Settles every waiting form empty (the page closed). */
	cancelAll(): void {
		const all = [...this.pending.values()];
		this.pending.clear();
		for (const entry of all) {
			entry.resolve(undefined);
		}
	}
}

function whenAttr(field: FormField): string {
	return field.when ? ` data-when="${esc(JSON.stringify(field.when))}"` : '';
}

function fieldHtml(spec: FormSpec, field: FormField): string {
	const id = `${spec.id}-${field.id}`;
	const hint = field.hint ? `<small class="fh">${esc(field.hint)}</small>` : '';
	const err = `<small class="fe" data-error="${esc(field.id)}" role="alert"></small>`;
	if (field.kind === 'note') {
		return `<div class="fn"${whenAttr(field)}>${esc(field.label)}</div>`;
	}
	if (field.kind === 'choice') {
		const value = initial(field);
		if (field.style === 'select') {
			const options = field.options.map(o => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
			return `<label class="ff" data-field="${esc(field.id)}"${whenAttr(field)}><span class="fl">${esc(field.label)}</span><select id="${esc(id)}" name="${esc(field.id)}">${options}</select>${hint}${err}</label>`;
		}
		const rows = field.options.map(o => {
			const on = o.value === value;
			return `<button type="button" class="fo${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-value="${esc(o.value)}"><span class="fd"></span><span class="ml"><span class="mt">${esc(o.label)}</span>${o.detail ? `<small>${esc(o.detail)}</small>` : ''}</span></button>`;
		}).join('');
		return `<div class="ff" data-field="${esc(field.id)}" data-choice="${esc(value)}"${whenAttr(field)}><span class="fl">${esc(field.label)}</span><div class="fos" role="radiogroup" aria-label="${esc(field.label)}">${rows}</div>${hint}${err}</div>`;
	}
	const list = field.suggestions?.length ? `${id}-list` : '';
	const common = `id="${esc(id)}" name="${esc(field.id)}"${field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : ''}${field.optional ? '' : ' required'} autocomplete="off" spellcheck="false"`;
	const input = field.kind === 'textarea'
		? `<textarea ${common} rows="3">${esc(field.value ?? '')}</textarea>`
		: `<input ${common} type="${field.kind === 'password' ? 'password' : 'text'}" value="${esc(field.value ?? '')}"${list ? ` list="${esc(list)}"` : ''}>`;
	const datalist = list ? `<datalist id="${esc(list)}">${field.suggestions!.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>` : '';
	return `<label class="ff" data-field="${esc(field.id)}"${whenAttr(field)}><span class="fl">${esc(field.label)}</span>${input}${datalist}${hint}${err}</label>`;
}

/** The form's HTML; the page script (FORM_CLIENT) shows the fields whose conditions hold and sends the values. */
export function formHtml(spec: FormSpec): string {
	return `<form class="pf" data-form="${esc(spec.id)}" novalidate>`
		+ (spec.title ? `<div class="ft">${esc(spec.title)}</div>` : '')
		+ (spec.intro ? `<div class="fi2">${esc(spec.intro)}</div>` : '')
		+ spec.fields.map(f => fieldHtml(spec, f)).join('')
		+ `<small class="fe" data-error="" role="alert"></small>`
		+ `<div class="fb">${spec.cancel ? `<button type="button" class="fbtn" data-cancel>${esc(spec.cancel)}</button>` : ''}<button type="submit" class="fbtn pri${spec.danger ? ' danger' : ''}">${esc(spec.submit)}</button></div>`
		+ `</form>`;
}

/** The form's look, on the page's theme variables (--fg, --mute, --line2, --accent, --sel, --err). */
export const FORM_CSS = `
.pf { display: flex; flex-direction: column; gap: 10px; padding: 8px 10px 10px; min-width: 280px; }
.pf .ft { font-weight: 600; font-size: 13px; }
.pf .fi2, .pf .fn { color: var(--mute); font-size: 12.5px; line-height: 1.45; }
.pf .ff { display: flex; flex-direction: column; gap: 4px; }
.pf .fl { font-size: 12px; color: var(--mute); font-weight: 500; }
.pf input, .pf textarea, .pf select { width: 100%; font: inherit; font-size: 13px; color: var(--vscode-input-foreground, var(--fg)); background: var(--vscode-input-background); border: 1px solid var(--line2); border-radius: 7px; padding: 6px 8px; outline: none; }
.pf textarea { resize: vertical; min-height: 58px; line-height: 1.45; }
.pf input:focus, .pf textarea:focus, .pf select:focus { border-color: var(--vscode-focusBorder); }
.pf .fh { color: var(--mute); font-size: 11.5px; line-height: 1.4; }
.pf .fe { color: var(--err); font-size: 11.5px; }
.pf .fe:empty { display: none; }
.pf .bad input, .pf .bad textarea, .pf .bad select { border-color: var(--err); }
.pf .fos { display: flex; flex-direction: column; gap: 2px; }
.pf .fo { display: flex; align-items: flex-start; gap: 9px; width: 100%; text-align: left; padding: 6px 8px; border-radius: 7px; border: 1px solid transparent; }
.pf .fo:hover, .pf .fo:focus-visible { background: var(--sel); outline: none; }
.pf .fo.on { border-color: var(--line2); background: var(--accentbg, var(--sel)); }
.pf .fo .fd { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--line2); flex: none; margin-top: 2px; }
.pf .fo.on .fd { border: 4px solid var(--accent); }
.pf .fo .ml { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pf .fo small { color: var(--mute); font-size: 11.5px; line-height: 1.4; }
.pf .fb { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.pf .fbtn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--line2); font-size: 12.5px; }
.pf .fbtn:hover { background: var(--hover, var(--sel)); }
.pf .fbtn.pri { background: var(--accent); color: var(--accentfg); border-color: transparent; }
.pf .fbtn.pri:hover { filter: brightness(1.08); }
.pf .fbtn.danger { background: var(--err); color: var(--vscode-editor-background); }
.pf [hidden] { display: none !important; }
`;

/**
 * The page script of the forms: `wireForm(el, post)` runs one form element. Conditions show and
 * hide fields as the values change; Enter in a one-line field or the submit button sends
 * `{ type: 'form', form, values }`, Cancel or Escape sends `{ type: 'formCancel', form }`.
 * `formError(el, field, message)` shows the extension's answer under the field.
 */
export const FORM_CLIENT = `
function formValues(el) {
	const v = {};
	for (const f of el.querySelectorAll('[data-field]')) {
		const id = f.dataset.field;
		if (f.dataset.choice !== undefined) { v[id] = f.dataset.choice; continue; }
		const input = f.querySelector('input, textarea, select');
		if (input) { v[id] = input.value; }
	}
	return v;
}
function formUpdate(el) {
	const v = formValues(el);
	const shown = new Set();
	for (const f of el.querySelectorAll('[data-field], .fn')) {
		let ok = true;
		if (f.dataset.when) { try { const w = JSON.parse(f.dataset.when); ok = shown.has(w.field) && w.in.includes(v[w.field]); } catch { ok = true; } }
		f.hidden = !ok;
		if (ok && f.dataset.field) { shown.add(f.dataset.field); }
	}
}
function formError(el, field, message) {
	for (const f of el.querySelectorAll('.bad')) { f.classList.remove('bad'); }
	for (const e of el.querySelectorAll('[data-error]')) { e.textContent = ''; }
	const box = el.querySelector('[data-error="' + CSS.escape(field || '') + '"]') || el.querySelector('[data-error=""]');
	if (box) { box.textContent = message || ''; }
	const f = field ? el.querySelector('[data-field="' + CSS.escape(field) + '"]') : null;
	if (f) { f.classList.add('bad'); const i = f.querySelector('input, textarea, select, .fo.on, .fo'); if (i) { i.focus(); } }
	el.dataset.busy = '';
}
function wireForm(el, post) {
	const id = el.dataset.form;
	el.addEventListener('click', e => {
		const o = e.target.closest('.fo');
		if (o) {
			const f = o.closest('[data-field]');
			f.dataset.choice = o.dataset.value;
			for (const b of f.querySelectorAll('.fo')) { const on = b === o; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
			formUpdate(el);
			return;
		}
		if (e.target.closest('[data-cancel]')) { e.preventDefault(); post({ type: 'formCancel', form: id }); }
	});
	el.addEventListener('input', () => formUpdate(el));
	el.addEventListener('change', () => formUpdate(el));
	el.addEventListener('keydown', e => {
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); post({ type: 'formCancel', form: id }); }
		if (e.key === 'Enter' && e.target.tagName === 'TEXTAREA' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el.requestSubmit(); }
	});
	el.addEventListener('submit', e => {
		e.preventDefault();
		if (el.dataset.busy) { return; }
		el.dataset.busy = '1';
		const v = formValues(el);
		const values = {};
		for (const f of el.querySelectorAll('[data-field]')) { if (!f.hidden) { values[f.dataset.field] = v[f.dataset.field]; } }
		post({ type: 'form', form: id, values });
	});
	formUpdate(el);
	const first = el.querySelector('input, textarea, select, .fo.on');
	if (first) { first.focus(); }
}
`;

/**
 * A page that is one form (a new template room): the theme's colours, the bundled type, a
 * column in the middle. The page sends `ready` when it has loaded; `formError` and `formDone`
 * answer its form. Locked down: only its own script and style run.
 */
export function formPage(opts: { readonly nonce: string; readonly fonts?: PageFonts; readonly spec?: FormSpec; readonly empty?: string }): string {
	const { nonce } = opts;
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';${fontSrc(opts.fonts)} script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${fontFaces(opts.fonts)}
:root {
	--fg: var(--vscode-foreground);
	--mute: var(--vscode-descriptionForeground);
	--line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.25)));
	--line2: var(--vscode-input-border, var(--line));
	--accent: var(--vscode-button-background);
	--accentfg: var(--vscode-button-foreground);
	--accentbg: color-mix(in srgb, var(--vscode-button-background) 13%, transparent);
	--err: var(--vscode-errorForeground);
	--hover: var(--vscode-list-hoverBackground);
	--sel: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--fg); background: var(--vscode-editor-background); ${TYPE_CSS} font-size: 13px; }
button, input, textarea, select { font-family: inherit; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
main { max-width: 640px; margin: 0 auto; padding: 36px 28px 48px; }
.empty { color: var(--mute); font-size: 13px; line-height: 1.5; }
${FORM_CSS}
.pf { padding: 0; gap: 16px; }
.pf .ft { font-size: 22px; font-weight: 500; letter-spacing: -.01em; }
.pf .fi2 { font-size: 13px; margin-top: -8px; }
.pf .fb { justify-content: flex-start; flex-direction: row-reverse; margin-top: 6px; }
</style></head><body><main>${opts.spec && !opts.empty ? formHtml(opts.spec) : `<p class="empty">${esc(opts.empty ?? '')}</p>`}</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
${FORM_CLIENT}
const form = document.querySelector('form.pf');
if (form) { wireForm(form, m => vscode.postMessage(m)); }
window.addEventListener('message', e => {
	const m = e.data;
	if (form && m.type === 'formError' && m.form === form.dataset.form) { formError(form, m.field, m.message); }
	if (form && m.type === 'formDone' && m.form === form.dataset.form) { form.dataset.done = '1'; }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

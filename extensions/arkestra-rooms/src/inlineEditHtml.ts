/*---------------------------------------------------------------------------------------------
 *  Arkestra. The ⌘K ⌘K field inside the editor, above the lines it edits (an editor inset, not
 *  an input box at the top of the window): what should change, which agent does it, Edit and
 *  Cancel. No VS Code here, so it is testable; the texts come in already translated.
 *--------------------------------------------------------------------------------------------*/

import { fontFaces, fontSrc, TYPE_CSS, type PageFonts } from './fonts';

export interface InlineAgentOption {
	readonly id: string;
	readonly name: string;
	/** Why it cannot edit now; such an agent shows but cannot be chosen. */
	readonly notReady?: string;
}

export interface InlineEditStrings {
	readonly placeholder: string;
	readonly agent: string;
	readonly edit: string;
	readonly cancel: string;
	readonly hint: string;
}

function esc(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

/** The editor lines the field takes. */
export const INLINE_EDIT_LINES = 3;

/**
 * The field's page. It sends `{ type: 'submit', text, agentId }` (Enter or Edit), `{ type: 'cancel' }`
 * (Escape or Cancel); the agent drop-down lists every agent, the ones not ready greyed with why.
 */
export function inlineEditHtml(opts: { readonly nonce: string; readonly fonts?: PageFonts; readonly agents: readonly InlineAgentOption[]; readonly agentId: string; readonly text?: string; readonly t: InlineEditStrings }): string {
	const { nonce, t } = opts;
	const options = opts.agents.map(a => `<option value="${esc(a.id)}"${a.id === opts.agentId ? ' selected' : ''}${a.notReady ? ' disabled' : ''}>${esc(a.notReady ? `${a.name} · ${a.notReady}` : a.name)}</option>`).join('');
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';${fontSrc(opts.fonts)} script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${fontFaces(opts.fonts)}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
body { color: var(--vscode-foreground); ${TYPE_CSS} font-size: 13px; padding: 3px 12px 3px 0; }
form { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px 0 10px; border: 1px solid var(--vscode-focusBorder); border-radius: 9px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); box-shadow: 0 4px 16px rgba(0,0,0,.22); }
input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--vscode-input-foreground, var(--vscode-foreground)); font: inherit; font-size: 13px; }
input::placeholder { color: var(--vscode-input-placeholderForeground); }
select { max-width: 220px; font: inherit; font-size: 12px; color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 6px; height: 24px; padding: 0 4px; }
button { font: inherit; font-size: 12px; height: 24px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
button.pri { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
button:disabled { opacity: .5; cursor: default; }
.hint { color: var(--vscode-descriptionForeground); font-size: 11.5px; padding: 3px 10px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head><body>
<form id="f"><input id="text" placeholder="${esc(t.placeholder)}" value="${esc(opts.text ?? '')}" autocomplete="off" spellcheck="false" aria-label="${esc(t.placeholder)}"><select id="agent" title="${esc(t.agent)}" aria-label="${esc(t.agent)}">${options}</select><button type="button" id="cancel">${esc(t.cancel)}</button><button type="submit" class="pri" id="go">${esc(t.edit)}</button></form>
<div class="hint">${esc(t.hint)}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const f = document.getElementById('f'), text = document.getElementById('text'), agent = document.getElementById('agent'), go = document.getElementById('go');
const update = () => { go.disabled = !text.value.trim() || !agent.value; };
text.addEventListener('input', update);
f.addEventListener('submit', e => { e.preventDefault(); if (go.disabled) { return; } vscode.postMessage({ type: 'submit', text: text.value.trim(), agentId: agent.value }); });
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); vscode.postMessage({ type: 'cancel' }); } });
update();
text.focus();
window.addEventListener('focus', () => text.focus());
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

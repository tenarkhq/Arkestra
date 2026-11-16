/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Remote Control page (the Boards page's button, the palette's Remote Control
 *  commands): the GitHub relay it goes through, typed into the page's own fields; on or off,
 *  the pairing link, a new link confirmed in place; every thread or the chosen ones, ticked in
 *  the page. No quick pick at the top, no dialog. No VS Code here, so it is testable; the texts
 *  come in already translated.
 *--------------------------------------------------------------------------------------------*/

import { fontFaces } from './boardHtml';
import type { RemoteState } from './remote';

export interface RemoteStrings {
	readonly title: string;
	readonly lead: string;
	readonly relay: string;
	readonly relayLead: string;
	readonly relayUrl: string;
	readonly relayToken: string;
	readonly tokenKept: string;
	readonly tokenHint: string;
	readonly save: string;
	readonly disconnect: string;
	readonly notConnected: string;
	readonly connectedTo: string;
	readonly phone: string;
	readonly off: string;
	readonly connecting: string;
	readonly on: string;
	readonly error: string;
	readonly turnOn: string;
	readonly turnOff: string;
	readonly copyLink: string;
	readonly newLink: string;
	readonly newLinkAsk: string;
	readonly newLinkYes: string;
	readonly cancel: string;
	readonly linkNote: string;
	readonly scan: string;
	readonly threads: string;
	readonly every: string;
	readonly chosen: string;
	readonly noThreads: string;
}

/** What the page shows; sent as a message, so a half-typed relay address stays. */
export interface RemoteModel {
	readonly relayUrl: string;
	readonly hasToken: boolean;
	readonly on: boolean;
	readonly state: RemoteState;
	readonly all: boolean;
	readonly threads: readonly { readonly id: string; readonly title: string; readonly on: boolean }[];
	/** A line under the status (the link was copied, the relay is needed first). */
	readonly note?: string;
	/** The pairing link as a QR code (an SVG path, one unit per module) while it is on. */
	readonly qr?: { readonly d: string; readonly size: number };
}

/** What is wrong with the relay fields: an address that is not http(s), no token when none is saved. */
export function relayProblem(url: string, token: string, hasToken: boolean, t: { readonly url: string; readonly token: string }): string | undefined {
	let parsed: URL | undefined;
	try {
		parsed = new URL(url.trim());
	} catch {
		parsed = undefined;
	}
	if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
		return t.url;
	}
	if (!token.trim() && !hasToken) {
		return t.token;
	}
	return undefined;
}

/** The page's state line: off, connecting, on with its phones, or the relay's error. */
export function statusLine(model: Pick<RemoteModel, 'on' | 'state'>, t: Pick<RemoteStrings, 'off' | 'connecting' | 'on' | 'error'>): { tone: 'off' | 'busy' | 'ok' | 'bad'; text: string } {
	if (!model.on) {
		return { tone: 'off', text: t.off };
	}
	switch (model.state.kind) {
		case 'on': return { tone: 'ok', text: t.on.replace('{0}', String(model.state.phones)) };
		case 'error': return { tone: 'bad', text: t.error.replace('{0}', model.state.message) };
		default: return { tone: 'busy', text: t.connecting };
	}
}

/** The threads to tick, newest first, the ones switched on marked; ones switched on that are gone are left out. */
export function remoteThreads(list: readonly { id: string; title: string; lastAt: string }[], chosen: readonly string[]): RemoteModel['threads'] {
	return [...list].sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0)).map(x => ({ id: x.id, title: x.title, on: chosen.includes(x.id) }));
}

export function remotePage(nonce: string, cspSource: string, t: RemoteStrings, fontBase?: string): string {
	const strings = JSON.stringify(t).replace(/</g, '\\u003c');
	const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';${fontBase ? ` font-src ${cspSource};` : ''} script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${fontFaces(fontBase)}
	:root { --mute: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.25))); --ok: var(--vscode-testing-iconPassed, #4cc38a); --bad: var(--vscode-errorForeground); }
	html, body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); }
	body { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-size: 13px; -webkit-font-smoothing: antialiased; }
	.page { max-width: 720px; margin: 0 auto; padding: 28px 28px 40px; display: flex; flex-direction: column; gap: 16px; }
	h1 { font-size: 22px; font-weight: 600; letter-spacing: -.01em; margin: 0 0 4px; }
	.sub { color: var(--mute); line-height: 1.5; }
	section { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
	h2 { font-size: 13.5px; font-weight: 600; margin: 0; }
	.lead { color: var(--mute); line-height: 1.5; font-size: 12.5px; }
	label { display: grid; gap: 4px; }
	/* The relay form: its fields apart from each other. */
	#relay { display: grid; gap: 12px; }
	label > span { font-size: 12px; font-weight: 500; color: var(--mute); }
	small { color: var(--mute); font-size: 11.5px; }
	input[type=text], input[type=password] { font: inherit; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); color: var(--vscode-input-foreground, var(--vscode-foreground)); outline: none; }
	input:focus { border-color: var(--vscode-focusBorder); }
	.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
	button { font: inherit; font-size: 12.5px; height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--line); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
	button:hover { background: var(--vscode-list-hoverBackground); }
	button.pri { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	button.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 55%, transparent); }
	.state { display: inline-flex; align-items: center; gap: 7px; font-weight: 500; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--mute); }
	.state.ok { color: var(--ok); } .state.ok .dot { background: var(--ok); }
	.state.bad { color: var(--bad); } .state.bad .dot { background: var(--bad); }
	.state.busy .dot { animation: pulse 1.2s ease-in-out infinite; }
	@keyframes pulse { 50% { opacity: .3; } }
	.note { color: var(--mute); font-size: 12.5px; line-height: 1.5; }
	.note:empty { display: none; }
	.err { color: var(--bad); font-size: 12px; }
	.err:empty { display: none; }
	.confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--bad) 9%, transparent); }
	.confirm span { flex: 1 1 260px; }
	/* The pairing QR: dark modules on white whatever the theme, so every phone camera reads it. */
	.qr { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
	.qr svg { width: 168px; height: 168px; background: #fff; border-radius: 8px; flex: none; }
	.qr svg path { fill: #000; }
	.qr span { flex: 1 1 200px; color: var(--mute); font-size: 12.5px; line-height: 1.5; }
	.opt { display: flex; align-items: center; gap: 8px; cursor: pointer; }
	.list { display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto; padding-left: 24px; }
	.list label { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12.5px; cursor: pointer; }
	.list label span { color: var(--vscode-foreground); font-weight: 400; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	[hidden] { display: none !important; }
</style></head><body>
<div class="page">
	<header><h1>${esc(t.title)}</h1><div class="sub">${esc(t.lead)}</div></header>
	<section id="phone"></section>
	<section id="scope"></section>
	<section>
		<h2>${esc(t.relay)}</h2>
		<div class="lead">${esc(t.relayLead)}</div>
		<div class="note" id="relayState"></div>
		<form id="relay" novalidate>
			<label><span>${esc(t.relayUrl)}</span><input type="text" name="url" id="url" placeholder="https://edge.example.com/arkestra" autocomplete="off" spellcheck="false"></label>
			<label><span>${esc(t.relayToken)}</span><input type="password" name="token" id="token" autocomplete="off"><small id="tokenHint"></small></label>
			<div class="err" id="relayErr"></div>
			<div class="row"><button type="submit" class="pri">${esc(t.save)}</button><button type="button" id="disconnect" hidden>${esc(t.disconnect)}</button></div>
		</form>
	</section>
</div>
<script type="application/json" id="l10n" nonce="${nonce}">${strings}</script>
<script nonce="${nonce}">
(() => {
	const vscode = acquireVsCodeApi();
	const S = JSON.parse(document.getElementById('l10n').textContent);
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; };
	const post = m => vscode.postMessage(m);
	let model = null, asking = false, typed = false;
	const button = (act, label, cls) => { const b = el('button', cls || '', label); b.type = 'button'; b.dataset.act = act; return b; };
	function draw() {
		if (!model) { return; }
		const phone = $('phone');
		const st = model.status;
		const state = el('span', 'state ' + st.tone); state.append(el('span', 'dot'), document.createTextNode(st.text));
		const acts = el('div', 'row');
		if (asking) {
			const c = el('div', 'confirm'); c.append(el('span', '', S.newLinkAsk), button('newLinkYes', S.newLinkYes, 'danger'), button('newLinkNo', S.cancel));
			acts.append(c);
		} else if (model.on) {
			acts.append(button('copy', S.copyLink, 'pri'), button('newLink', S.newLink), button('stop', S.turnOff));
		} else {
			acts.append(button('start', S.turnOn, 'pri'));
		}
		const parts = [el('h2', '', S.phone), state];
		if (model.on && model.qr) {
			const NS = 'http://www.w3.org/2000/svg';
			const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 ' + model.qr.size + ' ' + model.qr.size); svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', S.scan);
			const p = document.createElementNS(NS, 'path'); p.setAttribute('d', model.qr.d); svg.append(p);
			const q = el('div', 'qr'); q.append(svg, el('span', '', S.scan)); parts.push(q);
		}
		phone.replaceChildren(...parts, acts, el('div', 'note', model.note || (model.on ? S.linkNote : '')));
		const scope = $('scope');
		const opt = (value, label) => { const l = el('label', 'opt'); const r = el('input'); r.type = 'radio'; r.name = 'scope'; r.value = value; r.checked = model.all === (value === 'all'); l.append(r, el('span', '', label)); return l; };
		scope.replaceChildren(el('h2', '', S.threads), opt('all', S.every), opt('chosen', S.chosen.replace('{0}', String(model.threads.filter(x => x.on).length))));
		if (!model.all) {
			const list = el('div', 'list');
			for (const x of model.threads) { const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.dataset.thread = x.id; c.checked = x.on; l.append(c, el('span', '', x.title)); list.append(l); }
			if (!model.threads.length) { list.append(el('div', 'note', S.noThreads)); }
			scope.append(list);
		}
		$('relayState').textContent = model.relayUrl && model.hasToken ? S.connectedTo.replace('{0}', model.relayUrl) : S.notConnected;
		if (!typed) { $('url').value = model.relayUrl; }
		$('token').placeholder = model.hasToken ? S.tokenKept : '';
		$('tokenHint').textContent = S.tokenHint;
		$('disconnect').hidden = !model.hasToken;
	}
	document.addEventListener('click', e => {
		const b = e.target.closest('button[data-act]');
		if (!b) { return; }
		const act = b.dataset.act;
		if (act === 'newLink') { asking = true; draw(); return; }
		if (act === 'newLinkNo') { asking = false; draw(); return; }
		if (act === 'newLinkYes') { asking = false; post({ type: 'newLink' }); return; }
		post({ type: act });
	});
	document.addEventListener('change', e => {
		const x = e.target;
		if (x.name === 'scope') { post({ type: 'scope', all: x.value === 'all' }); }
		if (x.dataset && x.dataset.thread) { post({ type: 'thread', id: x.dataset.thread, on: x.checked }); }
	});
	$('url').addEventListener('input', () => { typed = true; });
	$('disconnect').addEventListener('click', () => post({ type: 'disconnect' }));
	$('relay').addEventListener('submit', e => {
		e.preventDefault();
		$('relayErr').textContent = '';
		post({ type: 'saveRelay', url: $('url').value, token: $('token').value });
	});
	window.addEventListener('message', e => {
		const m = e.data;
		if (m.type === 'model') { model = m.model; draw(); }
		else if (m.type === 'relaySaved') {
			if (m.error) { $('relayErr').textContent = m.error; }
			else { typed = false; $('token').value = ''; }
		}
		else if (m.type === 'askNewLink') { asking = true; draw(); }
		else if (m.type === 'focusRelay') { $('url').focus(); }
	});
	post({ type: 'ready' });
})();
</script></body></html>`;
}

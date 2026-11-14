/*---------------------------------------------------------------------------------------------
 *  Arkestra. The thread panel's and the right panel's HTML: safe markdown for the answers,
 *  the rows, and the pages themselves (theme colours only). No VS Code here, so it is testable;
 *  the texts come in already translated.
 *--------------------------------------------------------------------------------------------*/

import { agentLabel, foldLabel, providerOf, type FoldItem, type LivePart, type Row } from './threadModel';

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

/** A link target the page may open: web, mail, or a plain anchor; anything else stays text. */
function safeUrl(url: string): string | undefined {
	const u = url.trim();
	return /^(https?:\/\/|mailto:)/i.test(u) ? u : undefined;
}

/** Inline markdown on escaped text: code, bold, italic, strike, links, bare URLs. */
function inline(text: string): string {
	const codes: string[] = [];
	// Code spans first, so nothing inside them is touched.
	let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) => {
		codes.push(`<code>${escapeHtml(code.trim() ? code.replace(/^ (.*) $/, '$1') : code)}</code>`);
		return `\u0000${codes.length - 1}\u0000`;
	});
	const links: string[] = [];
	s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, label: string, url: string) => {
		const href = safeUrl(url);
		if (!href) {
			return all;
		}
		links.push(`<a href="${escapeHtml(href)}">${inlineRest(escapeHtml(label))}</a>`);
		return `\u0001${links.length - 1}\u0001`;
	});
	s = s.replace(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, url => {
		links.push(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
		return `\u0001${links.length - 1}\u0001`;
	});
	s = inlineRest(escapeHtml(s));
	return s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)]).replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function inlineRest(s: string): string {
	return s
		.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
		.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
		.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>')
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** Markdown as safe HTML: every character escaped, then headings, code blocks, lists, tables, quotes, links. */
export function renderMarkdown(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const out: string[] = [];
	let i = 0;
	const paragraph: string[] = [];
	const flush = () => {
		if (paragraph.length) {
			out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
			paragraph.length = 0;
		}
	};
	while (i < lines.length) {
		const line = lines[i];
		const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
		if (fence) {
			flush();
			const close = fence[1];
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(close)) {
				body.push(lines[i]);
				i++;
			}
			i++;
			out.push(`<pre${fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
			continue;
		}
		if (!line.trim()) {
			flush();
			i++;
			continue;
		}
		const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			flush();
			const level = Math.min(6, heading[1].length + 2);
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			i++;
			continue;
		}
		if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			out.push('<hr>');
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			flush();
			const quote: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quote.push(lines[i].replace(/^\s*>\s?/, ''));
				i++;
			}
			out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
			flush();
			const head = cells(line);
			const align = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
			const attr = (n: number) => align[n] ? ` class="al-${align[n]}"` : '';
			i += 2;
			const body: string[][] = [];
			while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
				body.push(cells(lines[i]));
				i++;
			}
			out.push(`<div class="tbl"><table><thead><tr>${head.map((c, n) => `<th${attr(n)}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${head.map((_, n) => `<td${attr(n)}>${inline(r[n] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
			continue;
		}
		if (LIST.test(line)) {
			flush();
			const items: string[] = [];
			while (i < lines.length && (LIST.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length) || (!lines[i].trim() && i + 1 < lines.length && LIST.test(lines[i + 1]) && items.length))) {
				items.push(lines[i]);
				i++;
			}
			out.push(renderList(items));
			continue;
		}
		paragraph.push(line.trim());
		i++;
	}
	flush();
	return out.join('');
}

/** A list with nesting by indentation; an item's continuation lines join it. */
function renderList(lines: readonly string[]): string {
	type Item = { indent: number; ordered: boolean; start: number; text: string[]; children: string[] };
	const items: Item[] = [];
	const base = LIST.exec(lines[0])?.[1].length ?? 0;
	for (const line of lines) {
		const m = LIST.exec(line);
		const indent = m ? m[1].length : Infinity;
		if (m && indent <= base + 1) {
			items.push({ indent, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: [m[3]], children: [] });
		} else if (items.length) {
			const last = items[items.length - 1];
			if (m || last.children.length) {
				last.children.push(line);
			} else if (line.trim()) {
				last.text.push(line.trim());
			}
		}
	}
	const ordered = items[0]?.ordered;
	const task = (t: string) => {
		const box = /^\[([ xX])\]\s+(.*)$/.exec(t);
		return box ? `<span class="task">${box[1] === ' ' ? '☐' : '☑'}</span> ${inline(box[2])}` : inline(t);
	};
	const body = items.map(it => `<li>${it.text.map(task).join('<br>')}${it.children.some(c => c.trim()) ? renderMarkdown(dedent(it.children)) : ''}</li>`).join('');
	return ordered ? `<ol${items[0].start !== 1 ? ` start="${items[0].start}"` : ''}>${body}</ol>` : `<ul>${body}</ul>`;
}

function dedent(lines: readonly string[]): string {
	const indents = lines.filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length);
	const n = indents.length ? Math.min(...indents) : 0;
	return lines.map(l => l.slice(n)).join('\n');
}

/** The texts a thread page shows, translated by the caller. */
export interface ThreadStrings {
	readonly local: string;
	readonly attached: (n: number) => string;
	readonly tasksDone: (n: number) => string;
	readonly tasks: (n: number) => string;
	readonly other: (n: number) => string;
	readonly working: string;
	readonly copy: string;
}

const letter = (agentId: string, name: string) => `<i class="av ${providerOf(agentId)}">${escapeHtml((name.trim()[0] ?? '?').toUpperCase())}</i>`;

/** One row of the thread as HTML; its key changes only when its content does. */
export function rowHtml(row: Row, s: ThreadStrings, md: (text: string) => string = renderMarkdown, time = ''): string {
	switch (row.type) {
		case 'user':
			return `<div class="ub">${escapeHtml(row.text).replace(/\n/g, '<br>')}${row.attached ? `<div class="att">${escapeHtml(s.attached(row.attached))}</div>` : ''}</div>`;
		case 'agent':
			return `<div class="msg"><div class="who">${letter(row.agentId, row.name)}${escapeHtml(agentLabel(row.name, row.agentId, s.local))}</div><div class="md">${md(row.text)}</div>`
				+ `<div class="acts"><button class="act" data-copy="${escapeHtml(row.id)}" title="${escapeHtml(s.copy)}" aria-label="${escapeHtml(s.copy)}">${COPY_ICON}</button>${time ? `<span>${escapeHtml(time)}</span>` : ''}</div></div>`;
		case 'fold':
			return foldHtml(row.items, s);
	}
}

function foldHtml(items: readonly FoldItem[], s: ThreadStrings): string {
	const label = foldLabel(items, s);
	return `<details class="fold"><summary>${escapeHtml(label)}${CHEVRON}</summary><div class="items">${items.map(i => `<div class="fi ${i.kind}">${escapeHtml(i.summary)}</div>`).join('')}</div></details>`;
}

/** A running turn: what the agent wrote so far, and its last tool line under it. */
export function liveHtml(part: LivePart, name: string, s: ThreadStrings): string {
	return `<div class="msg live"><div class="who">${letter(part.agentId, name)}${escapeHtml(agentLabel(name, part.agentId, s.local))}</div>`
		+ (part.text ? `<div class="md">${renderMarkdown(part.text)}</div>` : '')
		+ `<div class="status"><span class="pulse"></span>${escapeHtml(part.tool ?? s.working)}</div>`
		+ (part.error ? `<div class="err">${escapeHtml(part.error)}</div>` : '')
		+ '</div>';
}

const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/></svg>';
const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 3 5 5-5 5"/></svg>';
export const ICONS = {
	plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3v10M3 8h10"/></svg>',
	send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
	stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
	check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m3.5 8.5 3 3 6-7"/></svg>',
	terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m5 7 2 1.5L5 10"/></svg>',
	agent: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="6" r="2.5"/><path d="M3.5 13.5a4.5 4.5 0 0 1 9 0"/></svg>',
	done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m3 8 3 3 7-7"/></svg>',
	file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>',
	machine: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="7" rx="1.5"/><path d="M5.5 13h5M8 10v3"/></svg>',
	folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
};

/** Colours, spacing and type of the render, on the theme's variables. */
const BASE_CSS = `
:root {
	--fg: var(--vscode-foreground);
	--mute: var(--vscode-descriptionForeground);
	--dim: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
	--line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.25)));
	--line2: var(--vscode-input-border, var(--line));
	--accent: var(--vscode-button-background);
	--accentfg: var(--vscode-button-foreground);
	--accentbg: color-mix(in srgb, var(--vscode-button-background) 13%, transparent);
	--ok: var(--vscode-testing-iconPassed, #4cc38a);
	--warn: var(--vscode-editorWarning-foreground, #e5b454);
	--err: var(--vscode-errorForeground);
	--hover: var(--vscode-list-hoverBackground);
	--sel: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
}
* { box-sizing: border-box; }
body { margin: 0; padding: 0; color: var(--fg); font-family: var(--vscode-font-family); font-size: 13px; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
svg { display: block; }
.mut { color: var(--mute); }
`;

/** The thread panel's page: rows, running turns, notices, and the composer or the new-chat cards. */
export function threadPage(opts: { nonce: string; cspSource: string; mode: 'thread' | 'new'; roomId?: string; placeholder: string; heading: string }): string {
	const { nonce } = opts;
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${opts.cspSource} https: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${BASE_CSS}
body { background: var(--vscode-editor-background); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
#conv { flex: 1; overflow-y: auto; padding: 26px 0 8px; }
.col { max-width: 740px; margin: 0 auto; padding: 0 28px; display: flex; flex-direction: column; gap: 14px; }
#rows, #live, #notice { display: flex; flex-direction: column; gap: 14px; }
#rows:empty, #live:empty, #notice:empty { display: none; }
.fold { color: var(--dim); font-size: 13px; }
.fold summary { list-style: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.fold summary::-webkit-details-marker { display: none; }
.fold .chev { width: 12px; height: 12px; transition: transform .12s; }
.fold[open] .chev { transform: rotate(90deg); }
.fold .items { margin: 6px 0 0 2px; padding-left: 12px; border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.fi { overflow-wrap: anywhere; }
.msg { line-height: 1.6; font-size: 14px; }
.who { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--mute); margin-bottom: 2px; }
.av { width: 18px; height: 18px; border-radius: 5px; display: grid; place-items: center; font-style: normal; font-size: 10px; font-weight: 700; color: var(--vscode-editor-background); background: var(--vscode-charts-purple, #b392f0); flex: none; }
.av.claude { background: var(--vscode-charts-orange, #e0915a); }
.av.codex { background: var(--vscode-charts-blue, #9fb4d8); }
.md { overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md p { margin: 0 0 8px; }
.md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; font-size: 14px; font-weight: 600; }
.md h3 { font-size: 16px; }
.md ul, .md ol { margin: 0 0 8px; padding-left: 22px; }
.md li { margin: 2px 0; }
.md li > p { margin: 0; }
.md code { font-family: var(--vscode-editor-font-family); font-size: .9em; background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 4px; }
.md pre { margin: 0 0 10px; padding: 10px 12px; background: var(--vscode-textCodeBlock-background); border-radius: 8px; overflow-x: auto; }
.md pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.5; white-space: pre; }
.md blockquote { margin: 0 0 8px; padding-left: 12px; border-left: 2px solid var(--line2); color: var(--mute); }
.md a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
.md .tbl { overflow-x: auto; margin: 0 0 10px; }
.md table { border-collapse: collapse; font-size: 13px; }
.md th, .md td { border: 1px solid var(--line); padding: 4px 9px; text-align: left; vertical-align: top; }
.md th { font-weight: 600; }
.md .al-center { text-align: center; }
.md .al-right { text-align: right; }
#thread, #chips, #right { display: contents; }
.ub { align-self: flex-end; background: var(--vscode-input-background); padding: 9px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; max-width: 70%; overflow-wrap: anywhere; }
.ub .att { color: var(--mute); font-size: 12px; margin-top: 4px; }
.acts { display: flex; gap: 14px; color: var(--dim); font-size: 12px; align-items: center; margin-top: 2px; opacity: 0; transition: opacity .12s; }
.msg:hover .acts { opacity: 1; }
.act { color: var(--dim); }
.act:hover { color: var(--fg); }
.act svg { width: 14px; height: 14px; }
.status { display: flex; align-items: center; gap: 8px; color: var(--mute); font-size: 12.5px; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; flex: none; }
@keyframes pulse { 50% { opacity: .3; } }
.err { color: var(--err); font-size: 12.5px; }
.notice { color: var(--mute); font-size: 13px; line-height: 1.55; border-left: 2px solid var(--line2); padding-left: 12px; }
.notice .md p:last-child { margin-bottom: 0; }
.nbtns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.compose { padding: 12px 28px 18px; }
.box { max-width: 740px; margin: 0 auto; border: 1px solid var(--line2); border-radius: 14px; background: var(--vscode-input-background); padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 12px; }
.box:focus-within { border-color: var(--vscode-focusBorder); }
textarea { width: 100%; resize: none; border: 0; outline: 0; background: transparent; color: var(--vscode-input-foreground); font: inherit; font-size: 14px; line-height: 1.5; min-height: 22px; max-height: 240px; padding: 0; }
textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
.brow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--line2); color: var(--fg); font-size: 12.5px; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
button.chip:hover { background: var(--hover); }
.chip .g { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.chip .g.working { background: var(--accent); }
.chip .g.waiting, .chip .g.warn { background: var(--warn); }
.chip.add { color: var(--mute); border-style: dashed; }
.chip.ghost { border-color: transparent; color: var(--mute); }
.sp { flex: 1; }
.round { width: 26px; height: 26px; display: grid; place-items: center; color: var(--mute); border-radius: 7px; }
.round:hover { background: var(--hover); color: var(--fg); }
.round svg { width: 16px; height: 16px; }
.send { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--accentfg); display: grid; place-items: center; }
.send svg { width: 14px; height: 14px; }
.send:disabled { opacity: .4; cursor: default; }
.hero { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 24px 28px; overflow-y: auto; }
.hero h2 { margin: 0; font-size: 24px; font-weight: 500; letter-spacing: -.01em; }
.hero .box { width: 100%; }
#heroBox { width: 100%; max-width: 740px; }
.pick { width: 100%; max-width: 740px; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.card { text-align: left; border: 1px solid var(--line2); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; background: var(--vscode-editorWidget-background, transparent); }
.card:hover { border-color: var(--vscode-focusBorder); }
.card.on { border-color: var(--accent); background: var(--accentbg); }
.card .top { display: flex; align-items: center; gap: 8px; font-weight: 500; font-size: 13px; }
.card .av { width: 20px; height: 20px; border-radius: 6px; font-size: 11px; }
.card .sub2 { color: var(--mute); font-size: 12px; }
.card .st { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--mute); }
.card .st .g, .card .st .w { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.card .st .w { background: var(--warn); }
.card .fix { color: var(--vscode-textLink-foreground); }
.card.off { opacity: .85; }
.chk { margin-left: auto; width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid var(--line2); display: grid; place-items: center; flex: none; }
.card.on .chk { background: var(--accent); border-color: var(--accent); color: var(--accentfg); }
.chk svg { width: 11px; height: 11px; }
.hint { color: var(--mute); font-size: 12.5px; width: 100%; max-width: 740px; display: flex; gap: 16px; flex-wrap: wrap; }
.hint b { color: var(--fg); font-weight: 500; }
.empty { color: var(--mute); }
@media (max-width: 520px) { .col, .compose { padding-left: 16px; padding-right: 16px; } .ub { max-width: 88%; } }
</style></head><body data-mode="${opts.mode}" data-room="${escapeHtml(opts.roomId ?? '')}">
<div id="thread">
	<div id="conv"><div class="col"><div id="rows"></div><div id="live"></div><div id="notice"></div></div></div>
</div>
<div id="hero" class="hero">
	<h2>${escapeHtml(opts.heading)}</h2>
	<div class="pick" id="cards"></div>
	<div id="heroBox"></div>
	<div class="hint" id="hint"></div>
</div>
<div class="compose" id="compose"><div class="box" id="box">
	<textarea id="input" rows="1" placeholder="${escapeHtml(opts.placeholder)}"></textarea>
	<div class="brow">
		<button class="round" id="attach">${ICONS.plus}</button>
		<span id="chips"></span>
		<span class="sp"></span>
		<span id="right"></span>
		<button class="send" id="send">${ICONS.send}</button>
	</div>
</div></div>
<script nonce="${nonce}">${CLIENT}</script>
</body></html>`;
}

/** The page's script: keyed rows (an unchanged row keeps its node, so an open fold stays open), the composer, the cards. */
const CLIENT = `
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const conv = $('conv'), rowsEl = $('rows'), liveEl = $('live'), noticeEl = $('notice'), input = $('input'), send = $('send');
let mode = document.body.dataset.mode, busy = false, selected = null, cards = [], strings = {};
const nearBottom = () => conv.scrollHeight - conv.scrollTop - conv.clientHeight < 80;
function keyed(el, list) {
	const old = new Map([...el.children].map(c => [c.dataset.key, c]));
	let prev = null;
	for (const item of list) {
		let node = old.get(item.key);
		if (!node || node.dataset.html !== item.html) {
			const t = document.createElement('template');
			t.innerHTML = item.html.trim();
			const fresh = t.content.firstElementChild || document.createElement('div');
			fresh.dataset.key = item.key;
			fresh.dataset.html = item.html;
			if (node && node.tagName === 'DETAILS' && fresh.tagName === 'DETAILS' && node.open) { fresh.open = true; }
			if (node) { node.replaceWith(fresh); }
			node = fresh;
		}
		old.delete(item.key);
		const at = prev ? prev.nextSibling : el.firstChild;
		if (at !== node) { el.insertBefore(node, at); }
		prev = node;
	}
	for (const node of old.values()) { node.remove(); }
}
function setMode(m) {
	mode = m;
	document.body.dataset.mode = m;
	$('thread').style.display = m === 'thread' ? 'contents' : 'none';
	$('hero').style.display = m === 'new' ? 'flex' : 'none';
	const box = $('box');
	if (m === 'new') { $('heroBox').appendChild(box); $('compose').style.display = 'none'; }
	else { $('compose').appendChild(box); $('compose').style.display = ''; }
}
function chip(c) {
	const b = document.createElement(c.action ? 'button' : 'span');
	b.className = 'chip' + (c.cls ? ' ' + c.cls : '');
	if (c.dot) { const d = document.createElement('span'); d.className = 'g ' + c.dot; b.appendChild(d); }
	b.appendChild(document.createTextNode(c.label));
	if (c.title) { b.title = c.title; }
	if (c.action) { b.addEventListener('click', () => vscode.postMessage(c.action)); }
	return b;
}
function renderChips(left, right) {
	$('chips').replaceChildren(...left.map(chip));
	$('right').replaceChildren(...right.map(chip));
}
function renderCards() {
	const el = $('cards');
	el.replaceChildren(...cards.map(c => {
		const b = document.createElement('button');
		b.className = 'card' + (selected.includes(c.id) ? ' on' : '') + (c.ready ? '' : ' off');
		b.innerHTML = c.html;
		b.addEventListener('click', e => {
			if (e.target.closest('[data-fix]')) { vscode.postMessage({ type: 'fix', agentId: c.id }); return; }
			if (!c.ready) { vscode.postMessage({ type: 'fix', agentId: c.id }); return; }
			selected = selected.includes(c.id) ? selected.filter(x => x !== c.id) : [...selected, c.id];
			vscode.setState({ ...(vscode.getState() || {}), selected });
			renderCards();
			renderNewChips();
		});
		return b;
	}));
	if (!cards.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = strings.noAgents || ''; el.replaceChildren(p); }
}
let newRight = [];
function renderNewChips() {
	renderChips(cards.filter(c => selected.includes(c.id)).map(c => ({ label: c.label, dot: 'ok' })), newRight);
	send.disabled = !selected.length;
}
function updateSend() {
	send.innerHTML = busy ? ${JSON.stringify(ICONS.stop)} : ${JSON.stringify(ICONS.send)};
	send.title = busy ? strings.stop || '' : strings.send || '';
	send.setAttribute('aria-label', send.title);
	if (mode === 'thread') { send.disabled = false; }
}
function grow() { input.style.height = 'auto'; input.style.height = Math.min(240, input.scrollHeight) + 'px'; }
function submit() {
	if (busy && mode === 'thread') { vscode.postMessage({ type: 'stop' }); return; }
	const text = input.value;
	if (!text.trim()) { return; }
	if (mode === 'new') {
		if (!selected.length) { return; }
		vscode.postMessage({ type: 'start', text, agents: selected });
	} else {
		vscode.postMessage({ type: 'send', text });
	}
	input.value = '';
	grow();
	vscode.setState({ ...(vscode.getState() || {}), draft: '' });
}
input.addEventListener('keydown', e => {
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) { submit(); } }
});
input.addEventListener('input', () => { grow(); vscode.setState({ ...(vscode.getState() || {}), draft: input.value }); });
send.addEventListener('click', submit);
$('attach').addEventListener('click', () => vscode.postMessage({ type: 'attach' }));
document.addEventListener('click', e => {
	const copy = e.target.closest('[data-copy]');
	if (copy) { vscode.postMessage({ type: 'copy', id: copy.dataset.copy }); }
	const btn = e.target.closest('[data-button]');
	if (btn) { vscode.postMessage({ type: 'button', index: Number(btn.dataset.button) }); }
});
window.addEventListener('message', e => {
	const m = e.data;
	if (m.type === 'thread') {
		const stick = nearBottom();
		if (mode !== 'thread') { setMode('thread'); }
		if (m.roomId) { document.body.dataset.room = m.roomId; vscode.setState({ ...(vscode.getState() || {}), roomId: m.roomId, mode: 'thread' }); }
		strings = m.strings || strings;
		keyed(rowsEl, m.rows);
		keyed(liveEl, m.live);
		noticeEl.innerHTML = m.notice || '';
		busy = !!m.busy;
		input.placeholder = m.placeholder || input.placeholder;
		renderChips(m.chips || [], m.right || []);
		updateSend();
		if (stick || m.scroll) { conv.scrollTop = conv.scrollHeight; }
	} else if (m.type === 'new') {
		if (mode !== 'new') { setMode('new'); }
		strings = m.strings || strings;
		cards = m.cards;
		const kept = (vscode.getState() || {}).selected;
		if (selected === null || m.reset) { selected = (m.reset ? m.selected : kept || m.selected).filter(id => cards.some(c => c.id === id && c.ready)); }
		newRight = m.right || [];
		$('hint').innerHTML = m.hint || '';
		input.placeholder = m.placeholder || input.placeholder;
		vscode.setState({ ...(vscode.getState() || {}), mode: 'new' });
		renderCards();
		renderNewChips();
		updateSend();
		send.disabled = !selected.length;
	} else if (m.type === 'insert') {
		const at = input.selectionStart ?? input.value.length;
		const pre = input.value.slice(0, at), post = input.value.slice(at);
		const gap = pre && !/\\s$/.test(pre) ? ' ' : '';
		input.value = pre + gap + m.text + ' ' + post;
		input.focus();
		grow();
	} else if (m.type === 'focus') {
		input.focus();
	}
});
setMode(mode);
const st = vscode.getState() || {};
if (st.draft) { input.value = st.draft; grow(); }
if (document.body.dataset.room) { vscode.setState({ ...st, roomId: document.body.dataset.room, mode: 'thread' }); }
vscode.postMessage({ type: 'ready' });
input.focus();
`;

/** The right panel's page: sections filled by messages, so its scroll stays. */
export function detailsPage(nonce: string): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${BASE_CSS}
body { padding: 6px 10px 16px; }
.rh { color: var(--mute); font-size: 12.5px; font-weight: 500; padding: 10px 4px 6px; }
.rr { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 0 4px; font-size: 13px; white-space: nowrap; border-radius: 6px; }
button.rr { width: 100%; text-align: left; }
button.rr:hover { background: var(--hover); }
.rr svg { width: 15px; height: 15px; color: var(--mute); flex: none; }
.rr .n { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.rr .k { color: var(--dim); font-size: 12px; }
.rr.mut { color: var(--mute); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
.dot.working { background: var(--accent); }
.dot.waiting, .dot.queued { background: var(--warn); }
.dot.error { background: var(--err); }
.dot.done, .dot.idle { background: var(--ok); }
.hr { height: 1px; background: var(--line); margin: 8px 0; }
.bar { width: 44px; height: 5px; border-radius: 3px; background: var(--line2); overflow: hidden; flex: none; }
.bar b { display: block; height: 100%; background: var(--accent); }
.bar.warn b { background: var(--warn); }
.bar.crit b { background: var(--err); }
.st { font-size: 12px; font-weight: 600; width: 14px; text-align: center; flex: none; }
.st.A { color: var(--ok); } .st.M { color: var(--warn); } .st.D { color: var(--err); }
.empty { color: var(--mute); padding: 4px; font-size: 12.5px; }
</style></head><body><div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
window.addEventListener('message', e => {
	if (e.data.type === 'render') {
		document.getElementById('root').innerHTML = e.data.html;
		for (const b of document.querySelectorAll('[data-w]')) { b.style.width = b.dataset.w + '%'; }
	}
});
document.addEventListener('click', e => { const b = e.target.closest('[data-change]'); if (b) { vscode.postMessage({ type: 'change', index: Number(b.dataset.change) }); } });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

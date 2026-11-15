/*---------------------------------------------------------------------------------------------
 *  Arkestra. The thread panel's and the right panel's HTML: safe markdown for the answers,
 *  the rows, and the pages themselves (theme colours only). No VS Code here, so it is testable;
 *  the texts come in already translated.
 *--------------------------------------------------------------------------------------------*/

import { fontFaces, fontSrc, TYPE_CSS, type PageFonts } from './fonts';
import { imageName, imageRefs, imageSource, userImages, type ImageResolver } from './images';
import { agentLabel, foldLabel, providerOf, stepParts, stepsLabel, withoutSteps, type FoldItem, type LivePart, type Row, type Step } from './threadModel';
import type { MenuItem } from './choice';
import { FORM_CLIENT, FORM_CSS, formHtml, type FormSpec } from './pageForm';

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

/** A link target the page may open: web, mail, or a plain anchor; anything else stays text. */
function safeUrl(url: string): string | undefined {
	const u = url.trim();
	return /^(https?:\/\/|mailto:)/i.test(u) ? u : undefined;
}

/** Without a resolver only data: and https images show; a local file needs the panel's allowed folders. */
const webImages: ImageResolver = src => {
	const source = imageSource(src);
	return source && source.kind !== 'file' ? source.url : undefined;
};
let resolveImage: ImageResolver = webImages;

/** An image as a thumbnail the page opens large; one that may not be loaded is its name. */
export function imageHtml(src: string, alt: string, resolve: ImageResolver = resolveImage): string {
	const url = resolve(src);
	const name = alt.trim() || imageName(src);
	return url
		? `<img class="thumb" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy">`
		: `<span class="imgx" title="${escapeHtml(/^data:/i.test(src) ? name : src)}">${IMAGE_ICON}${escapeHtml(name)}</span>`;
}

/** The pictures under a message: only those that may be loaded, unless `all` (the user's own attachments). */
export function imagesHtml(srcs: readonly string[], resolve: ImageResolver, all = false): string {
	const shown = srcs.filter(src => all || resolve(src));
	return shown.length ? `<div class="imgs">${shown.map(src => imageHtml(src, '', resolve)).join('')}</div>` : '';
}

/** Inline markdown on escaped text: code, images, bold, italic, strike, links, bare URLs. */
function inline(text: string): string {
	const codes: string[] = [];
	// Code spans first, so nothing inside them is touched.
	let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) => {
		codes.push(`<code>${escapeHtml(code.trim() ? code.replace(/^ (.*) $/, '$1') : code)}</code>`);
		return `\u0000${codes.length - 1}\u0000`;
	});
	const links: string[] = [];
	// Images before links: `![a](b)` holds a link's shape.
	s = s.replace(/!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g, (_all, alt: string, a: string | undefined, b: string | undefined) => {
		links.push(imageHtml(a ?? b ?? '', alt));
		return `\u0001${links.length - 1}\u0001`;
	});
	s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, label: string, url: string) => {
		const href = safeUrl(url);
		if (!href) {
			return all;
		}
		links.push(`<a href="${escapeHtml(href)}">${inlineRest(escapeHtml(label))}</a>`);
		return `\u0001${links.length - 1}\u0001`;
	});
	// A bare URL ends before closing punctuation and markup around it (`**https://…**` is a bold link).
	s = s.replace(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_~]/g, url => {
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

export interface MarkdownOptions {
	/** Where an image may come from (default: data: and https only). */
	readonly image?: ImageResolver;
}

/** A table cell: inline markdown, and the `<br>` agents write for a line break inside a cell. */
function cell(text: string): string {
	return inline(text).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
}

/** Markdown as safe HTML: every character escaped, then headings, code blocks with a copy button, lists, tables, quotes, links, images. */
export function renderMarkdown(text: string, opts: MarkdownOptions = {}): string {
	const before = resolveImage;
	resolveImage = opts.image ?? webImages;
	try {
		return render(text);
	} finally {
		resolveImage = before;
	}
}

function render(text: string): string {
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
			out.push(`<div class="code"><pre${fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre><button class="cpy" data-copycode aria-label="Copy">${COPY_ICON}</button></div>`);
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
			out.push(`<blockquote>${render(quote.join('\n'))}</blockquote>`);
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
			out.push(`<div class="tbl"><table><thead><tr>${head.map((c, n) => `<th${attr(n)}>${cell(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${head.map((_, n) => `<td${attr(n)}>${cell(r[n] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
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
	const body = items.map(it => `<li>${it.text.map(task).join('<br>')}${it.children.some(c => c.trim()) ? render(dedent(it.children)) : ''}</li>`).join('');
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
	/** An error row's second sentence when an SSH machine has the thread's session, and its button. */
	readonly runsOn?: (machine: string) => string;
	readonly continueOn?: (machine: string) => string;
}

const letter = (agentId: string, name: string) => `<i class="av ${providerOf(agentId)}">${escapeHtml((name.trim()[0] ?? '?').toUpperCase())}</i>`;

/**
 * One row of the thread as HTML; its key changes only when its content does. Images load
 * through `image` (the panel's allowed folders); the user's attached pictures show in the bubble.
 */
export function rowHtml(row: Row, s: ThreadStrings, md: (text: string, opts?: MarkdownOptions) => string = renderMarkdown, time = '', image: ImageResolver = webImages): string {
	switch (row.type) {
		case 'user': {
			const { text, images } = userImages(row.text);
			const bubble = `<div class="ub">${escapeHtml(text).replace(/\n/g, '<br>')}${imagesHtml(images, image, true)}${row.attached ? `<div class="att">${escapeHtml(s.attached(row.attached))}</div>` : ''}</div>`;
			const acts = row.id === 'pending' ? '' : `<div class="acts">${time ? `<span>${escapeHtml(time)}</span>` : ''}<button class="act" data-copy="${escapeHtml(row.id)}" title="${escapeHtml(s.copy)}" aria-label="${escapeHtml(s.copy)}">${COPY_ICON}</button></div>`;
			return `<div class="um">${bubble}${acts}</div>`;
		}
		case 'agent':
			return `<div class="msg"><div class="who">${letter(row.agentId, row.name)}${escapeHtml(agentLabel(row.name, row.agentId, s.local))}</div><div class="md">${answerHtml(row.text, md, image)}${imagesHtml(imageRefs(withoutSteps(row.text)), image)}</div>`
				+ `<div class="acts"><button class="act" data-copy="${escapeHtml(row.id)}" title="${escapeHtml(s.copy)}" aria-label="${escapeHtml(s.copy)}">${COPY_ICON}</button>${time ? `<span>${escapeHtml(time)}</span>` : ''}</div></div>`;
		case 'fold':
			return foldHtml(row.items, s);
		case 'error':
			return errorHtml(row, s);
	}
}

/**
 * An agent's failed turn: a notice in the error tone, under whose turn it was. When the agent's
 * CLI is not on this computer and an SSH machine has the session, it says so and offers to go on there.
 */
function errorHtml(row: Extract<Row, { type: 'error' }>, s: ThreadStrings): string {
	const home = row.missing ? row.home : undefined;
	// The first sentence says what is wrong; the second, what to do (here: go on where the session is).
	const text = home ? `${row.text.replace(/^(.*?\.)\s[\s\S]*$/, '$1')} ${(s.runsOn ?? (m => `This session runs on ${m}: open it from there.`))(home.machine)}` : row.text;
	const button = home ? `<div class="nbtns"><button class="chip" data-continue="${escapeHtml(row.agentId)}" data-to="${escapeHtml(home.id)}">${escapeHtml((s.continueOn ?? (m => `Continue on ${m}`))(home.machine))}</button></div>` : '';
	return `<div class="notice error" role="alert"><div class="eh">${escapeHtml(agentLabel(row.name, row.agentId, s.local))}</div><div>${escapeHtml(text)}</div>${button}</div>`;
}

/** An answer's texts, with what the agent did between them as folded lines (the apps' "Checked …", "Ran 3 commands"). */
function answerHtml(text: string, md: (text: string, opts?: MarkdownOptions) => string, image: ImageResolver): string {
	return stepParts(text).map(p => 'md' in p ? (p.md ? md(p.md, { image }) : '') : stepsHtml(p.steps)).join('');
}

function stepsHtml(steps: readonly Step[]): string {
	const items = steps.length > 1 ? `<div class="items">${steps.map(st => `<div class="fi">${escapeHtml(st.label)}</div>`).join('')}</div>` : '';
	return steps.length > 1
		? `<details class="fold steps"><summary>${escapeHtml(stepsLabel(steps))}${CHEVRON}</summary>${items}</details>`
		: `<div class="fold steps one">${escapeHtml(steps[0].label)}</div>`;
}

function foldHtml(items: readonly FoldItem[], s: ThreadStrings): string {
	const label = foldLabel(items, s);
	return `<details class="fold"><summary>${escapeHtml(label)}${CHEVRON}</summary><div class="items">${items.map(i => `<div class="fi ${i.kind}">${escapeHtml(i.summary)}</div>`).join('')}</div></details>`;
}

/** A running turn: what the agent wrote so far, and its last tool line under it. */
export function liveHtml(part: LivePart, name: string, s: ThreadStrings, image: ImageResolver = webImages): string {
	return `<div class="msg live"><div class="who">${letter(part.agentId, name)}${escapeHtml(agentLabel(name, part.agentId, s.local))}</div>`
		+ (part.text ? `<div class="md">${answerHtml(part.text, renderMarkdown, image)}</div>` : '')
		+ `<div class="status"><span class="pulse"></span>${escapeHtml(part.tool ?? s.working)}</div>`
		+ (part.error ? `<div class="err">${escapeHtml(part.error)}</div>` : '')
		+ '</div>';
}

const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/></svg>';
const IMAGE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="m2.5 12 4-4 3 3 2-2 2.5 2.5"/></svg>';
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
	close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
	image: IMAGE_ICON,
	folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
};

/**
 * A composer menu's rows (the model, effort and mode popover above a chip, as in the Claude
 * desktop app): headings, lines, and choices with the chosen one checked. Each choice carries
 * its message to the extension.
 */
export function menuHtml(items: readonly MenuItem[]): string {
	return items.map(i => {
		if (i.kind === 'sep') {
			return '<div class="msep" role="separator"></div>';
		}
		if (i.kind === 'header') {
			return `<div class="mh">${escapeHtml(i.label ?? '')}</div>`;
		}
		const label = `<span class="ml"><span class="mt">${escapeHtml(i.label ?? '')}</span>${i.detail ? `<small>${escapeHtml(i.detail)}</small>` : ''}</span>`;
		return `<button class="mi${i.checked ? ' on' : ''}" role="menuitemradio" aria-checked="${i.checked ? 'true' : 'false'}" data-action="${escapeHtml(JSON.stringify(i.action ?? {}))}">${label}<span class="mc">${i.checked ? ICONS.check : ''}</span></button>`;
	}).join('');
}

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
body { margin: 0; padding: 0; color: var(--fg); ${TYPE_CSS} font-size: 13px; font-weight: 400; }
button, input, textarea, select { font-family: inherit; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
svg { display: block; }
.mut { color: var(--mute); }
`;

/** The thread panel's page: rows, running turns, notices, and the composer or the new-chat cards. */
export function threadPage(opts: { nonce: string; cspSource: string; mode: 'thread' | 'new'; roomId?: string; placeholder: string; heading: string; fonts?: PageFonts; close?: string; attach?: string; down?: string }): string {
	const { nonce } = opts;
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${opts.cspSource} https: data:; style-src 'nonce-${nonce}';${fontSrc(opts.fonts)} script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${fontFaces(opts.fonts)}${BASE_CSS}${FORM_CSS}
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
.md .steps { margin: 10px 0; }
.md .steps.one { overflow-wrap: anywhere; }
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
.md .code { position: relative; margin: 0 0 10px; }
.md pre { margin: 0; padding: 10px 12px; background: var(--vscode-textCodeBlock-background); border-radius: 8px; overflow-x: auto; }
.md .cpy { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; color: var(--dim); background: var(--vscode-textCodeBlock-background); opacity: 0; transition: opacity .12s; }
.md .code:hover .cpy, .md .cpy:focus-visible, .md .cpy.done { opacity: 1; }
.md .cpy:hover { color: var(--fg); background: var(--hover); }
.md .cpy svg { width: 14px; height: 14px; }
.md .cpy.done { color: var(--ok); }
.thumb { display: block; max-width: 100%; max-height: 360px; width: auto; height: auto; border-radius: 8px; border: 1px solid var(--line); cursor: zoom-in; background: var(--vscode-textCodeBlock-background); }
.md .thumb { margin: 4px 0 8px; }
.imgs { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 8px; }
.imgs .thumb { max-height: 240px; }
.ub .imgs { margin: 6px 0 2px; justify-content: flex-end; }
.ub .imgs .thumb { max-height: 200px; }
.imgx { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); color: var(--mute); font-size: 12.5px; }
.imgx svg { width: 14px; height: 14px; flex: none; }
#lightbox { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center; padding: 28px; background: color-mix(in srgb, var(--vscode-editor-background) 82%, transparent); backdrop-filter: blur(3px); cursor: zoom-out; }
#lightbox.on { display: flex; }
#lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,.35); cursor: default; background: var(--vscode-editor-background); }
#lightbox .x { position: absolute; top: 12px; right: 12px; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: var(--fg); }
#lightbox .x:hover { background: var(--hover); }
#lightbox .x svg { width: 16px; height: 16px; }
#atts { display: flex; flex-wrap: wrap; gap: 8px; }
#atts:empty { display: none; }
.att2 { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 56px; max-width: 220px; border: 1px solid var(--line2); border-radius: 9px; background: var(--vscode-editor-background); font-size: 12.5px; color: var(--mute); }
.att2.file { height: 30px; padding: 0 26px 0 9px; }
.att2.file svg { width: 14px; height: 14px; flex: none; }
.att2.file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att2 img { height: 100%; width: auto; max-width: 160px; object-fit: cover; border-radius: 8px; display: block; }
.att2 .rm { position: absolute; top: -7px; right: -7px; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--line2); color: var(--mute); }
.att2.file .rm { top: 5px; right: 4px; border: 0; background: transparent; }
.att2 .rm:hover { color: var(--fg); }
.att2 .rm svg { width: 10px; height: 10px; }
.att2.busy { opacity: .55; }
.box.drop { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-input-background) 85%, var(--vscode-focusBorder)); }
.md pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.5; white-space: pre; }
.md blockquote { margin: 0 0 8px; padding-left: 12px; border-left: 2px solid var(--line2); color: var(--mute); }
.md a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
.md .tbl { overflow-x: auto; margin: 0 0 10px; position: relative; left: 50%; transform: translateX(-50%); width: fit-content; min-width: 100%; max-width: min(1180px, calc(100vw - 48px)); }
.md table { border-collapse: collapse; font-size: 13px; }
.md th, .md td { border: 1px solid var(--line); padding: 4px 9px; text-align: left; vertical-align: top; overflow-wrap: normal; word-break: normal; min-width: 5em; }
.md th { white-space: nowrap; }
.md td code { white-space: nowrap; }
.md th { font-weight: 600; }
.md .al-center { text-align: center; }
.md .al-right { text-align: right; }
#thread, #chips, #right { display: contents; }
.um { align-self: flex-end; max-width: 88%; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.um:hover .acts { opacity: 1; }
.ub { background: var(--vscode-input-background); padding: 9px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; max-width: 100%; overflow-wrap: anywhere; }
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
.notice.error { color: var(--fg); border-left-color: var(--err); }
.notice.error .eh { color: var(--err); font-size: 12px; font-weight: 600; margin-bottom: 2px; }
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
.chip.open { background: var(--hover); color: var(--fg); }
.pop { position: fixed; z-index: 40; min-width: 232px; max-width: 320px; max-height: 62vh; overflow-y: auto; padding: 5px; border-radius: 12px; border: 1px solid var(--line2); background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background))); color: var(--vscode-menu-foreground, var(--fg)); box-shadow: 0 12px 32px rgba(0,0,0,.38); display: flex; flex-direction: column; font-size: 13px; }
.pop .mh { padding: 7px 10px 4px; color: var(--mute); font-size: 11.5px; font-weight: 500; }
.pop .msep { height: 1px; background: var(--line); margin: 4px 2px; flex: none; }
.pop .mi { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 30px; padding: 5px 10px; border-radius: 7px; text-align: left; flex: none; }
.pop .mi:hover, .pop .mi:focus-visible { background: var(--sel); outline: none; }
.pop .ml { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pop .mt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pop .ml small { color: var(--mute); font-size: 11.5px; overflow-wrap: anywhere; }
.pop .mc { width: 14px; height: 14px; color: var(--accent); flex: none; }
.pop .mc svg { width: 14px; height: 14px; }
.pop.wide { width: 380px; max-width: calc(100vw - 16px); padding: 2px; }
.card.addc { border-style: dashed; color: var(--mute); justify-content: center; align-items: center; min-height: 92px; }
.card.addc .top { justify-content: center; font-weight: 500; color: var(--fg); }
.card.addc .sub2 { text-align: center; }
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
.card .st { display: flex; align-items: baseline; gap: 6px; font-size: 12px; color: var(--mute); line-height: 1.45; }
.card .st > span:last-child { min-width: 0; }
.card .st .g, .card .st .w { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; align-self: center; }
.card .st .w { background: var(--warn); }
.card .fix { color: var(--vscode-textLink-foreground); }
.card.off { opacity: .85; }
.chk { margin-left: auto; width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid var(--line2); display: grid; place-items: center; flex: none; }
.card.on .chk { background: var(--accent); border-color: var(--accent); color: var(--accentfg); }
.chk svg { width: 11px; height: 11px; visibility: hidden; }
.card.on .chk svg { visibility: visible; }
.hint { color: var(--mute); font-size: 12.5px; width: 100%; max-width: 740px; display: flex; gap: 16px; flex-wrap: wrap; }
.hint b { color: var(--fg); font-weight: 500; }
.empty { color: var(--mute); }
.compose { position: relative; }
.down { position: absolute; top: -42px; left: 50%; transform: translateX(-50%); width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: var(--fg); background: var(--vscode-editor-background); border: 1px solid var(--line2); box-shadow: 0 2px 8px rgba(0,0,0,.18); z-index: 5; }
.down[hidden] { display: none; }
.down:hover { background: var(--hover); }
.down svg { width: 15px; height: 15px; }
@media (max-width: 520px) { .col, .compose { padding-left: 16px; padding-right: 16px; } .um { max-width: 94%; } }
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
<div class="compose" id="compose"><button class="down" id="down" hidden title="${escapeHtml(opts.down ?? 'Jump to the end')}" aria-label="${escapeHtml(opts.down ?? 'Jump to the end')}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg></button><div class="box" id="box">
	<div id="atts"></div>
	<textarea id="input" rows="1" placeholder="${escapeHtml(opts.placeholder)}"></textarea>
	<div class="brow">
		<button class="round" id="attach" data-chip="attach" aria-haspopup="menu" title="${escapeHtml(opts.attach ?? 'Attach')}" aria-label="${escapeHtml(opts.attach ?? 'Attach')}">${ICONS.plus}</button>
		<span id="chips"></span>
		<span class="sp"></span>
		<span id="right"></span>
		<button class="send" id="send">${ICONS.send}</button>
	</div>
</div></div>
<div id="lightbox" role="dialog" aria-modal="true"><button class="x" id="lbClose" aria-label="${escapeHtml(opts.close ?? 'Close')}" title="${escapeHtml(opts.close ?? 'Close')}">${ICONS.close}</button><img id="lbImg" alt=""></div>
<script nonce="${nonce}">${CLIENT}</script>
</body></html>`;
}

/** The page's script: keyed rows (an unchanged row keeps its node, so an open fold stays open), the composer, the cards. */
const CLIENT = `
const vscode = acquireVsCodeApi();
${FORM_CLIENT}
const $ = id => document.getElementById(id);
const conv = $('conv'), rowsEl = $('rows'), liveEl = $('live'), noticeEl = $('notice'), input = $('input'), send = $('send');
let mode = document.body.dataset.mode, busy = false, selected = null, cards = [], strings = {};
const nearBottom = () => conv.scrollHeight - conv.scrollTop - conv.clientHeight < 80;
const down = $('down');
let stuck = true;
const showDown = () => { stuck = nearBottom(); down.hidden = stuck; };
conv.addEventListener('scroll', showDown, { passive: true });
// A picture that loads later makes the thread taller: one that sat at the end stays there.
conv.addEventListener('load', e => { if (e.target.tagName === 'IMG' && stuck) { conv.scrollTop = conv.scrollHeight; } }, true);
down.addEventListener('click', () => { conv.scrollTo({ top: conv.scrollHeight, behavior: 'smooth' }); });
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
	const b = document.createElement(c.action || c.menu ? 'button' : 'span');
	b.className = 'chip' + (c.cls ? ' ' + c.cls : '') + (c.key && popKey === c.key ? ' open' : '');
	if (c.dot) { const d = document.createElement('span'); d.className = 'g ' + c.dot; b.appendChild(d); }
	b.appendChild(document.createTextNode(c.label));
	if (c.title) { b.title = c.title; }
	if (c.key) { b.dataset.chip = c.key; }
	if (c.menu) {
		b.setAttribute('aria-haspopup', 'menu');
		b.addEventListener('click', () => openMenu(c.key, c.menu));
	} else if (c.action) { b.addEventListener('click', () => vscode.postMessage(c.action)); }
	return b;
}
function renderChips(left, right) {
	$('chips').replaceChildren(...left.map(chip));
	$('right').replaceChildren(...right.map(chip));
	keepMenu();
}
// A popover stays on its anchor when the page redraws and closes when the anchor is gone; one the extension asked for opens once its anchor shows.
let pendingOpen = null;
function keepMenu() {
	if (pop) { if (!document.querySelector('[data-chip="' + CSS.escape(popKey) + '"]')) { closeMenu(); } else { placeMenu(); } }
	if (pendingOpen && document.querySelector('[data-chip="' + CSS.escape(pendingOpen.anchor) + '"]')) { const p = pendingOpen; pendingOpen = null; if (popKey !== p.anchor) { openMenu(p.anchor, p.req); } }
}
function openMenu(key, req) {
	if (popKey === key) { closeMenu(); return; }
	showMenu(key, '<div class="mh"></div>');
	if (!pop) { return; }
	pop.firstChild.textContent = strings.loading || '…';
	vscode.postMessage({ type: 'menu', anchor: key, ...req });
}
// The composer's popover menus (model and effort, mode), anchored above their chip.
let pop = null, popKey = null;
function closeMenu() {
	const form = pop && pop.querySelector('form.pf');
	if (form && !form.dataset.done) { vscode.postMessage({ type: 'formCancel', form: form.dataset.form }); }
	if (pop) { pop.remove(); }
	const open = popKey && document.querySelector('[data-chip="' + CSS.escape(popKey) + '"]');
	if (open) { open.classList.remove('open'); }
	pop = null;
	popKey = null;
}
function placeMenu() {
	const anchor = pop && document.querySelector('[data-chip="' + CSS.escape(popKey) + '"]');
	if (!anchor) { return; }
	const r = anchor.getBoundingClientRect();
	const w = pop.offsetWidth, h = pop.offsetHeight;
	// The usable width: innerWidth counts the scrollbar, which would cover the popover's edge.
	const vw = document.documentElement.clientWidth || window.innerWidth;
	pop.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
	if (r.top - h - 6 >= 8 || r.top > window.innerHeight - r.bottom) { pop.style.top = ''; pop.style.bottom = (window.innerHeight - r.top + 6) + 'px'; }
	else { pop.style.bottom = ''; pop.style.top = (r.bottom + 6) + 'px'; }
}
function showMenu(key, html) {
	const anchor = document.querySelector('[data-chip="' + CSS.escape(key) + '"]');
	if (!anchor) { return; }
	if (popKey !== key) { closeMenu(); }
	if (!pop) { pop = document.createElement('div'); pop.className = 'pop'; pop.setAttribute('role', 'menu'); document.body.appendChild(pop); }
	popKey = key;
	anchor.classList.add('open');
	const old = pop.querySelector('form.pf');
	if (old && !old.dataset.done) { vscode.postMessage({ type: 'formCancel', form: old.dataset.form }); }
	pop.innerHTML = html;
	const form = pop.querySelector('form.pf');
	pop.classList.toggle('wide', !!form);
	placeMenu();
	if (form) { wireForm(form, m => vscode.postMessage(m)); placeMenu(); return; }
	const first = pop.querySelector('.mi.on') || pop.querySelector('.mi');
	if (first) { first.focus(); }
}
document.addEventListener('mousedown', e => { if (pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest('[data-chip="' + CSS.escape(popKey) + '"]'))) { closeMenu(); } });
window.addEventListener('resize', () => { if (pop) { placeMenu(); } });
document.addEventListener('keydown', e => {
	if (!pop) { return; }
	if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const key = popKey; closeMenu(); const a = document.querySelector('[data-chip="' + CSS.escape(key) + '"]'); if (a) { a.focus(); } return; }
	if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !(e.target.closest && e.target.closest('.pf'))) {
		e.preventDefault();
		const items = [...pop.querySelectorAll('.mi')];
		const i = items.indexOf(document.activeElement);
		const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
		if (next) { next.focus(); }
	}
}, true);
let addCard = null;
function renderCards() {
	const el = $('cards');
	el.replaceChildren(...cards.map(c => {
		const b = document.createElement('button');
		b.className = 'card' + (selected.includes(c.id) ? ' on' : '') + (c.ready ? '' : ' off');
		b.dataset.chip = 'card:' + c.id;
		b.innerHTML = c.html;
		b.addEventListener('click', e => {
			if (e.target.closest('[data-fix]') || !c.ready) { openMenu('card:' + c.id, { menu: 'fix', agentId: c.id }); return; }
			selected = selected.includes(c.id) ? selected.filter(x => x !== c.id) : [...selected, c.id];
			vscode.setState({ ...(vscode.getState() || {}), selected });
			renderCards();
			renderNewChips();
		});
		return b;
	}));
	if (!cards.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = strings.noAgents || ''; el.replaceChildren(p); }
	if (addCard) {
		const b = document.createElement('button');
		b.className = 'card addc';
		b.dataset.chip = 'card:+add';
		b.setAttribute('aria-haspopup', 'menu');
		const t = document.createElement('div'); t.className = 'top'; t.textContent = addCard.label;
		const s = document.createElement('div'); s.className = 'sub2'; s.textContent = addCard.detail || '';
		b.append(t, s);
		b.addEventListener('click', () => openMenu('card:+add', { menu: 'acp' }));
		el.appendChild(b);
	}
	keepMenu();
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
	const loading = atts.some(a => !a.path);
	if (mode === 'thread') { send.disabled = loading && !busy; } else { send.disabled = loading || !(selected || []).length; }
}
function grow() { input.style.height = 'auto'; input.style.height = Math.min(240, input.scrollHeight) + 'px'; }
// Files pasted or dropped into the composer: kept in the room's folder by the extension, sent as @file references.
let atts = [];
const MAX_FILE = 25 * 1024 * 1024;
const fileRef = p => '@file:' + (/[\\s"]/.test(p) ? '"' + p.replace(/"/g, '') + '"' : p);
function saveAtts() { vscode.setState({ ...(vscode.getState() || {}), atts: atts.filter(a => a.path).map(a => ({ id: a.id, name: a.name, kind: a.kind, path: a.path, url: a.url })) }); }
function renderAtts() {
	$('atts').replaceChildren(...atts.map(a => {
		const el = document.createElement('div');
		el.className = 'att2 ' + a.kind + (a.path ? '' : ' busy');
		el.title = a.path || a.name;
		if (a.kind === 'image' && (a.url || a.preview)) {
			const img = document.createElement('img');
			img.src = a.url || a.preview;
			img.alt = a.name;
			el.appendChild(img);
		} else {
			el.insertAdjacentHTML('beforeend', ${JSON.stringify(ICONS.file)});
			const n = document.createElement('span');
			n.textContent = a.name;
			el.appendChild(n);
		}
		const rm = document.createElement('button');
		rm.className = 'rm';
		rm.title = strings.remove || '';
		rm.setAttribute('aria-label', rm.title);
		rm.innerHTML = ${JSON.stringify(ICONS.close)};
		rm.addEventListener('click', () => {
			atts = atts.filter(x => x !== a);
			if (a.path) { vscode.postMessage({ type: 'detach', path: a.path }); }
			renderAtts();
			saveAtts();
		});
		el.appendChild(rm);
		return el;
	}));
	updateSend();
}
function addFiles(files) {
	for (const file of files) {
		if (file.size > MAX_FILE) { vscode.postMessage({ type: 'tooBig', name: file.name }); continue; }
		const a = { id: Math.random().toString(36).slice(2), name: file.name || 'image', kind: /^image\\//.test(file.type) ? 'image' : 'file' };
		atts.push(a);
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result || '');
			if (a.kind === 'image') { a.preview = url; renderAtts(); }
			vscode.postMessage({ type: 'attachFile', id: a.id, name: file.name || '', mime: file.type || '', data: url.slice(url.indexOf(',') + 1) });
		};
		reader.onerror = () => { atts = atts.filter(x => x !== a); renderAtts(); };
		reader.readAsDataURL(file);
	}
	renderAtts();
}
input.addEventListener('paste', e => {
	const files = [...(e.clipboardData ? e.clipboardData.items : [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
	if (files.length) { e.preventDefault(); addFiles(files); }
});
const boxEl = $('box');
boxEl.addEventListener('dragover', e => { e.preventDefault(); boxEl.classList.add('drop'); });
boxEl.addEventListener('dragleave', e => { if (!boxEl.contains(e.relatedTarget)) { boxEl.classList.remove('drop'); } });
boxEl.addEventListener('drop', e => {
	e.preventDefault();
	boxEl.classList.remove('drop');
	const dt = e.dataTransfer;
	if (!dt) { return; }
	const uris = (dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || '').split(/\\r?\\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
	if (uris.length) { vscode.postMessage({ type: 'dropUris', uris }); return; }
	if (dt.files && dt.files.length) { addFiles([...dt.files]); }
});
function submit() {
	if (busy && mode === 'thread') { vscode.postMessage({ type: 'stop' }); return; }
	if (atts.some(a => !a.path)) { return; }
	const refs = atts.map(a => fileRef(a.path)).join(' ');
	const typed = input.value;
	if (!typed.trim() && !refs) { return; }
	const text = typed.trim() ? (refs ? typed.replace(/\\s+$/, '') + '\\n\\n' + refs : typed) : refs;
	if (mode === 'new') {
		if (!selected.length) { return; }
		vscode.postMessage({ type: 'start', text, agents: selected });
	} else {
		vscode.postMessage({ type: 'send', text });
	}
	input.value = '';
	atts = [];
	renderAtts();
	grow();
	vscode.setState({ ...(vscode.getState() || {}), draft: '', atts: [] });
}
const lightbox = $('lightbox'), lbImg = $('lbImg');
function openImage(src, alt) { lbImg.src = src; lbImg.alt = alt || ''; lightbox.classList.add('on'); $('lbClose').focus(); }
function closeImage() { lightbox.classList.remove('on'); lbImg.removeAttribute('src'); }
lightbox.addEventListener('click', e => { if (e.target !== lbImg) { closeImage(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && lightbox.classList.contains('on')) { e.preventDefault(); e.stopPropagation(); closeImage(); input.focus(); } }, true);
input.addEventListener('keydown', e => {
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) { submit(); } }
});
input.addEventListener('input', () => { grow(); vscode.setState({ ...(vscode.getState() || {}), draft: input.value }); });
send.addEventListener('click', submit);
$('attach').addEventListener('click', () => openMenu('attach', { menu: 'attach' }));
document.addEventListener('click', e => {
	const item = e.target.closest('.pop .mi[data-action]');
	if (item) {
		let action = {};
		try { action = JSON.parse(item.dataset.action); } catch { /* not a choice */ }
		if (action.type === 'menu') { const key = popKey; showMenu(key, '<div class="mh"></div>'); pop.firstChild.textContent = strings.loading || '…'; vscode.postMessage({ ...action, anchor: key }); return; }
		closeMenu();
		if (action.type) { vscode.postMessage(action); }
		input.focus();
		return;
	}
	if (e.target.closest('.pop')) { return; }
	const thumb = e.target.closest('img.thumb');
	if (thumb) { openImage(thumb.currentSrc || thumb.src, thumb.alt); return; }
	const code = e.target.closest('[data-copycode]');
	if (code) {
		const pre = code.parentElement && code.parentElement.querySelector('pre');
		vscode.postMessage({ type: 'copyText', text: pre ? pre.innerText : '' });
		code.classList.add('done');
		code.innerHTML = ${JSON.stringify(ICONS.check)};
		setTimeout(() => { code.classList.remove('done'); code.innerHTML = ${JSON.stringify(COPY_ICON)}; }, 1200);
		return;
	}
	const copy = e.target.closest('[data-copy]');
	if (copy) { vscode.postMessage({ type: 'copy', id: copy.dataset.copy }); }
	const btn = e.target.closest('[data-button]');
	if (btn) { vscode.postMessage({ type: 'button', index: Number(btn.dataset.button) }); }
	const cont = e.target.closest('[data-continue]');
	if (cont) { cont.disabled = true; vscode.postMessage({ type: 'continueOn', agentId: cont.dataset.continue, to: cont.dataset.to }); }
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
		showDown();
	} else if (m.type === 'new') {
		if (mode !== 'new') { setMode('new'); }
		strings = m.strings || strings;
		cards = m.cards;
		addCard = m.addCard || null;
		const kept = (vscode.getState() || {}).selected;
		if (selected === null || m.reset) { selected = (m.reset ? m.selected : kept || m.selected).filter(id => cards.some(c => c.id === id && c.ready)); }
		// Nothing kept that can run: the first agent that is ready, so the page can be used at once.
		if (!selected.length) { const first = cards.find(c => c.ready); if (first) { selected = [first.id]; } }
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
	} else if (m.type === 'menu') {
		if (popKey === m.anchor) { showMenu(m.anchor, m.html || ''); }
	} else if (m.type === 'openMenu') {
		pendingOpen = { anchor: m.anchor, req: { menu: m.menu, ...(m.agentId ? { agentId: m.agentId } : {}) } };
		if (popKey === m.anchor) { closeMenu(); }
		keepMenu();
	} else if (m.type === 'formError') {
		const form = pop && pop.querySelector('form.pf[data-form="' + CSS.escape(m.form) + '"]');
		if (form) { formError(form, m.field, m.message); }
	} else if (m.type === 'formDone') {
		const form = pop && pop.querySelector('form.pf[data-form="' + CSS.escape(m.form) + '"]');
		if (form) { form.dataset.done = '1'; closeMenu(); input.focus(); }
	} else if (m.type === 'attached') {
		const a = atts.find(x => x.id === m.id);
		if (a && m.path) { a.path = m.path; a.url = m.url || ''; a.name = m.name || a.name; if (a.url) { a.preview = undefined; } }
		else if (a) { atts = atts.filter(x => x !== a); }
		renderAtts();
		saveAtts();
	}
	for (const b of document.querySelectorAll('.cpy:not([title])')) { b.title = strings.copy || ''; b.setAttribute('aria-label', b.title); }
});
setMode(mode);
const st = vscode.getState() || {};
if (st.draft) { input.value = st.draft; grow(); }
if (Array.isArray(st.atts) && st.atts.length) { atts = st.atts.filter(a => a && a.path); renderAtts(); }
if (document.body.dataset.room) { vscode.setState({ ...st, roomId: document.body.dataset.room, mode: 'thread' }); }
vscode.postMessage({ type: 'ready' });
input.focus();
`;

/** The right panel's words for the project's shared rules and memory, already translated. */
export interface SharedStrings {
	readonly heading: string;
	readonly projectRules: string;
	readonly agentsMd: string;
	readonly userRules: string;
	readonly projectMemory: string;
	readonly userMemory: string;
	readonly remember: string;
	/** The remember form (a textarea, Remember and Cancel). */
	readonly form: FormSpec;
}

/** The shared rules and memory under the thread's sections: files to open, and a line every agent should know. Built once, so a half-written line survives the redraws. */
function sharedHtml(s: SharedStrings): string {
	const row = (key: string, label: string, project: boolean) => `<button class="rr" data-shared="${key}"${project ? ' data-project' : ''}>${ICONS.file}<span class="n">${escapeHtml(label)}</span></button>`;
	return `<div id="shared"><div class="hr"></div><div class="rh">${escapeHtml(s.heading)}</div>`
		+ row('projectRules', s.projectRules, true) + row('agentsMd', s.agentsMd, true) + row('userRules', s.userRules, false)
		+ row('projectMemory', s.projectMemory, true) + row('userMemory', s.userMemory, false)
		+ `<button class="rr" data-remember>${ICONS.plus}<span class="n">${escapeHtml(s.remember)}</span></button>`
		+ `<div id="rememberBox" hidden>${formHtml(s.form)}</div><div id="sharedNote" class="empty" hidden></div></div>`;
}

/** The right panel's page: sections filled by messages, so its scroll stays. */
export function detailsPage(nonce: string, fonts?: PageFonts, shared?: SharedStrings): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';${fontSrc(fonts)} script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${fontFaces(fonts)}${BASE_CSS}${FORM_CSS}
#rememberBox .pf { padding: 4px 4px 8px; min-width: 0; }
[hidden] { display: none !important; }
body { padding: 6px 10px 16px; }
.rh { color: var(--mute); font-size: 12.5px; font-weight: 500; padding: 10px 4px 6px; }
.rr { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 0 4px; font-size: 13px; white-space: nowrap; border-radius: 6px; }
button.rr { width: 100%; text-align: left; }
button.rr:hover { background: var(--hover); }
.rr svg { width: 15px; height: 15px; color: var(--mute); flex: none; }
.rr .n { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.rr .k { color: var(--dim); font-size: 12px; }
.rr.mut { color: var(--mute); }
.rr .add { color: var(--vscode-gitDecoration-addedResourceForeground, #2f9e5b); }
.rr .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #d64545); }
/* The agents' dots, the same as the left bar's: runs (pulses), waits for you, stuck; idle and done are quiet. */
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; position: relative; opacity: .55; }
.dot.working, .dot.waiting, .dot.error, .dot.queued { opacity: 1; }
.dot.working { background: var(--vscode-charts-yellow, #d99a1e); }
.dot.working::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: dotpulse 1.6s ease-out infinite; }
@keyframes dotpulse { from { transform: scale(1); opacity: .55; } to { transform: scale(2.4); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .dot.working::after { animation: none; } }
.dot.queued { background: color-mix(in srgb, var(--vscode-charts-yellow, #d99a1e) 45%, transparent); }
.dot.waiting { background: var(--vscode-charts-red, #d64545); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-charts-red, #d64545) 22%, transparent); }
.dot.error { width: 11px; height: 11px; background: var(--vscode-charts-red, #d64545); }
.dot.error::before { content: "!"; position: absolute; inset: 0; display: grid; place-items: center; font-size: 8.5px; font-weight: 700; color: var(--vscode-sideBar-background, #fff); line-height: 1; }
.hr { height: 1px; background: var(--line); margin: 8px 0; }
.bar { width: 44px; height: 5px; border-radius: 3px; background: var(--line2); overflow: hidden; flex: none; }
.bar b { display: block; height: 100%; background: var(--accent); }
.bar.warn b { background: var(--warn); }
.bar.crit b { background: var(--err); }
.meter { display: flex; flex-direction: column; gap: 5px; padding: 6px 4px; font-size: 13px; }
.meter .top { display: flex; align-items: baseline; gap: 8px; }
.meter .top .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meter .top b { font-weight: 500; font-variant-numeric: tabular-nums; }
.meter .bar { width: 100%; }
.meter .sub { color: var(--dim); font-size: 11.5px; }
.st { font-size: 12px; font-weight: 600; width: 14px; text-align: center; flex: none; }
.st.A { color: var(--ok); } .st.M { color: var(--warn); } .st.D { color: var(--err); }
.empty { color: var(--mute); padding: 4px; font-size: 12.5px; }
</style></head><body><div id="root"></div>${shared ? sharedHtml(shared) : ''}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
${FORM_CLIENT}
const box = document.getElementById('rememberBox'), note = document.getElementById('sharedNote');
const form = box && box.querySelector('form.pf');
let wired = false;
function openRemember() {
	if (!box) { return; }
	box.hidden = false;
	note.hidden = true;
	if (!wired) { wired = true; wireForm(form, m => { if (m.type === 'formCancel') { box.hidden = true; return; } vscode.postMessage(m); }); }
	const t = form.querySelector('textarea'); if (t) { t.focus(); }
}
window.addEventListener('message', e => {
	const m = e.data;
	if (m.type === 'render') {
		document.getElementById('root').innerHTML = m.html;
		for (const b of document.querySelectorAll('[data-w]')) { b.style.width = b.dataset.w + '%'; }
		for (const b of document.querySelectorAll('[data-project]')) { b.hidden = !m.project; }
	} else if (m.type === 'rememberOpen') {
		openRemember();
	} else if (m.type === 'formError' && form) {
		formError(form, m.field, m.message);
	} else if (m.type === 'formDone' && form) {
		form.reset();
		form.dataset.busy = '';
		box.hidden = true;
		if (m.note) { note.textContent = m.note; note.hidden = false; }
	}
});
document.addEventListener('click', e => {
	const b = e.target.closest('[data-change]'); if (b) { vscode.postMessage({ type: 'change', index: Number(b.dataset.change) }); return; }
	const s = e.target.closest('[data-shared]'); if (s) { vscode.postMessage({ type: 'shared', file: s.dataset.shared }); return; }
	if (e.target.closest('[data-remember]')) { if (box.hidden) { openRemember(); } else { box.hidden = true; } }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

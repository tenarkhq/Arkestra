/*---------------------------------------------------------------------------------------------
 *  Arkestra. Token, context and quota figures per room and agent (AR25): what the agents
 *  report, added up per room, and the rings that show them. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import type { Usage } from './agent';

export interface AgentUsage {
	/** This room's totals for the agent. */
	readonly input: number;
	readonly output: number;
	readonly cached: number;
	readonly costUsd?: number;
	/** The last reported context fill and quota windows. */
	readonly context?: { readonly used: number; readonly window?: number };
	readonly limits?: Usage['limits'];
}

/** Adds one report to the room's figures for the agent. */
export function addUsage(prev: AgentUsage | undefined, u: Usage): AgentUsage {
	const context = u.context ?? prev?.context;
	const limits = u.limits ?? prev?.limits;
	return {
		input: (prev?.input ?? 0) + (u.input ?? 0),
		output: (prev?.output ?? 0) + (u.output ?? 0),
		cached: (prev?.cached ?? 0) + (u.cached ?? 0),
		...(prev?.costUsd !== undefined || u.costUsd !== undefined ? { costUsd: (prev?.costUsd ?? 0) + (u.costUsd ?? 0) } : {}),
		...(context ? { context } : {}),
		...(limits ? { limits } : {}),
	};
}

/** Context fill in percent, when the window is known. */
export function contextPercent(u: AgentUsage | undefined): number | undefined {
	const c = u?.context;
	return c?.window ? Math.min(100, Math.round((c.used / c.window) * 100)) : undefined;
}

/** The fullest quota window. */
export function tightestLimit(u: AgentUsage | undefined): NonNullable<Usage['limits']>[number] | undefined {
	return u?.limits?.length ? u.limits.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)) : undefined;
}

/** What the right panel shows for one agent: how full its context is and its account's quota. */
export interface AgentMeter {
	/** Tokens in the context, and the window when known (then a percentage shows). */
	readonly context?: { readonly used: number; readonly window?: number };
	readonly limits: NonNullable<Usage['limits']>;
}

/**
 * An agent's meter out of what is known: the claude.ai account's report of a session the Claude
 * app runs, a turn run here, the session file (Codex's tells its window). The quota as the
 * vendor reports it now, else the last one a turn here carried.
 */
export function agentMeter(input: {
	readonly usage?: AgentUsage;
	readonly session?: { readonly context?: number; readonly window?: number };
	readonly cloud?: { readonly used: number; readonly max: number };
	readonly quota?: Usage['limits'];
}): AgentMeter {
	const { usage, session, cloud } = input;
	const context = cloud ? { used: cloud.used, window: cloud.max }
		: usage?.context?.window ? usage.context
			: session?.context && session.window ? { used: session.context, window: session.window }
				: usage?.context ?? (session?.context ? { used: session.context } : undefined);
	const limits = input.quota?.length ? input.quota : usage?.limits ?? [];
	return { ...(context ? { context } : {}), limits };
}

/** The tone of a quota: calm under 80 %, warning to 95 %, then critical. */
export function quotaTone(percent: number): 'ok' | 'warn' | 'crit' {
	return percent >= 95 ? 'crit' : percent >= 80 ? 'warn' : 'ok';
}

/** 12345 → 12.3k, 2_400_000 → 2.4M. */
export function formatTokens(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The tone of a fill level: calm under 70 %, warning to 90 %, then critical. */
export function tone(percent: number): 'ok' | 'warn' | 'crit' {
	return percent >= 90 ? 'crit' : percent >= 70 ? 'warn' : 'ok';
}

/** A small ring for a percentage; colours come from the page's CSS classes (ok / warn / crit). */
export function ringSvg(percent: number, title: string, size = 22): string {
	const r = size / 2 - 3;
	const c = 2 * Math.PI * r;
	const p = Math.max(0, Math.min(100, percent));
	const t = title.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
	const mid = size / 2;
	return `<svg class="ring ${tone(p)}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${t}"><title>${t}</title>`
		+ `<circle class="track" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke-width="3"/>`
		+ `<circle class="fill" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke-width="3" stroke-dasharray="${((p / 100) * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${mid} ${mid})" stroke-linecap="round"/></svg>`;
}

/** One line for an agent: tokens in and out, cost. */
export function usageLine(u: AgentUsage | undefined): string {
	if (!u || (!u.input && !u.output)) {
		return '';
	}
	return `${formatTokens(u.input)} in · ${formatTokens(u.output)} out${u.costUsd ? ` · $${u.costUsd.toFixed(2)}` : ''}`;
}

/** The status bar text for a room: the fullest context, the fullest quota, the room's tokens. */
export function statusText(usages: readonly (AgentUsage | undefined)[]): string | undefined {
	const known = usages.filter((u): u is AgentUsage => !!u);
	if (!known.length) {
		return undefined;
	}
	const ctx = known.map(contextPercent).filter((p): p is number => p !== undefined);
	const limit = known.map(tightestLimit).filter((l): l is NonNullable<typeof l> => !!l).map(l => l.usedPercent);
	const tokens = known.reduce((n, u) => n + u.input + u.output, 0);
	const text = [ctx.length ? `ctx ${Math.max(...ctx)}%` : '', limit.length ? `quota ${Math.max(...limit)}%` : '', tokens ? `${formatTokens(tokens)} tok` : ''].filter(Boolean).join(' · ');
	return text || undefined;
}

/** A quota window's length as a label: 300 min → 5h, 10080 min → week. */
export function windowLabel(minutes: number | null | undefined): string {
	if (!minutes) {
		return 'limit';
	}
	if (minutes % 10080 === 0) {
		return minutes === 10080 ? 'week' : `${minutes / 10080} weeks`;
	}
	if (minutes % 1440 === 0) {
		return `${minutes / 1440}d`;
	}
	return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

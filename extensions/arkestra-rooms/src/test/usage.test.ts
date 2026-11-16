/*---------------------------------------------------------------------------------------------
 *  Arkestra. Token, context and quota figures: adding up per room, percentages, the ring,
 *  the status bar text; the board keeps the figures across turns.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ActivityBoard } from '../activity';
import { addUsage, agentMeter, contextPercent, formatTokens, quotaTone, ringSvg, statusText, tightestLimit, tone, usageLine, windowLabel } from '../usage';

test('reports add up per room; context and quota are the latest', () => {
	let u = addUsage(undefined, { input: 1000, output: 200, cached: 50, costUsd: 0.01, context: { used: 30_000, window: 200_000 } });
	u = addUsage(u, { input: 500, output: 100, limits: [{ label: '5h', usedPercent: 40 }, { label: 'week', usedPercent: 72 }] });
	assert.deepEqual([u.input, u.output, u.cached, u.costUsd], [1500, 300, 50, 0.01]);
	assert.equal(contextPercent(u), 15);
	assert.deepEqual(tightestLimit(u), { label: 'week', usedPercent: 72 });
	assert.equal(contextPercent(addUsage(undefined, { context: { used: 10 } })), undefined, 'no window, no percent');
	assert.equal(addUsage(undefined, { input: 1 }).costUsd, undefined, 'no cost when nobody reported one');
});

test('numbers and rings read at a glance', () => {
	assert.equal(formatTokens(950), '950');
	assert.equal(formatTokens(12_345), '12.3k');
	assert.equal(formatTokens(2_400_000), '2.4M');
	assert.equal(formatTokens(500_000), '500k');
	assert.equal(formatTokens(1_000_000), '1M');
	assert.deepEqual([tone(10), tone(75), tone(95)], ['ok', 'warn', 'crit']);
	const ring = ringSvg(50, 'Context <50%>');
	assert.match(ring, /class="ring ok"/);
	assert.match(ring, /<title>Context &lt;50%&gt;<\/title>/);
	assert.match(ringSvg(150, 'x'), /class="ring crit"/, 'clamped to 100');
	assert.equal(usageLine(addUsage(undefined, { input: 12_000, output: 800, costUsd: 0.123 })), '12k in · 800 out · $0.12');
	assert.equal(usageLine(undefined), '');
	assert.deepEqual([windowLabel(300), windowLabel(10080), windowLabel(1440), windowLabel(90), windowLabel(null)], ['5h', 'week', '1d', '90m', 'limit']);
});

test('the status bar shows the fullest context, the fullest quota and the room\'s tokens', () => {
	const a = addUsage(undefined, { input: 10_000, output: 2000, context: { used: 50_000, window: 200_000 } });
	const b = addUsage(undefined, { input: 3000, output: 1000, context: { used: 180_000, window: 200_000 }, limits: [{ label: 'week', usedPercent: 64 }] });
	assert.equal(statusText([a, b, undefined]), 'ctx 90% · quota 64% · 16k tok');
	assert.equal(statusText([undefined]), undefined);
});

test('the board keeps an agent\'s figures across turns and state changes', () => {
	const board = new ActivityBoard(() => new Date('2026-11-14T21:00:00Z'));
	board.start('r', 'claude');
	board.usage('r', 'claude', { input: 100, output: 10 });
	board.end('r', 'claude');
	board.start('r', 'claude');
	board.usage('r', 'claude', { input: 50, output: 5, context: { used: 1000, window: 10_000 } });
	assert.deepEqual([board.get('r', 'claude').usage?.input, board.get('r', 'claude').usage?.output], [150, 15]);
	assert.equal(contextPercent(board.get('r', 'claude').usage), 10);
	board.usage('r', 'codex', { limits: [{ label: '5h', usedPercent: 12 }] });
	assert.equal(board.get('r', 'codex').state, 'idle', 'a report alone does not change the state');
});

test('an agent\'s meter: the account\'s report first, then a turn here, then the session file; the live quota before a turn\'s', () => {
	const turn = { input: 1, output: 1, cached: 0, context: { used: 90_000, window: 200_000 }, limits: [{ label: '5h', usedPercent: 10 }] };
	// A session the Claude app runs: the claude.ai account tells the fill and the window.
	assert.deepEqual(agentMeter({ usage: turn, cloud: { used: 115_900, max: 500_000 }, quota: [{ label: 'week', usedPercent: 54 }] }), { context: { used: 115_900, window: 500_000 }, limits: [{ label: 'week', usedPercent: 54 }] });
	// A turn run here knows its window; its quota stands while the vendor's is not read yet.
	assert.deepEqual(agentMeter({ usage: turn, session: { context: 120_000 } }), { context: { used: 90_000, window: 200_000 }, limits: [{ label: '5h', usedPercent: 10 }] });
	// Codex's session file tells its window too.
	assert.deepEqual(agentMeter({ session: { context: 41_200, window: 475_000 }, quota: [] }), { context: { used: 41_200, window: 475_000 }, limits: [] });
	// Only the tokens: no percentage.
	assert.deepEqual(agentMeter({ session: { context: 115_900 } }), { context: { used: 115_900 }, limits: [] });
	assert.deepEqual(agentMeter({}), { limits: [] });
	assert.deepEqual([79, 80, 94, 95].map(quotaTone), ['ok', 'warn', 'warn', 'crit']);
});

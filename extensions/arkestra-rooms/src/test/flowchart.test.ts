/*---------------------------------------------------------------------------------------------
 *  Arkestra. The flowchart renderer: parsing nodes, shapes, chains and labels; layers; SVG.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { flowchartSvg, layers, parseFlowchart } from '../flowchart';

test('a flowchart: direction, node shapes and labels, chains, edge labels, dashed edges', () => {
	const chart = parseFlowchart([
		'flowchart LR',
		'  A[JSON fájl] --> B{Séma ellenőrzés}',
		'  B -->|jó| C(Verzió ellenőrzés) --> D([Strategy objektum])',
		'  B -. hibás .-> E((ImportError))',
		'  B -- hibás --> E',
		'  %% megjegyzés',
		'  style A fill:#fff',
	].join('\n'))!;
	assert.equal(chart.direction, 'LR');
	assert.deepEqual(chart.nodes.map(n => [n.id, n.label, n.shape]), [['A', 'JSON fájl', 'rect'], ['B', 'Séma ellenőrzés', 'diamond'], ['C', 'Verzió ellenőrzés', 'round'], ['D', 'Strategy objektum', 'stadium'], ['E', 'ImportError', 'circle']]);
	assert.deepEqual(chart.edges.map(e => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}${e.dashed ? ':dashed' : ''}`), ['A>B', 'B>C:jó', 'C>D', 'B>E:hibás:dashed', 'B>E:hibás']);
	assert.equal(parseFlowchart('graph TB\nA-->B')!.direction, 'TD');
	assert.equal(parseFlowchart('sequenceDiagram\nA->>B: hi'), undefined);
});

test('layers follow the longest path; a cycle does not loop forever', () => {
	const chart = parseFlowchart('flowchart TD\nA-->B\nB-->C\nA-->C\nC-->A')!;
	const r = layers(chart);
	assert.deepEqual([r.get('A'), r.get('B'), r.get('C')], [0, 1, 2]);
});

test('the SVG has a box per node, a line per edge, escaped labels', () => {
	const svg = flowchartSvg(parseFlowchart('flowchart LR\nA[a < b] --> B["kész"]')!);
	assert.equal((svg.match(/class="node"/g) ?? []).length, 2);
	assert.equal((svg.match(/class="edge"/g) ?? []).length, 1);
	assert.match(svg, />a &lt; b</);
	assert.match(svg, />kész</);
	assert.match(svg, /^<svg class="flowchart"/);
});

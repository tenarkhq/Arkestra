/*---------------------------------------------------------------------------------------------
 *  Arkestra. The Board and Table views' page (AR30). The extension posts the board model; the
 *  page draws it and posts back what the user does (move, edit, new issue, start a room). One
 *  header and one filter row for every view (Board, Table, Plan, Graph: the same filters, kept
 *  when the view changes); a click on a card, row, staircase cell or graph node opens the
 *  details pane on the right. Completion reads green (done) and blue (open), never the accent;
 *  the critical path is the only red.
 *  Drawn with DOM calls, never with HTML strings from data.
 *--------------------------------------------------------------------------------------------*/

import { tableLogic } from './board';

const STYLE = String.raw`
:root {
	--gap: 10px; --radius: 6px;
	--line: var(--vscode-panel-border, rgba(128, 128, 128, .22));
	--line2: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, .3)));
	--mute: var(--vscode-descriptionForeground);
	--dim: color-mix(in srgb, var(--vscode-descriptionForeground) 72%, transparent);
	--hover: var(--vscode-list-hoverBackground);
	--sel: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
	--ok: var(--vscode-testing-iconPassed, #3fb950);
	--warn: var(--vscode-editorWarning-foreground, #cca700);
	--bad: var(--vscode-errorForeground, #f85149);
	--run: var(--vscode-charts-blue, #3794ff);
	/* Completion: done green, open work blue; never the accent (coral in Arkestra Dark), so red stays the critical path's. */
	--done: var(--vscode-testing-iconPassed, #3fb950);
	--prog: var(--vscode-charts-blue, #3794ff);
	--crit: var(--vscode-testing-iconFailed, #f85149);
	--selline: color-mix(in srgb, var(--vscode-foreground) 60%, transparent);
	--panel: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 400 13px/1.4 "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; display: flex; flex-direction: column; overflow: hidden; }
button, select, input { font: inherit; color: inherit; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 4px; padding: 3px 9px; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:hover { filter: brightness(1.1); }
select, input { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 2px 6px; }
select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
header { position: relative; z-index: 3; flex: none; background: var(--vscode-editor-background); display: flex; flex-direction: column; }
.top { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--line); }
.top .name { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; overflow: hidden; }
.top .title { font-weight: 500; font-size: 14px; color: var(--vscode-foreground); white-space: nowrap; }
.top .sub { color: var(--dim); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub .warn { color: var(--warn); } .sub .bad { color: var(--bad); }
.sub .live::before { content: '●'; color: var(--ok); font-size: 9px; margin-right: 5px; vertical-align: 1px; }
.seg { display: inline-flex; border: 1px solid var(--line2); border-radius: 8px; padding: 2px; gap: 2px; flex: none; }
.seg button { background: transparent; color: var(--mute); padding: 3px 10px; border-radius: 6px; font-size: 12.5px; }
.seg button.on { background: var(--sel); color: var(--vscode-foreground); }
.pri { height: 26px; padding: 0 10px; border-radius: 7px; font-size: 12.5px; font-weight: 500; white-space: nowrap; flex: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.icon { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 6px; background: transparent; color: var(--mute); padding: 0; flex: none; }
.icon:hover, .icon.on { background: var(--sel); color: var(--vscode-foreground); filter: none; }
.anchor { position: relative; display: inline-flex; }
.menu { position: absolute; z-index: 5; top: calc(100% + 4px); right: 0; min-width: 196px; max-height: 70vh; overflow-y: auto; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--line2)); border-radius: 10px; padding: 5px; box-shadow: 0 10px 30px var(--vscode-widget-shadow, rgba(0, 0, 0, .35)); display: flex; flex-direction: column; }
.menu.left { left: 0; right: auto; }
.menu .mh { color: var(--dim); font-size: 12px; padding: 6px 10px 4px; }
.mi { display: flex; justify-content: space-between; align-items: center; gap: 14px; min-height: 30px; padding: 0 10px; border-radius: 6px; font-size: 13px; background: transparent; color: inherit; text-align: left; width: 100%; white-space: nowrap; }
.mi:hover { background: var(--vscode-menu-selectionBackground, var(--sel)); color: var(--vscode-menu-selectionForeground, inherit); filter: none; }
.mi span { color: var(--mute); }
.msep { height: 1px; background: var(--line); margin: 4px 2px; }
.filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 14px 18px 12px; }
.fchip { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--line2); color: var(--vscode-foreground); background: transparent; font-size: 12.5px; white-space: nowrap; }
.fchip select { appearance: none; -webkit-appearance: none; background: transparent; border: 0; padding: 0 12px 0 0; margin: 0; color: inherit; font-size: inherit; cursor: pointer; outline: none; max-width: 240px; text-overflow: ellipsis; }
.fchip .chev { margin-left: -14px; pointer-events: none; color: var(--mute); font-size: 11px; }
.fchip.off { color: var(--mute); }
.fchip.search { width: 190px; color: var(--dim); }
.fchip.search input { flex: 1; min-width: 0; background: transparent; border: 0; padding: 0; outline: none; color: var(--vscode-foreground); }
.fchip.search input::placeholder { color: var(--dim); }
.fchip.add { color: var(--mute); border-style: dashed; cursor: pointer; }
.fchip.ghost { border-color: transparent; color: var(--mute); cursor: pointer; }
.fchip .x { background: transparent; padding: 0 0 0 2px; color: var(--mute); line-height: 1; }
.fchip .x:hover { color: var(--vscode-foreground); }
.area { flex: 1; min-height: 0; display: flex; position: relative; }
main { flex: 1; min-width: 0; overflow: auto; padding: 12px 14px; }
main.table { padding: 0 18px; }
.muted { color: var(--mute); }
.spacer { flex: 1; }
.pin.on { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.title { font-weight: 600; font-size: 14px; }
.tbl { display: flex; flex-direction: column; border-top: 1px solid var(--line); }
.tr { display: grid; grid-template-columns: var(--cols); gap: 12px; align-items: center; min-height: 38px; padding: 0 8px; border-bottom: 1px solid var(--line); font-size: 13px; }
.tr:not(.th) { cursor: default; }
.tr:not(.th):hover { background: var(--hover); }
.tr > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.tr > span select, .tr > span input { width: 100%; }
.tr.th { position: sticky; top: 0; z-index: 1; min-height: 32px; color: var(--dim); font-size: 12px; background: var(--vscode-editor-background); }
.tr.th > span { cursor: pointer; user-select: none; }
.tr.sel, .tr.sel:hover { background: var(--sel); }
.num { color: var(--dim); font-variant-numeric: tabular-nums; }
.t-muted { color: var(--mute); } .t-none { color: var(--dim); } .t-ok { color: var(--ok); } .t-warn { color: var(--warn); } .t-run { color: var(--run); }
.pill { font-style: normal; font-size: 11.5px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.pill.t-none { padding-left: 0; }
.pill.t-muted { background: color-mix(in srgb, var(--mute) 14%, transparent); }
.pill.t-warn { background: color-mix(in srgb, var(--warn) 14%, transparent); }
.pill.t-ok { background: color-mix(in srgb, var(--ok) 14%, transparent); }
.pill.t-run { background: color-mix(in srgb, var(--run) 16%, transparent); }
.grp { display: flex; gap: 8px; align-items: center; padding: 12px 8px 6px; color: var(--mute); font-size: 12px; font-weight: 500; }
.grp em { font-style: normal; color: var(--dim); font-weight: 400; }
.nothing { padding: 28px 8px; color: var(--mute); }
.details { flex: 0 0 330px; min-width: 0; background: var(--panel); border-left: 1px solid var(--line); padding: 16px 14px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
.details .dh { display: flex; justify-content: space-between; align-items: center; color: var(--mute); font-size: 12.5px; font-weight: 500; padding: 0 0 6px 4px; }
.details .dtitle { font-size: 15px; font-weight: 500; line-height: 1.4; padding: 0 4px 8px; overflow-wrap: anywhere; }
.dkv { display: flex; justify-content: space-between; align-items: center; gap: 10px; min-height: 30px; padding: 0 4px; font-size: 13px; }
.dkv > .k { color: var(--mute); flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dkv > .v { min-width: 0; display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 4px; text-align: right; }
.dkv select, .dkv input { background: transparent; border: 1px solid transparent; border-radius: 5px; padding: 2px 4px; max-width: 190px; text-align: right; color: inherit; }
.dkv select { appearance: none; -webkit-appearance: none; text-align-last: right; cursor: pointer; }
.dkv select:hover, .dkv input:hover, .dkv select:focus, .dkv input:focus { border-color: var(--line2); outline: none; }
.dkv .chev { color: var(--mute); font-size: 11px; pointer-events: none; }
.dkv input.t-warn { color: var(--warn); } .dkv input.t-ok { color: var(--ok); }
.hr { height: 1px; background: var(--line); margin: 8px 0; flex: none; }
.dacts { display: flex; gap: 8px; flex-wrap: wrap; padding: 4px; }
.dacts button { height: 26px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--line2); background: transparent; color: var(--vscode-foreground); font-size: 12.5px; }
.dacts button.primary { border-color: transparent; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
@media (max-width: 760px) { .details { position: absolute; top: 0; right: 0; bottom: 0; width: min(330px, 100%); box-shadow: -8px 0 24px var(--vscode-widget-shadow, rgba(0, 0, 0, .3)); } }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 10px; font-size: 11px; line-height: 18px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
.tone-ok { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 22%, transparent); color: var(--vscode-foreground); }
.tone-bad { background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 25%, transparent); color: var(--vscode-foreground); }
.tone-run { background: color-mix(in srgb, var(--run) 25%, transparent); color: var(--vscode-foreground); }
.tone-warn { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 25%, transparent); color: var(--vscode-foreground); }
.tone-muted { background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: currentColor; }
.board { display: flex; gap: var(--gap); align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
.col { flex: 0 0 272px; width: 272px; min-width: 0; background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background)); border-radius: var(--radius); display: flex; flex-direction: column; max-height: calc(100vh - 150px); }
.col.drop { outline: 2px dashed var(--vscode-focusBorder); }
.col h3 { margin: 0; padding: 8px 10px; font-size: 12px; font-weight: 600; display: flex; gap: 6px; align-items: center; }
.cards { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 8px 9px; display: flex; flex-direction: column; gap: 5px; cursor: pointer; }
.card:hover { border-color: var(--line2); }
.card.sel { border-color: var(--selline); }
.card.dragging { opacity: .4; }
/* A long prerequisite list wraps inside the card; the column keeps its width. */
.card .chip { white-space: normal; overflow-wrap: anywhere; max-width: 100%; line-height: 16px; padding: 1px 7px; }
.card { min-width: 0; }
.card .top { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; min-height: 0; padding: 0; border-bottom: 0; } /* not the header's .top */
.card .num { color: var(--vscode-descriptionForeground); font-size: 12px; }
.card .name { font-weight: 500; }
.kv { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; font-size: 12px; }
.kv span:nth-child(odd) { color: var(--vscode-descriptionForeground); }
.chips { display: flex; gap: 4px; flex-wrap: wrap; }
.more { margin: 0 8px 8px; }
.form { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); }
header .form { margin: 10px 18px 0; }
.empty { flex: 1; }
.form input.wide { flex: 1; min-width: 200px; }
.empty { padding: 40px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.picker { width: min(560px, 100%); display: flex; flex-direction: column; gap: 10px; text-align: left; }
.plist { display: flex; flex-direction: column; gap: 2px; max-height: 46vh; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 4px; }
.plist .pick { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; text-align: left; background: transparent; color: var(--vscode-foreground); padding: 7px 10px; border-radius: 6px; }
.plist .pick:hover, .plist .pick:focus-visible { background: var(--vscode-list-hoverBackground); outline: none; filter: none; }
.plist .pick.on { background: var(--vscode-list-inactiveSelectionBackground); }
.plist .pt { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plist .pd { color: var(--mute); font-size: 12px; white-space: nowrap; }
.perr { color: var(--vscode-errorForeground); font-size: 12px; }
footer { border-top: 1px solid var(--vscode-panel-border); margin-top: 12px; padding: 8px 14px 14px; }
footer summary { cursor: pointer; font-weight: 600; font-size: 12px; }
.log { display: grid; grid-template-columns: auto auto 1fr; gap: 2px 10px; font-size: 12px; margin-top: 6px; }
.log .err { color: var(--vscode-errorForeground); }
.plan { display: flex; flex-direction: column; gap: 18px; }
.plan h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 4px; color: var(--vscode-descriptionForeground); }
.plan .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 8px; max-width: 70ch; }
.lanes { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--gap); }
.lane { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.lane.development { border-color: color-mix(in srgb, var(--prog) 55%, var(--vscode-panel-border)); }
.lane .name { font-weight: 600; font-size: 14px; }
.bar { height: 6px; border-radius: 3px; background: var(--vscode-editorWidget-background); overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--done); }
.rails { display: flex; flex-direction: column; gap: 10px; }
.rail { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 8px 10px; min-width: 0; }
.rail .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.rail .branch { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.steps { display: flex; gap: 0; overflow-x: auto; margin-top: 8px; padding-bottom: 4px; }
.step { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 0 14px 0 0; position: relative; max-width: 220px; }
.step::before { content: ''; position: absolute; left: 0; right: 0; top: 5px; height: 2px; background: var(--vscode-panel-border); }
.step .pin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--vscode-panel-border); background: var(--vscode-editor-background); position: relative; }
.step.done .pin { background: var(--done); border-color: var(--done); }
.step.now .pin { border-color: var(--prog); background: var(--prog); }
.step .lbl { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; }
.step .sub { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; }
.stairs-wrap { overflow-x: auto; }
.stairs { display: grid; gap: 4px 6px; align-items: center; justify-content: start; }
.stairs .lv { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; }
.stairs .lanehead { grid-column: 1 / -1; font-weight: 600; font-size: 12px; margin-top: 8px; }
.cell { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 6px; font-size: 12px; position: relative; overflow: hidden; cursor: pointer; white-space: nowrap; text-overflow: ellipsis; }
.cell > .fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--prog) 24%, transparent); }
.cell > span { position: relative; }
.cell.done { color: var(--mute); border-color: color-mix(in srgb, var(--done) 35%, var(--vscode-panel-border)); }
.cell.done > .fill { background: color-mix(in srgb, var(--done) 16%, transparent); }
.cell.critical { border-color: var(--crit); border-width: 2px; }
.cell.startable { box-shadow: inset 3px 0 0 var(--done); }
.cell.running { box-shadow: inset 3px 0 0 var(--run); }
.cell.sel { outline: 1.5px solid var(--selline); outline-offset: 1px; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.graph-top { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.graph-top button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.graph-body { display: flex; gap: 12px; align-items: flex-start; }
.canvas { flex: 1; min-width: 0; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); max-height: calc(100vh - 190px); background: var(--vscode-editor-background); }
.canvas svg { display: block; touch-action: none; }
.node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border); stroke-width: 1; }
.node.milestone rect { fill: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, var(--vscode-editor-background)); }
.node.done rect { opacity: .7; }
.node.done text { fill: var(--vscode-descriptionForeground); }
.node.critical rect { stroke: var(--crit); stroke-width: 2; }
.node.sel rect { stroke: var(--selline); stroke-width: 2.5; }
.node rect.meter { fill: color-mix(in srgb, var(--vscode-descriptionForeground) 18%, transparent); stroke: none; opacity: 1; }
.node rect.meter-done { fill: color-mix(in srgb, var(--done) 75%, transparent); stroke: none; opacity: 1; }
.node rect.meter-prog { fill: var(--prog); stroke: none; opacity: 1; }
.node text { fill: var(--vscode-foreground); font-size: 12px; pointer-events: none; }
.node text.sub { fill: var(--vscode-descriptionForeground); font-size: 11px; }
.node .stripe-ok { fill: var(--done); }
.node .stripe-bad { fill: var(--crit); }
.node .stripe-run { fill: var(--run); }
.node .stripe-warn { fill: var(--vscode-editorWarning-foreground, #cca700); }
.node { cursor: grab; }
.drawing .node { cursor: crosshair; }
.edge { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.5; cursor: pointer; }
.edge.loose { stroke-dasharray: 5 4; }
.edge.release { stroke-dasharray: 2 4; stroke-width: 1; }
.edge.critical { stroke: var(--crit); stroke-width: 2.5; }
.edge.sel { stroke: var(--selline); stroke-width: 3; }
.edge-hit { fill: none; stroke: transparent; stroke-width: 12; cursor: pointer; }
.ghost { stroke: var(--vscode-focusBorder); stroke-width: 2; stroke-dasharray: 4 3; fill: none; pointer-events: none; }
.side { flex: 0 0 280px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); padding: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.side h4, .facts h4 { margin: 4px 0 0; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.side ul, .facts ul { margin: 0; padding-left: 16px; }
.facts { display: flex; flex-direction: column; gap: 6px; font-size: 12px; padding: 0 4px; }
@media (max-width: 760px) { .graph-body { flex-direction: column; } .side { flex-basis: auto; width: 100%; } }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; border: 1px solid var(--vscode-panel-border); }
`;

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const STRINGS = __STRINGS__;
const LOGIC = (__LOGIC__)();
/** The page's words: the extension sends them in the UI language; English when one is missing. */
const t = (text, ...args) => (STRINGS[text] || text).replace(/\{(\d+)\}/g, (m, i) => args[i] !== undefined ? String(args[i]) : m);
const ui = { tab: saved.tab || 'board', filters: saved.filters || { status: '!done' }, extra: saved.extra || [], search: saved.search || '', open: saved.open || {}, sort: saved.sort || null, columns: saved.columns || null, group: saved.group, selected: saved.selected || null, menu: null, form: false };
let model = null;
let screen = null;
const save = () => vscode.setState(Object.assign({}, vscode.getState(), { tab: ui.tab, filters: ui.filters, extra: ui.extra, search: ui.search, open: ui.open, sort: ui.sort, columns: ui.columns, group: ui.group, selected: ui.selected }));
const post = (m) => vscode.postMessage(m);

function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else if (k === 'style') el.style.cssText = v; // CSSOM: allowed by the page's CSP, a style attribute is not
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	for (const kid of kids.flat(Infinity)) {
		if (kid === undefined || kid === null || kid === false) continue;
		el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	return el;
}
const chip = (text, tone, attrs) => h('span', Object.assign({ class: 'chip' + (tone ? ' tone-' + tone : '') }, attrs || {}), text);

// The rows the filters and the search let through, worked out once per drawing (every view).
let shownRows = [];
let shownIds = new Set();
const visible = (card) => shownIds.has(card.id);
const filtering = () => !!ui.search.trim() || Object.values(ui.filters).some(Boolean);
/** Opens the details pane on an item (any view); the same item again keeps it. */
function select(id) { if (ui.selected !== id) { ui.selected = id; save(); drawMain(); } }
const label = (card) => card.number !== undefined ? '#' + card.number : '';

function roomChip(room) {
	const tone = room.status === 'running' ? 'run' : room.status === 'waiting' ? 'warn' : room.status === 'ended' ? 'muted' : '';
	const progress = room.progress ? ' · ' + room.progress.done + '/' + room.progress.total : '';
	return chip(room.type + ' room · ' + room.phase + progress, tone, { title: room.title, onclick: (e) => { e.stopPropagation(); post({ type: 'openRoom', roomId: room.roomId }); }, style: 'cursor:pointer' });
}
function prereq(card) {
	if (card.blockers.length) {
		const open = card.blockers.filter(b => b.open);
		return open.length ? chip('blocked · ' + open.map(b => b.label).join(', '), 'bad') : chip('prerequisites done · ' + card.blockers.map(b => b.label).join(', '), 'ok');
	}
	return null;
}

function cardEl(card) {
	const fields = model.cardFields.map(id => card.fields.find(f => f.fieldId === id)).filter(Boolean);
	const el = h('div', { class: 'card' + (ui.selected === card.id ? ' sel' : ''), draggable: 'true', 'data-id': card.id, onclick: () => select(card.id) },
		h('div', { class: 'top' }, h('span', { class: 'num' }, label(card) || (card.type === 'draft' ? 'draft' : '')), card.labels.map(l => chip(l)), card.state === 'CLOSED' ? chip('closed', 'muted') : null),
		h('span', { class: 'name' }, card.title),
		fields.length ? h('div', { class: 'kv' }, fields.map(f => [h('span', {}, f.name), h('span', {}, f.value)])) : null,
		h('div', { class: 'chips' },
			prereq(card),
			card.prs.map(p => chip(p.label, p.tone, { onclick: (e) => { e.stopPropagation(); post({ type: 'open', url: p.url }); }, style: 'cursor:pointer' })),
			card.review ? chip(card.review.label, card.review.tone) : null,
			card.comments ? chip(card.comments + ' comments', 'muted') : null,
			card.room ? roomChip(card.room) : null),
		card.startable ? h('div', {}, h('button', { class: 'primary', onclick: (e) => { e.stopPropagation(); post({ type: 'startRoom', itemId: card.id }); } }, 'Start room ▸')) : null);
	el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/arkestra-item', card.id); el.classList.add('dragging'); });
	el.addEventListener('dragend', () => el.classList.remove('dragging'));
	return el;
}

function boardEl() {
	return h('div', { class: 'board' }, model.columns.map(col => {
		const cards = col.cards.filter(visible);
		const limit = col.done && !ui.open[col.id] ? 3 : Infinity;
		const el = h('section', { class: 'col' },
			h('h3', {}, col.color ? h('span', { class: 'dot', style: 'color:' + colour(col.color) }) : null, col.name, h('span', { class: 'muted' }, String(cards.length))),
			h('div', { class: 'cards' }, cards.slice(0, limit).map(cardEl)),
			cards.length > limit ? h('button', { class: 'more', onclick: () => { ui.open[col.id] = true; save(); draw(); } }, '+ ' + (cards.length - limit) + ' more') : null);
		if (col.id) {
			el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/arkestra-item')) { e.preventDefault(); el.classList.add('drop'); } });
			el.addEventListener('dragleave', () => el.classList.remove('drop'));
			el.addEventListener('drop', (e) => {
				e.preventDefault(); el.classList.remove('drop');
				const id = e.dataTransfer.getData('text/arkestra-item');
				const card = model.columns.flatMap(c => c.cards).find(c => c.id === id);
				if (card && card.statusId !== col.id) post({ type: 'move', itemId: id, optionId: col.id });
			});
		}
		return el;
	}));
}
function colour(name) {
	const map = { GRAY: '#8b949e', BLUE: '#3794ff', GREEN: '#3fb950', YELLOW: '#d29922', ORANGE: '#db6d28', RED: '#f85149', PINK: '#db61a2', PURPLE: '#a371f7' };
	return map[name] || 'currentColor';
}

function statusField() {
	return model.statusFieldId ? { id: model.statusFieldId, name: 'Status', type: 'single_select', options: model.columns.filter(c => c.id).map(c => ({ id: c.id, name: c.name })) } : null;
}
function editor(card, field, cls) {
	const cur = field.id === model.statusFieldId ? (card.statusId ? { valueId: card.statusId, value: card.status } : null) : card.fields.find(f => f.fieldId === field.id);
	const send = (value) => post({ type: 'setField', itemId: card.id, fieldId: field.id, value });
	if (field.type === 'single_select' || field.type === 'iteration') {
		const opts = field.type === 'single_select' ? field.options : field.iterations.map(i => ({ id: i.id, name: i.title }));
		const sel = h('select', { class: cls, title: field.name, onchange: () => send(sel.value ? (field.type === 'single_select' ? { optionId: sel.value } : { iterationId: sel.value }) : null) },
			h('option', { value: '' }, '—'), opts.map(o => h('option', { value: o.id, selected: cur && cur.valueId === o.id }, o.name)));
		return sel;
	}
	if (field.type === 'text' || field.type === 'number' || field.type === 'date') {
		const input = h('input', { class: cls, title: field.name, type: field.type === 'text' ? 'text' : field.type, value: cur ? cur.value : '', placeholder: '—' });
		input.addEventListener('change', () => send(input.value === '' ? null : field.type === 'number' ? Number(input.value) : input.value));
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.blur) input.blur(); });
		return input;
	}
	return document.createTextNode(cur ? cur.value : '');
}

/** A field the Table can edit in place (double-click) or in the details pane. */
function editableField(key) {
	if (key === 'status') return statusField();
	if (!key.startsWith('f:')) return null;
	const f = model.fields.find(x => 'f:' + x.id === key);
	return f && f.type !== 'other' ? f : null;
}
const colName = (c) => c.key.startsWith('f:') || c.key === 'num' ? c.name : t(c.name);
function colWidth(c) {
	if (c.key === 'subissues') return 110;
	switch (c.type) {
		case 'num': return 56;
		case 'status': return 104;
		case 'note': case 'prereq': return 180;
		case 'pr': return 160;
		case 'room': return 140;
		case 'list': return 130;
		case 'progress': case 'number': return 72;
		case 'date': return 96;
		default: return 104;
	}
}
function currentGroup() {
	const g = ui.group;
	if (g === undefined || g === null) return LOGIC.defaultGroup(model);
	return g && LOGIC.groupChoices(model).some(x => x.key === g) ? g : '';
}
const groupName = (key) => key ? ((LOGIC.groupChoices(model).find(g => g.key === key) || {}).name || '') : '';

function cellEl(r, c) {
	const v = LOGIC.cell(model, r, c.key);
	const tone = v.tone ? 't-' + v.tone : '';
	const field = editableField(c.key);
	const span = c.key === 'status'
		? h('span', { title: v.text }, h('i', { class: 'pill ' + tone }, v.text))
		: h('span', { class: c.key === 'num' ? 'num' : c.key === 'title' ? 'ti' : tone, title: v.text && v.text !== '—' ? v.text : undefined }, v.text);
	if (field) {
		span.addEventListener('dblclick', (e) => {
			e.stopPropagation();
			const ed = editor(r.card, field);
			span.replaceChildren(ed);
			if (ed.focus) ed.focus();
			if (ed.addEventListener) ed.addEventListener('blur', () => drawMain());
		});
	}
	return span;
}
function rowEl(r, cols) {
	const id = r.card.id;
	return h('div', { class: 'tr' + (ui.selected === id ? ' sel' : ''), 'data-id': id, onclick: () => select(id) }, cols.map(c => cellEl(r, c)));
}

function tableEl() {
	const group = currentGroup();
	const cols = LOGIC.visible(model, ui.columns, group);
	const rows = LOGIC.sortRows(model, shownRows, ui.sort);
	const groups = LOGIC.groups(model, rows, group);
	const tmpl = cols.map(c => c.key === 'title' ? 'minmax(220px, 1fr)' : colWidth(c) + 'px').join(' ');
	const min = 220 + cols.filter(c => c.key !== 'title').reduce((a, c) => a + colWidth(c), 0) + 12 * (cols.length - 1) + 16;
	const sortBy = (c) => { ui.sort = !ui.sort || ui.sort.key !== c.key ? { key: c.key, dir: 1 } : ui.sort.dir > 0 ? { key: c.key, dir: -1 } : null; save(); drawMain(); };
	const head = h('div', { class: 'tr th' }, cols.map(c => h('span', { title: t('Sort by {0}', colName(c)), onclick: () => sortBy(c) }, colName(c) + (ui.sort && ui.sort.key === c.key ? (ui.sort.dir > 0 ? ' ↑' : ' ↓') : ''))));
	return h('div', { class: 'tbl', style: '--cols:' + tmpl + ';min-width:' + min + 'px' }, head,
		groups.map(g => [group ? h('div', { class: 'grp' }, g.value || t('No {0}', groupName(group)), h('em', {}, String(g.rows.length))) : null, g.rows.map(r => rowEl(r, cols))]),
		rows.length ? null : h('div', { class: 'nothing' }, t('Nothing matches the filters.')));
}

/** The selected item's details (every view): the full title and every field, editable; GitHub, chat, room; on the Graph also its links. */
function detailsEl() {
	const card = model.columns.flatMap(c => c.cards).find(c => c.id === ui.selected);
	if (!card) return null;
	const kv = (k, v) => h('div', { class: 'dkv' }, h('span', { class: 'k', title: k }, k), h('span', { class: 'v' }, v));
	const row = { card, done: false, values: {} };
	const pick = (f) => {
		const tone = f.id === (model.roles || {}).prereq ? LOGIC.cell(model, row, 'f:' + f.id).tone : '';
		const ed = editor(card, f, tone && tone !== 'none' ? 't-' + tone : undefined);
		return f.type === 'single_select' || f.type === 'iteration' ? [ed, h('span', { class: 'chev' }, '⌄')] : ed;
	};
	const sf = statusField();
	const close = () => { ui.selected = null; ui.graph.selected = null; save(); drawMain(); };
	const node = ui.tab === 'graph' && model.graph ? model.graph.nodes.find(n => n.id === card.id) : null;
	return h('aside', { class: 'details' },
		h('div', { class: 'dh' }, h('span', {}, label(card) || (card.type === 'draft' ? t('Draft') : '')), h('button', { class: 'icon', title: t('Close'), onclick: close }, '✕')),
		h('div', { class: 'dtitle' }, card.title),
		sf ? kv(t('Status'), pick(sf)) : null,
		model.fields.filter(f => f.type !== 'other').map(f => kv(f.name, pick(f))),
		card.labels.length ? kv(t('Labels'), card.labels.join(', ')) : null,
		card.assignees.length ? kv(t('Assignees'), card.assignees.join(', ')) : null,
		card.blockers.length ? kv(t('Blocked by'), card.blockers.map(b => h('a', { class: b.open ? 't-warn' : 't-ok', title: b.open ? t('open') : t('done'), onclick: () => { if (b.itemId) { ui.selected = b.itemId; save(); drawMain(); } } }, (b.open ? '' : '✓ ') + b.label))) : null,
		card.prs.length || card.review ? kv(t('PR'), [card.prs.map(p => chip(p.label, p.tone, { onclick: () => post({ type: 'open', url: p.url }), style: 'cursor:pointer' })), card.review ? chip(card.review.label, card.review.tone) : null]) : null,
		card.room ? kv(t('Room'), roomChip(card.room)) : null,
		h('div', { class: 'hr' }),
		h('div', { class: 'dacts' },
			card.url ? h('button', { onclick: () => post({ type: 'open', url: card.url }) }, t('Open on GitHub')) : null,
			model.canChat ? h('button', { onclick: () => post({ type: 'chat', itemId: card.id }) }, t('Chat about this')) : null,
			card.startable ? h('button', { class: 'primary', onclick: () => post({ type: 'startRoom', itemId: card.id }) }, t('Start room ▸')) : null),
		node ? [h('div', { class: 'hr' }), graphFacts(node)] : null);
}

function newIssueForm() {
	const title = h('input', { class: 'wide', placeholder: t('Title of the new issue') });
	const repo = h('input', { list: 'repos', value: model.repositories[0] || '', placeholder: 'owner/repository', size: 22 });
	const status = h('select', {}, model.columns.filter(c => c.id).map(c => h('option', { value: c.id }, c.name)));
	const submit = () => {
		if (!title.value.trim() || !repo.value.trim()) return;
		post({ type: 'createIssue', title: title.value.trim(), repository: repo.value.trim(), optionId: status.value || undefined });
		ui.form = false; draw();
	};
	title.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { ui.form = false; draw(); } });
	setTimeout(() => title.focus(), 0);
	return h('div', { class: 'form' }, title, repo, h('datalist', { id: 'repos' }, model.repositories.map(r => h('option', { value: r }))), model.statusFieldId ? status : null,
		h('button', { class: 'primary', onclick: submit }, t('Create')), h('button', { onclick: () => { ui.form = false; draw(); } }, t('Cancel')));
}

const icon = (paths, fill) => s('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: fill ? 'currentColor' : 'none', stroke: fill ? 'none' : 'currentColor', 'stroke-width': 1.5 }, paths);
const searchIcon = () => icon([s('circle', { cx: 7, cy: 7, r: 4.5 }), s('path', { d: 'm10.5 10.5 3 3' })]);
const dotsIcon = () => icon([s('circle', { cx: 3.5, cy: 8, r: 1.2 }), s('circle', { cx: 8, cy: 8, r: 1.2 }), s('circle', { cx: 12.5, cy: 8, r: 1.2 })], true);
const menuEl = (side, items) => h('div', { class: 'menu' + (side === 'left' ? ' left' : ''), onclick: (e) => e.stopPropagation() }, items);
function toggleMenu(name) { ui.menu = ui.menu === name ? null : name; draw(); }

function groupMenu() {
	const cur = currentGroup();
	const pick = (k) => (e) => { e.stopPropagation(); ui.group = k; ui.menu = null; save(); draw(); };
	return menuEl('right', [h('div', { class: 'mh' }, t('Group by')),
		LOGIC.groupChoices(model).map(g => h('button', { class: 'mi', onclick: pick(g.key) }, g.name, cur === g.key ? h('span', {}, '✓') : null)),
		h('button', { class: 'mi', onclick: pick('') }, t('None'), cur === '' ? h('span', {}, '✓') : null)]);
}
function columnsMenu() {
	const keys = LOGIC.columnKeys(model, ui.columns);
	const group = currentGroup();
	return menuEl('right', [h('div', { class: 'mh' }, t('Columns')),
		LOGIC.columns(model).filter(c => c.key !== 'num' && c.key !== 'title').map(c => h('button', { class: 'mi', onclick: (e) => { e.stopPropagation(); ui.columns = LOGIC.toggle(model, ui.columns, c.key); save(); draw(); } },
			colName(c), h('span', {}, keys.includes(c.key) ? (c.key === group ? t('grouped') : '✓') : ''))),
		h('div', { class: 'msep' }),
		h('button', { class: 'mi', onclick: (e) => { e.stopPropagation(); ui.columns = null; save(); draw(); } }, t('Default columns'))]);
}
function moreMenu() {
	const item = (text, run, hint) => h('button', { class: 'mi', onclick: (e) => { e.stopPropagation(); ui.menu = null; run(); draw(); } }, text, hint ? h('span', {}, hint) : null);
	const open = (name) => (e) => { e.stopPropagation(); ui.menu = name; draw(); };
	return menuEl('right', [
		item(t('Refresh'), () => post({ type: 'refresh' })),
		item(model.pinned ? t('Unpin this board') : t('Pin this board'), () => post({ type: 'togglePin' })),
		item(t('+ Board'), () => post({ type: 'openBoard' }), t('another project')),
		ui.tab === 'table' ? [h('div', { class: 'msep' }), h('button', { class: 'mi', onclick: open('columns') }, t('Columns…')), h('button', { class: 'mi', onclick: open('group') }, t('Group by…'))] : null]);
}

function filterChip(f, removable) {
	const cur = ui.filters[f.key] || '';
	const sel = h('select', { title: f.name, onchange: () => { ui.filters[f.key] = sel.value; save(); draw(); } },
		h('option', { value: '' }, t('{0}: all', f.name)),
		f.key === 'status' ? h('option', { value: '!done', selected: cur === '!done' }, t('{0}: not done', f.name)) : null,
		f.values.map(v => h('option', { value: v, selected: cur === v }, f.name + ': ' + v)));
	const remove = () => { ui.extra = ui.extra.filter(k => k !== f.key); delete ui.filters[f.key]; save(); draw(); };
	return h('span', { class: 'fchip' + (cur ? '' : ' off') }, sel, h('span', { class: 'chev' }, '⌄'),
		removable ? h('button', { class: 'x', title: t('Remove filter'), onclick: remove }, '×') : null);
}
let searchInput = null;
function filterRow() {
	const roles = model.roles || {};
	const has = (k) => model.filters.some(f => f.key === k);
	const byKey = (k) => model.filters.find(f => f.key === k);
	const quick = ['status', roles.line && 'f:' + roles.line, roles.executor && 'f:' + roles.executor].filter(k => k && has(k));
	const extras = [...new Set([...ui.extra, ...Object.keys(ui.filters).filter(k => ui.filters[k])])].filter(k => !quick.includes(k) && has(k));
	const addable = model.filters.filter(f => !quick.includes(f.key) && !extras.includes(f.key));
	const search = h('input', { placeholder: t('Search title or #'), value: ui.search });
	search.addEventListener('input', () => { ui.search = search.value; save(); drawMain(); });
	searchInput = search;
	const group = ui.tab === 'table' ? currentGroup() : '';
	const add = (f) => (e) => { e.stopPropagation(); ui.extra = ui.extra.concat(f.key); ui.menu = null; save(); draw(); };
	return h('div', { class: 'filters' },
		h('label', { class: 'fchip search' }, searchIcon(), search),
		quick.map(k => filterChip(byKey(k), false)),
		extras.map(k => filterChip(byKey(k), true)),
		addable.length ? h('span', { class: 'anchor' }, h('button', { class: 'fchip add', onclick: (e) => { e.stopPropagation(); toggleMenu('filter'); } }, t('+ Filter')),
			ui.menu === 'filter' ? menuEl('left', addable.map(f => h('button', { class: 'mi', onclick: add(f) }, f.name))) : null) : null,
		h('span', { class: 'spacer' }),
		ui.tab === 'table' ? h('span', { class: 'anchor' }, h('button', { class: 'fchip ghost', onclick: (e) => { e.stopPropagation(); toggleMenu('groupChip'); } }, group ? t('Group: {0}', groupName(group)) : t('Group: none')),
			ui.menu === 'groupChip' ? groupMenu() : null) : null);
}

/**
 * "owner/number · updated 23:28 · every 1 min": reading GitHub at intervals is the normal state (the relay is an
 * optional push channel), so it is neutral; "live" only while the relay is connected; the relay's state in the hover.
 */
function syncSub() {
	const st = model.sync || {};
	const at = (st.at || '').replace(/^(\d{1,2}:\d{2}):\d{2}/, '$1'); // hours and minutes are enough here
	const state = st.kind === 'synced' ? h('span', { class: 'live', title: t('Live: the relay pushes GitHub changes here as they happen. Last change read {0}.', st.at) }, t('live · updated {0}', at))
		: st.kind === 'polling' ? h('span', { title: t('Read from GitHub at {0}, then every {1} min. The relay (an optional push channel) is not connected.', st.at, st.everyMin || 1) }, t('updated {0}', at), st.everyMin ? ' · ' + t('every {0} min', st.everyMin) : '')
			: st.kind === 'error' ? h('span', { class: 'bad' }, st.text)
				: st.kind === 'loading' ? h('span', {}, t('reading…')) : h('span', {}, st.text || '');
	return h('span', { class: 'sub' }, model.project.ref + ' · ', state, model.pinned ? ' · ' + t('pinned') : '');
}

function headerEl() {
	const names = { board: t('Board'), table: t('Table'), plan: t('Plan'), graph: t('Graph') };
	searchInput = null;
	return h('header', {},
		h('div', { class: 'top' },
			h('div', { class: 'name' }, h('a', { class: 'title', title: t('Open the project on GitHub'), onclick: () => post({ type: 'open', url: model.project.url }) }, model.project.title), syncSub()),
			h('div', { class: 'seg' }, ['board', 'table', 'plan', 'graph'].map(k => h('button', { class: ui.tab === k ? 'on' : '', onclick: () => { ui.tab = k; ui.menu = null; save(); draw(); } }, names[k]))),
			h('button', { class: 'pri', onclick: () => { ui.form = !ui.form; draw(); } }, t('+ New issue')),
			h('span', { class: 'anchor' }, h('button', { class: 'icon' + (ui.menu === 'more' || ui.menu === 'columns' || ui.menu === 'group' ? ' on' : ''), title: t('More actions'), onclick: (e) => { e.stopPropagation(); toggleMenu('more'); } }, dotsIcon()),
				ui.menu === 'more' ? moreMenu() : ui.menu === 'columns' ? columnsMenu() : ui.menu === 'group' ? groupMenu() : null)),
		ui.form ? newIssueForm() : null,
		filterRow());
}

function footerEl() {
	const d = h('details', { open: saved.log ? true : undefined }, h('summary', {}, 'Sync log · both directions'),
		model.journal.length ? h('div', { class: 'log' }, model.journal.map(e => [h('span', { class: 'muted' }, e.time), h('span', {}, e.direction === 'in' ? 'GitHub → here' : 'here → GitHub'), h('span', { class: e.error ? 'err' : '' }, (e.item ? e.item + ' · ' : '') + e.text)])) : h('div', { class: 'muted' }, 'Nothing yet: changes on GitHub and here show up in this log.'));
	d.addEventListener('toggle', () => { saved.log = d.open; vscode.setState(Object.assign({}, vscode.getState(), { log: d.open })); });
	return h('footer', {}, d);
}

/**
 * The Plan view. The filters choose which tasks show; dependency levels, lane progress and the critical path are
 * worked out on every task, so a filtered-out prerequisite does not move its followers to another column.
 */
function planEl() {
	const p = model.plan;
	if (!p) return h('div', { class: 'muted' }, 'No plan yet.');
	const stateText = { released: 'Released', development: 'In development', next: 'Next', later: 'Later' };
	const stairs = p.stairs.map(s => Object.assign({}, s, { cells: s.cells.filter(c => shownIds.has(c.id)) }));
	const shownLanes = new Set(stairs.filter(s => s.cells.length).map(s => s.lane));
	const narrowed = filtering();
	const lanes = h('section', {},
		h('h2', {}, 'Release lanes'),
		h('p', { class: 'hint' }, (p.live ? 'Live: ' + p.live + ' · ' : '') + (p.laneField ? 'lanes from the ' + p.laneField + ' field' : 'no lane field (Line, Release, Milestone…): everything is in Backlog') + (p.weightField ? ' · weighted by ' + p.weightField : ' · every task weighs the same')),
		h('div', { class: 'lanes' }, p.lanes.filter(l => !narrowed || shownLanes.has(l.name)).map(l => h('div', { class: 'lane ' + l.state },
			h('div', { class: 'muted' }, stateText[l.state]),
			h('div', { class: 'name' }, l.name),
			h('div', { class: 'bar', title: t('{0}% done', l.percent) }, h('i', { style: 'width:' + l.percent + '%' })),
			h('div', { class: 'muted' }, l.done + '/' + l.total + ' done · ' + l.percent + '%')))));
	// Branch rails come from GitHub's open pull requests and the local repository; without either, no section.
	const rails = p.rails.length ? h('section', {},
		h('h2', {}, 'Branches'),
		h('p', { class: 'hint' }, 'Where the base branch and each branch with an open pull request stand, and what goes on them next, in order.'),
		h('div', { class: 'rails' }, p.rails.map(r => h('div', { class: 'rail' },
			h('div', { class: 'head' }, h('span', { class: 'branch' }, r.name), r.head ? h('span', { class: 'muted' }, r.head) : null, r.note ? h('span', { class: 'muted' }, r.note) : null),
			h('div', { class: 'steps' }, r.steps.map(s => h('div', { class: 'step' + (s.done ? ' done' : '') + (s.now ? ' now' : ''), onclick: s.url ? () => post({ type: 'open', url: s.url }) : s.roomId ? () => post({ type: 'openRoom', roomId: s.roomId }) : undefined, style: s.url || s.roomId ? 'cursor:pointer' : '' },
				h('span', { class: 'pin' }), h('span', { class: 'lbl', title: s.label }, (s.done ? '✓ ' : '') + s.label), s.sub ? h('span', { class: 'sub' + (s.tone ? ' tone-' + s.tone : ''), title: s.sub }, s.sub) : null))))))) : null;
	// Columns are capped, so a lane with one level reads as a list, not as full-width bars.
	const grid = h('div', { class: 'stairs', style: 'grid-template-columns:repeat(' + p.levels + ', minmax(140px, 320px))' }, Array.from({ length: p.levels }, (_, i) => h('div', { class: 'lv' }, String(i))),
		stairs.filter(s => s.cells.length).map(s => [h('div', { class: 'lanehead' }, s.lane + ' · ' + s.percent + '%'),
			s.cells.map(c => h('div', { class: 'cell' + (c.done ? ' done' : '') + (c.critical ? ' critical' : '') + (c.startable ? ' startable' : '') + (c.running ? ' running' : '') + (ui.selected === c.id ? ' sel' : ''), title: (c.done ? t('done') : t('{0}% done', Math.round(c.fill * 100))) + ' · ' + c.label + ' ' + c.title, 'data-id': c.id, style: 'grid-column:' + (c.level + 1), onclick: () => select(c.id) },
				h('i', { class: 'fill', style: 'width:' + Math.round(c.fill * 100) + '%' }), h('span', {}, (c.done ? '✓ ' : '') + c.label + ' ' + c.title)))]));
	const legendBox = (style) => h('i', { style });
	const staircase = h('section', {},
		h('h2', {}, 'Dependency staircase'),
		h('p', { class: 'hint' }, 'Dependency level instead of time: a task goes one column after its latest prerequisite, so tasks in one column can run in parallel. Green is done, the blue fill is how far an open task is; the red chain is the critical path.'),
		narrowed ? h('p', { class: 'hint' }, t('Only the tasks the filters let through; levels, progress and the critical path count every task.')) : null,
		shownLanes.size ? h('div', { class: 'stairs-wrap' }, grid) : h('div', { class: 'nothing' }, t('Nothing matches the filters.')),
		p.critical.filter(c => shownLanes.has(c.lane)).map(c => h('div', { class: 'muted' }, 'Critical path · ' + c.lane + ': ' + c.path.join(' → '))),
		h('div', { class: 'legend' },
			h('span', {}, legendBox('border:2px solid var(--crit)'), t('critical path')),
			h('span', {}, legendBox('background:color-mix(in srgb, var(--done) 16%, transparent);border-color:color-mix(in srgb, var(--done) 35%, var(--vscode-panel-border))'), t('✓ done')),
			h('span', {}, legendBox('background:color-mix(in srgb, var(--prog) 24%, transparent)'), t('in progress (fill = how far)')),
			h('span', {}, legendBox('box-shadow: inset 3px 0 0 var(--done)'), t('startable now')),
			h('span', {}, legendBox('box-shadow: inset 3px 0 0 var(--run)'), t('a room is running on it'))),
		h('p', { class: 'hint' }, t('Click a task for its details.')));
	return h('div', { class: 'plan' }, lanes, rails, staircase);
}

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
	const el = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else el.setAttribute(k, String(v));
	}
	for (const kid of kids.flat(Infinity)) {
		if (kid === undefined || kid === null || kid === false) continue;
		el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	return el;
}
const W = 200, H = 64;
ui.graph = Object.assign({ mode: 'select', critical: true, zoom: 1 }, saved.graph || {}, { selected: null, target: null });
const saveGraph = () => vscode.setState(Object.assign({}, vscode.getState(), { graph: { mode: ui.graph.mode === 'pick' ? 'select' : ui.graph.mode, critical: ui.graph.critical, zoom: ui.graph.zoom } }));
const cut = (text, n) => text.length > n ? text.slice(0, n - 1) + '…' : text;

function edgePath(a, b) {
	const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
	const back = x2 < x1 + 20;
	const dx = back ? 80 : Math.max(40, (x2 - x1) / 2);
	return 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
}
const edgeKey = (e) => e.kind + ':' + e.from + '>' + e.to;

/** Whether a graph node is the selected one: a task by the details pane's item, a release by the graph's own pick. */
const nodeSelected = (n) => n.kind === 'milestone' ? !!(ui.graph.selected && ui.graph.selected.node === n.id) : ui.selected === n.id;
/** Selects a node: a task opens the details pane, a release shows in the graph's side panel. */
function selectNode(n) {
	if (n.kind === 'milestone') { ui.graph.selected = { node: n.id }; ui.selected = null; }
	else { ui.graph.selected = null; ui.selected = n.id; }
	save(); drawMain();
}

/**
 * The Graph view. The filters choose which tasks show (a release shows while one of its tasks does); places and
 * the critical path come from every task, and the side panel and the details list hidden links too.
 */
function graphEl() {
	const g = model.graph;
	if (!g) return h('div', { class: 'muted' }, 'No graph yet.');
	const all = new Map(g.nodes.map(n => [n.id, Object.assign({}, n)]));
	const lanesShown = new Set(g.nodes.filter(n => n.kind === 'task' && shownIds.has(n.id)).map(n => n.lane));
	const nodes = new Map([...all].filter(([id, n]) => n.kind === 'milestone' ? lanesShown.has(n.lane) : shownIds.has(id)));
	// With filters on, the shown tasks keep their order but close up (columns and rows of hidden tasks go):
	// kept places of a few tasks lie far apart. This view is not saved as their places.
	const filtered = g.nodes.some(n => n.kind === 'task' && !shownIds.has(n.id));
	if (filtered) {
		const xs = [...new Set([...nodes.values()].map(n => n.x))].sort((a, b) => a - b);
		const ys = [...new Set([...nodes.values()].map(n => n.y))].sort((a, b) => a - b);
		for (const n of nodes.values()) { n.x = 40 + xs.indexOf(n.x) * (W + 60); n.y = 40 + ys.indexOf(n.y) * (H + 36); }
	}
	const z = ui.graph.zoom;
	// The canvas is cut to the tasks the filters show: kept places of hidden tasks leave no empty field to scroll past.
	const shown = [...nodes.values()];
	const pad = 40;
	const ox = shown.length ? Math.max(0, Math.min(...shown.map(n => n.x)) - pad) : 0;
	const oy = shown.length ? Math.max(0, Math.min(...shown.map(n => n.y)) - pad) : 0;
	const gw = shown.length ? Math.max(...shown.map(n => n.x)) + W + pad - ox : g.width;
	const gh = shown.length ? Math.max(...shown.map(n => n.y)) + H + pad - oy : g.height;
	const svg = s('svg', { width: Math.round(gw * z), height: Math.round(gh * z), viewBox: ox + ' ' + oy + ' ' + gw + ' ' + gh, class: ui.graph.mode !== 'select' ? 'drawing' : '' },
		s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }))));
	const edgeLayer = s('g', {});
	const nodeLayer = s('g', {});
	svg.append(edgeLayer, nodeLayer);
	const pointIn = (ev) => {
		const r = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, top: 0 };
		return { x: (ev.clientX - r.left) / z + ox, y: (ev.clientY - r.top) / z + oy };
	};
	const drawEdges = () => {
		edgeLayer.replaceChildren(...g.edges.filter(e => nodes.has(e.from) && nodes.has(e.to)).map(e => {
			const d = edgePath(nodes.get(e.from), nodes.get(e.to));
			const key = edgeKey(e);
			const crit = ui.graph.critical && e.critical;
			const select = (ev) => { ev.stopPropagation(); ui.graph.selected = { edge: e }; drawMain(); };
			return s('g', {}, s('path', { class: 'edge-hit', d, onclick: select }),
				s('path', { class: 'edge ' + e.kind + (crit ? ' critical' : '') + (ui.graph.selected && ui.graph.selected.edge && edgeKey(ui.graph.selected.edge) === key ? ' sel' : ''), d, 'marker-end': 'url(#arrow)', onclick: select }));
		}));
	};
	for (const n of nodes.values()) {
		const sel = nodeSelected(n);
		const fill = Math.max(0, Math.min(1, n.fill || 0));
		const el = s('g', { class: 'node ' + n.kind + (n.done ? ' done' : '') + (ui.graph.critical && n.critical ? ' critical' : '') + (sel ? ' sel' : ''), transform: 'translate(' + n.x + ',' + n.y + ')', 'data-node': n.id },
			s('rect', { width: W, height: H, rx: n.kind === 'milestone' ? 18 : 6 }),
			n.tone ? s('rect', { class: 'stripe-' + n.tone, width: 4, height: H, rx: 2 }) : null,
			// Completion as a thin bar along the bottom: green when done, blue while open.
			s('rect', { class: 'meter', x: 10, y: H - 5, width: W - 20, height: 2, rx: 1 }),
			fill > 0 ? s('rect', { class: n.done ? 'meter-done' : 'meter-prog', x: 10, y: H - 5, width: Math.round((W - 20) * fill), height: 2, rx: 1 }) : null,
			s('text', { x: 12, y: 18 }, cut((n.done ? '✓ ' : '') + n.label + (n.status ? ' · ' + n.status : ''), 30)),
			s('text', { x: 12, y: 36 }, cut(n.title, 30)),
			n.sub ? s('text', { class: 'sub', x: 12, y: 54 }, cut(n.sub, 32)) : null);
		el.addEventListener('pointerdown', (ev) => {
			ev.stopPropagation();
			const start = pointIn(ev);
			const ox = n.x, oy = n.y;
			let moved = false;
			const drawing = ui.graph.mode === 'draw' || ui.graph.mode === 'loose';
			const ghost = drawing ? s('path', { class: 'ghost' }) : null;
			if (ghost) svg.append(ghost);
			const move = (e2) => {
				const p = pointIn(e2);
				if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 4) moved = true;
				if (drawing) { ghost.setAttribute('d', 'M' + (ox + W) + ',' + (oy + H / 2) + ' L' + p.x + ',' + p.y); return; }
				if (ui.graph.mode !== 'select') return;
				n.x = Math.max(0, ox + p.x - start.x); n.y = Math.max(0, oy + p.y - start.y);
				el.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
				drawEdges();
			};
			const up = (e2) => {
				window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
				if (ghost) ghost.remove();
				if (drawing) {
					const p = pointIn(e2);
					const hit = [...nodes.values()].find(m => p.x >= m.x && p.x <= m.x + W && p.y >= m.y && p.y <= m.y + H);
					if (hit && hit.id !== n.id) linkNodes(n, hit, ui.graph.mode);
					return;
				}
				if (moved && !filtered) post({ type: 'savePosition', id: n.id, x: n.x, y: n.y });
				else clickNode(n);
			};
			window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
		});
		nodeLayer.append(el);
	}
	drawEdges();
	svg.addEventListener('pointerdown', () => { if (ui.graph.selected) { ui.graph.selected = null; drawMain(); } });
	const mode = (m, text, title) => h('button', { class: ui.graph.mode === m ? 'on' : '', title, onclick: () => { ui.graph.mode = m; ui.graph.target = null; saveGraph(); drawMain(); } }, text);
	const top = h('div', { class: 'graph-top' },
		mode('select', 'Select', 'Click to select, drag to move'),
		mode('draw', 'Draw prerequisite', 'Drag from one task to another: the first becomes the prerequisite of the second, on GitHub too'),
		mode('loose', 'Draw loose link', 'A link that blocks nothing; kept in this workspace'),
		h('button', { onclick: () => post({ type: 'autoLayout' }) }, 'Auto layout'),
		h('button', { class: ui.graph.critical ? 'on' : '', onclick: () => { ui.graph.critical = !ui.graph.critical; saveGraph(); drawMain(); } }, 'Critical path'),
		h('button', { title: 'Zoom out', onclick: () => { ui.graph.zoom = Math.max(0.4, ui.graph.zoom - 0.15); saveGraph(); drawMain(); } }, '−'),
		h('button', { title: 'Zoom in', onclick: () => { ui.graph.zoom = Math.min(1.8, ui.graph.zoom + 0.15); saveGraph(); drawMain(); } }, '+'),
		h('span', { class: 'muted' }, ui.graph.mode === 'pick' ? 'Click the task that has to come first.' : ui.graph.mode === 'draw' ? 'Drag a line from one task to another: it becomes its prerequisite, on GitHub too.' : ui.graph.mode === 'loose' ? 'Drag a line between two tasks: a loose link, it blocks nothing.' : 'Drag to move · click for details'));
	return h('div', {}, top, h('div', { class: 'graph-body' }, h('div', { class: 'canvas' }, svg), sideEl(g, all)),
		h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'border:2px solid var(--crit)' }), t('critical path')), h('span', {}, h('i', { style: 'background:color-mix(in srgb, var(--done) 75%, transparent)' }), t('✓ done')), h('span', {}, h('i', { style: 'background:var(--prog)' }), t('in progress (bar = how far)')), h('span', {}, '── prerequisite'), h('span', {}, '- - loose link (blocks nothing)'), h('span', {}, '··· leads to the release')));
}

function linkNodes(a, b, mode) {
	if (a.kind === 'milestone' || b.kind === 'milestone') return;
	if (mode === 'loose') { post({ type: 'addLoose', a: a.id, b: b.id }); return; }
	if (!a.linkable || !b.linkable) { post({ type: 'notice', text: 'Prerequisites link issues only.' }); return; }
	post({ type: 'addDependency', blocking: a.id, blocked: b.id });
}
function clickNode(n) {
	if (ui.graph.mode === 'pick' && ui.graph.target) {
		const target = model.graph.nodes.find(x => x.id === ui.graph.target);
		if (target && n.id !== target.id) linkNodes(n, target, 'draw');
		ui.graph.mode = 'select'; ui.graph.target = null; drawMain(); return;
	}
	selectNode(n);
}

/** The graph's side panel: a picked link or release, else how to use it; a task's links show in the details pane. */
function sideEl(g, nodes) {
	const sel = ui.graph.selected;
	const task = ui.selected && nodes.get(ui.selected);
	if (!sel && task && task.kind === 'task') return null;
	if (!sel) return h('aside', { class: 'side' }, h('div', { class: 'muted' }, 'Select a task to see what it waits for and what waits for it. When every prerequisite of a task is done, it is startable, and one click starts a room on it.'));
	if (sel.edge) {
		const e = sel.edge, a = nodes.get(e.from), b = nodes.get(e.to);
		const what = e.kind === 'blocks' ? a.label + ' must come before ' + b.label : e.kind === 'loose' ? a.label + ' and ' + b.label + ' are loosely linked' : a.label + ' leads to ' + b.title;
		return h('aside', { class: 'side' }, h('div', { class: 'title' }, what),
			e.kind === 'blocks' ? h('div', { class: 'muted' }, 'A GitHub "blocked by" link.') : e.kind === 'loose' ? h('div', { class: 'muted' }, 'Kept in this workspace; blocks nothing.') : null,
			e.kind === 'blocks' ? h('button', { onclick: () => { post({ type: 'removeDependency', blocking: e.from, blocked: e.to }); ui.graph.selected = null; } }, 'Remove the prerequisite')
				: e.kind === 'loose' ? h('button', { onclick: () => { post({ type: 'removeLoose', a: e.from, b: e.to }); ui.graph.selected = null; } }, 'Remove the loose link') : null);
	}
	const n = nodes.get(sel.node);
	if (!n) return h('aside', { class: 'side' });
	return h('aside', { class: 'side' },
		h('div', { class: 'muted' }, n.label),
		h('div', { class: 'title' }, n.title),
		n.sub ? chip(n.sub, n.tone) : null,
		graphFacts(n));
}

/** What a node waits for and what waits for it, its loose links and critical path; for a task, + prerequisite. */
function graphFacts(n) {
	const g = model.graph;
	const nodes = new Map(g.nodes.map(m => [m.id, m]));
	const before = g.edges.filter(e => e.to === n.id && (n.kind === 'milestone' || e.kind === 'blocks')).map(e => nodes.get(e.from)).filter(Boolean);
	const after = g.edges.filter(e => e.from === n.id && e.kind !== 'loose').map(e => nodes.get(e.to)).filter(Boolean);
	const loose = g.edges.filter(e => e.kind === 'loose' && (e.from === n.id || e.to === n.id)).map(e => nodes.get(e.from === n.id ? e.to : e.from)).filter(Boolean);
	const item = (m, state) => h('li', {}, h('a', { onclick: () => selectNode(m) }, (m.done ? '✓ ' : '') + m.label + ' ' + cut(m.title, 34)), state ? h('span', { class: 'muted' }, ' · ' + state) : null);
	const crit = g.critical.find(c => c.lane === n.lane);
	return h('div', { class: 'facts side-facts' },
		n.kind === 'task' ? [h('h4', {}, 'Prerequisites'), before.length ? h('ul', {}, before.map(m => item(m, m.done ? 'done' : 'open'))) : h('div', { class: 'muted' }, 'None')] : [h('h4', {}, 'Waits for'), h('ul', {}, before.map(m => item(m, m.done ? 'done' : 'open')))],
		n.kind === 'task' && after.length ? [h('h4', {}, 'It blocks'), h('ul', {}, after.map(m => item(m, m.kind === 'milestone' ? 'release' : 'waits for it')))] : null,
		loose.length ? [h('h4', {}, 'Loose links'), h('ul', {}, loose.map(m => item(m, '')))] : null,
		n.critical && crit ? [h('h4', {}, 'Critical path to ' + crit.lane), h('div', {}, crit.path.join(' → ')), h('div', { class: 'muted' }, 'A slip of ' + n.label + ' pushes the whole release.')] : null,
		n.linkable ? h('div', { class: 'row' }, h('button', { onclick: () => { ui.graph.mode = 'pick'; ui.graph.target = n.id; drawMain(); } }, 'Add prerequisite')) : null);
}
window.addEventListener('keydown', (e) => {
	if (ui.tab !== 'graph' || !ui.graph.selected || !ui.graph.selected.edge) return;
	if (e.key !== 'Delete' && e.key !== 'Backspace') return;
	if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName || '')) return;
	const ed = ui.graph.selected.edge;
	if (ed.kind === 'blocks') post({ type: 'removeDependency', blocking: ed.from, blocked: ed.to });
	if (ed.kind === 'loose') post({ type: 'removeLoose', a: ed.from, b: ed.to });
	ui.graph.selected = null; drawMain();
});

window.addEventListener('keydown', (e) => {
	if (e.key !== 'Escape') return;
	if (ui.menu) { ui.menu = null; draw(); return; }
	if (ui.selected && !(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName || ''))) { ui.selected = null; ui.graph.selected = null; save(); drawMain(); }
});
window.addEventListener('click', () => { if (ui.menu) { ui.menu = null; draw(); } });

let mainEl = null;
let areaEl = null;
function drawMain(pos) {
	if (!mainEl) return;
	const top = pos ? pos.top : mainEl.scrollTop, left = pos ? pos.left : mainEl.scrollLeft;
	const lane = mainEl.querySelector ? mainEl.querySelector('.board') : null;
	const laneLeft = pos ? pos.lane : lane ? lane.scrollLeft : 0;
	shownRows = LOGIC.filter(LOGIC.rows(model), ui.filters, ui.search);
	shownIds = new Set(shownRows.map(r => r.card.id));
	mainEl.className = ui.tab === 'table' ? 'table' : '';
	mainEl.replaceChildren(ui.tab === 'table' ? tableEl() : ui.tab === 'plan' ? planEl() : ui.tab === 'graph' ? graphEl() : boardEl(), footerEl());
	const aside = detailsEl();
	areaEl.replaceChildren(...(aside ? [mainEl, aside] : [mainEl]));
	mainEl.scrollTop = top || 0;
	mainEl.scrollLeft = left || 0;
	const again = mainEl.querySelector ? mainEl.querySelector('.board') : null;
	if (again) again.scrollLeft = laneLeft || 0;
}
function draw() {
	if (screen) { mainEl = null; const focusPick = ui.pickFocus; pickInput = null; document.body.replaceChildren(emptyEl(screen)); if (pickInput && focusPick) { pickInput.focus(); } if (!screen.picker) { ui.pickText = undefined; } return; }
	if (!model) return;
	const typing = !!searchInput && document.activeElement === searchInput;
	const caret = typing ? searchInput.selectionStart : 0;
	let pos;
	if (mainEl) {
		const lane = mainEl.querySelector ? mainEl.querySelector('.board') : null;
		pos = { top: mainEl.scrollTop, left: mainEl.scrollLeft, lane: lane ? lane.scrollLeft : 0 };
	} else {
		mainEl = h('main', {});
		areaEl = h('div', { class: 'area' });
	}
	document.body.replaceChildren(headerEl(), areaEl);
	drawMain(pos);
	if (typing && searchInput) {
		searchInput.focus();
		try { searchInput.setSelectionRange(caret, caret); } catch { /* not a text input */ }
	}
}
/** A field being edited (not the search) holds back a redraw until it loses focus, so a sync does not drop the typing. */
let held = false;
const editing = () => { const a = document.activeElement; return !!a && a !== searchInput && /INPUT|SELECT|TEXTAREA/.test(a.tagName || ''); };
window.addEventListener('focusout', () => { if (held) { held = false; setTimeout(() => { if (!editing()) draw(); else held = true; }, 0); } });
function emptyEl(s) {
	const p = s.picker;
	return h('div', { class: 'empty' }, h('div', { class: 'title' }, s.title), s.text ? h('div', { class: 'muted' }, s.text) : null,
		p ? pickerEl(p) : null,
		h('div', { class: 'row' }, (s.actions || []).map((a, i) => h('button', { class: i === 0 && !p ? 'primary' : '', onclick: () => post({ type: a.command }) }, a.label))));
}
/** The board's own project list (Follow a project…): the user's projects to click, or one typed in. */
var pickInput = null;
function pickerEl(p) {
	const follow = (ref) => post({ type: 'followProject', ref });
	const input = pickInput = h('input', { class: 'wide', id: 'pickRef', placeholder: t('owner/number or the project URL'), 'aria-label': t('owner/number or the project URL'), value: ui.pickText ?? (p.current || ''), spellcheck: 'false', autocomplete: 'off', oninput: () => { ui.pickText = input.value; }, onfocus: () => { ui.pickFocus = true; }, onblur: () => { ui.pickFocus = false; },
		onkeydown: (e) => { if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); follow(input.value.trim()); } } });
	return h('div', { class: 'picker' },
		p.loading ? h('div', { class: 'muted' }, t('Reading your projects…')) : null,
		p.listError ? h('div', { class: 'muted' }, p.listError) : null,
		p.projects.length ? h('div', { class: 'plist', role: 'list' }, p.projects.map(x => h('button', { class: 'pick' + (x.current ? ' on' : ''), role: 'listitem', onclick: () => follow(x.ref) }, h('span', { class: 'pt' }, x.title), h('span', { class: 'pd' }, x.detail)))) : null,
		h('div', { class: 'form' }, h('span', { class: 'muted' }, t('Or type one:')), input, h('button', { class: 'primary', onclick: () => { if (input.value.trim()) follow(input.value.trim()); } }, t('Follow'))),
		p.error ? h('div', { class: 'perr', role: 'alert' }, p.error) : null);
}
window.addEventListener('message', (e) => {
	const m = e.data;
	if ('ref' in m) vscode.setState(Object.assign({}, vscode.getState(), { ref: m.ref })); // the tab reopens on the same project
	if (m.type === 'model') { model = m.model; screen = null; if (editing()) { held = true; return; } draw(); }
	if (m.type === 'screen') { screen = m.screen; draw(); }
});
post({ type: 'ready' });
`;

/** The page; `strings` are its words in the UI language (the extension's l10n), English when left out. */
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

/** The bundled Inter (media/fonts, SIL OFL 1.1): variable weight, Latin and Latin Extended (ő, ű). `base`: the folder's webview address. */
export function fontFaces(base: string | undefined): string {
	if (!base) {
		return '';
	}
	const root = base.replace(/\/+$/, '').replace(/["\\\n]/g, encodeURIComponent);
	const face = (file: string, range: string) => `@font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("${root}/${file}") format("woff2"); unicode-range: ${range}; }`;
	return `${face('inter-latin-ext-wght-normal.woff2', LATIN_EXT)}\n${face('inter-latin-wght-normal.woff2', LATIN)}\n`;
}

/** The page; `fonts`: the webview address of media/fonts (none: the system's sans). */
export function boardHtml(nonce: string, cspSource: string, strings: Readonly<Record<string, string>> = {}, fonts?: string): string {
	const words = JSON.stringify(strings).replace(/</g, '\\u003c');
	const script = SCRIPT.replace('__STRINGS__', () => words).replace('__LOGIC__', () => tableLogic.toString());
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}';${fonts ? ` font-src ${cspSource};` : ''} script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Project</title>
<style nonce="${nonce}">${fontFaces(fonts)}${STYLE}</style>
</head>
<body>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

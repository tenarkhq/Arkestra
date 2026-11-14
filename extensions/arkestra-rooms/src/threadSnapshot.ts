/*---------------------------------------------------------------------------------------------
 *  Arkestra. A thread as another screen shows it (AR36, Remote Control): its last messages and
 *  each agent's state, work and model choice. Plain data, sized for a phone. No VS Code here.
 *--------------------------------------------------------------------------------------------*/

import type { AgentActivity } from './activity';
import type { AgentChoices } from './agent';
import type { RoomState } from './room';
import { roomPhase } from './tasks';
import { TURN_TEXT, turnState, type TurnState } from './work';

export interface SnapshotAgent {
	readonly id: string;
	readonly name: string;
	readonly turn: TurnState;
	readonly turnText: string;
	readonly tool?: string;
	readonly error?: string;
	readonly waiting?: string;
	readonly todos: readonly { readonly text: string; readonly status: string }[];
	readonly subagents: readonly { readonly name: string; readonly detail?: string; readonly status: string; readonly result?: string }[];
	readonly background: readonly { readonly name: string; readonly status: string; readonly result?: string }[];
	readonly choice: { readonly model?: string; readonly effort?: string };
	readonly choices?: AgentChoices;
}

export interface ThreadSnapshot {
	readonly id: string;
	readonly title: string;
	readonly phase: string;
	readonly busy: boolean;
	readonly messages: readonly { readonly id: string; readonly at: string; readonly author: { readonly kind: string; readonly name: string }; readonly text: string }[];
	readonly agents: readonly SnapshotAgent[];
}

export interface ThreadListItem {
	readonly id: string;
	readonly title: string;
	readonly lastAt: string;
	readonly agents: number;
	readonly busy: boolean;
	readonly waiting: boolean;
}

const cut = (text: string, n: number) => text.length > n ? `${text.slice(0, n - 1)}…` : text;

export function threadSnapshot(state: RoomState, agent: (id: string) => { name: string; activity: AgentActivity; choices?: AgentChoices }, limit = 60): ThreadSnapshot {
	const agents = state.roster.map(id => {
		const a = agent(id);
		const act = a.activity;
		const turn = turnState(act.state, act.work, act.error, !!act.ran);
		const w = act.work;
		const choice = state.choices?.[id] ?? {};
		return {
			id, name: a.name, turn, turnText: TURN_TEXT[turn],
			...(act.tool ? { tool: cut(act.tool, 120) } : {}),
			...(act.error ? { error: cut(act.error, 300) } : {}),
			...(w?.waiting ? { waiting: w.waiting } : {}),
			todos: (w?.todos ?? []).map(t => ({ text: t.text, status: t.status })),
			subagents: (w?.subagents ?? []).slice(-8).map(s => ({ name: s.name, ...(s.detail ? { detail: s.detail } : {}), status: s.status, ...(s.result ? { result: cut(s.result, 300) } : {}) })),
			background: (w?.background ?? []).slice(-8).map(b => ({ name: cut(b.name, 120), status: b.status, ...(b.result ? { result: cut(b.result, 300) } : {}) })),
			choice: { ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) },
			...(a.choices ? { choices: a.choices } : {}),
		};
	});
	const busy = agents.some(a => a.turn === 'working' || a.turn === 'waiting' || a.turn === 'queued');
	return {
		id: state.id,
		title: state.title,
		phase: roomPhase(state, busy).phase,
		busy,
		messages: state.messages.slice(-limit).map(m => ({ id: m.id, at: m.at, author: { kind: m.author.kind, name: m.author.name }, text: cut(m.text, 12_000) })),
		agents,
	};
}

export function threadListItem(state: RoomState, activity: (agentId: string) => AgentActivity): ThreadListItem {
	const turns = state.roster.map(id => { const a = activity(id); return turnState(a.state, a.work, a.error, !!a.ran); });
	return {
		id: state.id, title: state.title, lastAt: state.messages.at(-1)?.at ?? '', agents: state.roster.length,
		busy: turns.some(t => t === 'working' || t === 'queued' || t === 'waiting'), waiting: turns.includes('waiting'),
	};
}

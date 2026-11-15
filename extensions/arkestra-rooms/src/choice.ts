/*---------------------------------------------------------------------------------------------
 *  Arkestra. The model and effort chosen for an agent in a thread (AR38). No VS Code here.
 *--------------------------------------------------------------------------------------------*/

import type { AgentChoices } from './agent';

export interface Choice {
	readonly model?: string;
	readonly effort?: string;
}

/** `Opus · high`, `default model · max`, or '' when nothing is chosen. */
export function choiceLabel(choice: Choice | undefined, choices?: AgentChoices): string {
	if (!choice?.model && !choice?.effort) {
		return '';
	}
	const model = choice.model ? choices?.models.find(m => m.id === choice.model)?.label ?? choice.model : 'default model';
	return choice.effort ? `${model} · ${choice.effort}` : model;
}

/** The efforts the model offers (the agent's default model's when no model is chosen); none: no effort choice. */
export function effortsFor(choices: AgentChoices, model: string | undefined): readonly string[] {
	const m = model ? choices.models.find(x => x.id === model) : choices.models[0];
	return m?.efforts ?? [];
}

/** A choice cleaned against what the agent offers now: an effort the model does not know is dropped. */
export function fitChoice(choice: Choice, choices: AgentChoices | undefined): Choice {
	if (!choices) {
		return choice;
	}
	const efforts = effortsFor(choices, choice.model);
	return { ...(choice.model ? { model: choice.model } : {}), ...(choice.effort && efforts.includes(choice.effort) ? { effort: choice.effort } : {}) };
}

/**
 * A model's name as the vendors' apps show it: `claude-opus-5-5` → `Opus 5.5`,
 * `claude-sonnet-4-5-20250929` → `Sonnet 4.5`, `gpt-5.1-codex` → `GPT-5.1-Codex`; an alias keeps its label.
 */
export function modelName(id: string, label?: string): string {
	const claude = /^claude-(?:(\d{1,2}(?:-\d{1,2})?)-)?([a-z]+)(?:-(\d{1,2}(?:-\d{1,2})?))?(?:-\d{8})?(?:\[[^\]]*\])?$/i.exec(id);
	if (claude) {
		const version = (claude[3] ?? claude[1] ?? '').replace('-', '.');
		const family = claude[2][0].toUpperCase() + claude[2].slice(1);
		return version ? `${family} ${version}` : family;
	}
	if (/^gpt-/i.test(id)) {
		return id.split('-').map((p, i) => i === 0 ? 'GPT' : /^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1)).join('-');
	}
	return label || id;
}

/** An effort as a word for the chip and the menu: `high` → `High`, `xhigh` → `Extra high`. */
export function effortName(effort: string): string {
	return effort === 'xhigh' ? 'Extra high' : effort ? effort[0].toUpperCase() + effort.slice(1) : effort;
}

/** The composer's chip: `Opus 5.5 · High`, `Default · Max`, or `fallback` (`Default`) when nothing is chosen. */
export function chipLabel(choice: Choice | undefined, choices: AgentChoices | undefined, fallback: string): string {
	const label = choice?.model ? modelName(choice.model, choices?.models.find(m => m.id === choice.model)?.label) : fallback;
	return choice?.effort ? `${label} · ${effortName(choice.effort)}` : label;
}

/** One row of a composer menu: a heading, a line, or a choice with its message to the extension. */
export interface MenuItem {
	readonly kind?: 'header' | 'sep';
	readonly label?: string;
	readonly detail?: string;
	readonly checked?: boolean;
	readonly action?: object;
}

/** The menu's own words, already translated. */
export interface ModelMenuStrings {
	readonly model: string;
	readonly effort: string;
	readonly default: string;
	readonly agentDefault: string;
	readonly modelDefault: string;
}

/**
 * The model menu of one agent: its models with the chosen one checked, then the chosen
 * model's efforts. A model keeps the effort when the new model knows it; an effort keeps the model.
 */
export function modelMenu(agentId: string, choice: Choice | undefined, choices: AgentChoices, t: ModelMenuStrings): MenuItem[] {
	const now = choice ?? {};
	const pick = (c: Choice) => ({ type: 'choose', agentId, ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}) });
	const items: MenuItem[] = [
		{ kind: 'header', label: t.model },
		{ label: t.default, detail: t.agentDefault, checked: !now.model, action: pick({ effort: now.effort }) },
		...choices.models.map(m => ({ label: modelName(m.id, m.label), ...(m.detail ? { detail: m.detail } : {}), checked: m.id === now.model, action: pick({ model: m.id, effort: now.effort }) })),
	];
	const efforts = effortsFor(choices, now.model);
	if (efforts.length) {
		items.push(
			{ kind: 'sep' },
			{ kind: 'header', label: t.effort },
			{ label: t.default, detail: t.modelDefault, checked: !now.effort, action: pick({ model: now.model }) },
			...efforts.map(e => ({ label: effortName(e), checked: e === now.effort, action: pick({ model: now.model, effort: e }) })),
		);
	}
	return items;
}

/** A model id as a session file names it, as people say it: `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-4-5-20250929` → `Sonnet 4.5`. */
export function sessionModelLabel(model: string): string {
	const m = /^claude-(?:(\d{1,2}(?:-\d{1,2})?)-)?([a-z]+)(?:-(\d{1,2}(?:-\d{1,2})?))?(?:-\d{8})?(\[1m\])?$/i.exec(model.trim());
	if (!m || !(m[1] || m[3])) {
		return model;
	}
	const family = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
	return `${family} ${(m[3] ?? m[1]).replace('-', '.')}${m[4] ? ' (1M)' : ''}`;
}

/**
 * The model the thread runs an agent on: the one chosen here, else the one its adopted session
 * has been running (`sessionModel`, a model id from the session file), else '' (the agent's default).
 */
export function currentModelLabel(choice: Choice | undefined, choices: AgentChoices | undefined, sessionModel: string | undefined, fallback = 'Default'): string {
	if (choice?.model || !sessionModel) {
		return chipLabel(choice, choices, fallback);
	}
	const label = choices?.models.find(m => m.id === sessionModel)?.label ?? modelName(sessionModel);
	return choice?.effort ? `${label} · ${effortName(choice.effort)}` : label;
}

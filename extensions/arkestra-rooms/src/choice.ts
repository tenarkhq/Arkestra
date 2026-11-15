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
export function currentModelLabel(choice: Choice | undefined, choices: AgentChoices | undefined, sessionModel: string | undefined): string {
	if (choice?.model || !sessionModel) {
		return choiceLabel(choice, choices);
	}
	const label = choices?.models.find(m => m.id === sessionModel)?.label ?? sessionModelLabel(sessionModel);
	return choice?.effort ? `${label} · ${choice.effort}` : label;
}

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

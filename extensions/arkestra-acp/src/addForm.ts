/*---------------------------------------------------------------------------------------------
 *  Arkestra. A new ACP agent from a form in Arkestra's own page (the new-chat page's card, the
 *  thread's invite list), not from prompts at the top of the window: from the ACP Registry or a
 *  command of one's own, its name, the machine it runs on. The form travels as plain data and the
 *  rooms draw it. No VS Code here, so it is testable; the texts come in already translated.
 *--------------------------------------------------------------------------------------------*/

import { readAgents, splitCommandLine } from './config';
import type { RegistryAgent } from './registry';

export interface AddFormStrings {
	readonly title: string;
	readonly intro: string;
	readonly noRegistry: string;
	readonly source: string;
	readonly custom: string;
	readonly needs: string;
	readonly command: string;
	readonly commandHint: string;
	readonly name: string;
	readonly nameHint: string;
	readonly machine: string;
	readonly thisMachine: string;
	readonly add: string;
	readonly cancel: string;
	readonly commandRequired: string;
	readonly unknownMachine: string;
	readonly unknownAgent: string;
}

/** The form as data, in the shape the rooms' page forms draw (pageForm.ts FormSpec). */
export function addFormSpec(registry: readonly RegistryAgent[], machines: readonly { id: string; name: string }[], t: AddFormStrings, registryRead = true): object {
	return {
		id: 'acp-add',
		title: t.title,
		intro: registryRead ? t.intro : t.noRegistry,
		submit: t.add,
		cancel: t.cancel,
		fields: [
			{
				kind: 'choice', id: 'source', label: t.source, style: 'select',
				options: [
					...registry.map(a => ({ value: `registry:${a.id}`, label: a.needsInstall ? `${a.name} · ${t.needs.replace('{0}', a.command)}` : a.name })),
					{ value: 'custom', label: t.custom },
				],
			},
			{ kind: 'text', id: 'command', label: t.command, hint: t.commandHint, placeholder: 'gemini --acp', when: { field: 'source', in: ['custom'] } },
			{ kind: 'text', id: 'name', label: t.name, hint: t.nameHint, optional: true },
			...(machines.length ? [{
				kind: 'choice', id: 'machine', label: t.machine, style: 'select',
				options: [{ value: 'local', label: t.thisMachine }, ...machines.map(m => ({ value: m.id, label: m.name }))],
			}] : []),
		],
	};
}

/**
 * The setting's new entry from the form's values: the registry agent's command or the typed one,
 * the name (empty: the agent's own, or the command), an id unique on that machine. Or the field
 * that is wrong.
 */
export function addFormEntry(values: Readonly<Record<string, unknown>>, registry: readonly RegistryAgent[], machines: readonly { id: string }[], existingRaw: unknown, t: AddFormStrings):
	{ entry: { id: string; name: string; command: string; args: string[]; machine?: string }; agent?: RegistryAgent } | { field: string; message: string } {
	const text = (k: string) => typeof values[k] === 'string' ? (values[k] as string).trim() : '';
	const source = text('source');
	let agent: RegistryAgent | undefined;
	let commandLine: string[];
	if (source === 'custom') {
		commandLine = splitCommandLine(text('command'));
		if (!commandLine.length) {
			return { field: 'command', message: t.commandRequired };
		}
	} else {
		agent = registry.find(a => `registry:${a.id}` === source);
		if (!agent) {
			return { field: 'source', message: t.unknownAgent };
		}
		commandLine = [agent.command, ...agent.args];
	}
	const machine = text('machine') || 'local';
	if (machine !== 'local' && !machines.some(m => m.id === machine)) {
		return { field: 'machine', message: t.unknownMachine };
	}
	const name = text('name') || agent?.name || commandLine[0];
	const existing = readAgents(existingRaw);
	const base = (agent?.id ?? name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
	let id = base;
	for (let n = 2; existing.some(a => a.id === id && a.machine === machine); n++) {
		id = `${base}-${n}`;
	}
	return { entry: { id, name, command: commandLine[0], args: commandLine.slice(1), ...(machine === 'local' ? {} : { machine }) }, ...(agent ? { agent } : {}) };
}

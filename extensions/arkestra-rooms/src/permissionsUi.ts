/*---------------------------------------------------------------------------------------------
 *  Arkestra. Permission lists in the settings: per machine (user settings, keyed by machine:
 *  `local` or an SSH machine's id) and per project (workspace settings). The adapters ask
 *  here before an agent acts; the question offers "always" on the machine or in the project.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EMPTY_RULES, combine, decide, fromAcpToolCall, readRules, suggestRule, type Decision, type PermissionRequest, type PermissionRules } from './permissions';

export interface PermissionsApi {
	/** Machine and project rules together, for agents that take them as flags (Claude Code). */
	rules(machine: string): PermissionRules;
	/** The rules' answer; undefined when no rule covers the request. */
	decide(machine: string, request: PermissionRequest): Decision | undefined;
	/** The rules' answer, else the user's: allow once or always, or reject. Undefined: dismissed. */
	ask(agentName: string, machine: string, request: PermissionRequest, signal: AbortSignal): Promise<Decision | undefined>;
	/** An ACP tool call in the rules' terms. */
	requestFromAcp(toolCall: unknown): PermissionRequest;
	readonly onDidChange: vscode.Event<void>;
}

const SECTION = 'arkestra.permissions';

export class Permissions implements PermissionsApi, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];

	constructor(private readonly machineName: (machine: string) => string) {
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(SECTION)) {
					this.changed.fire();
				}
			}),
			vscode.commands.registerCommand('arkestra.permissions.open', () => vscode.commands.executeCommand('workbench.action.openSettings', SECTION)),
		);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private root(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private machineRules(machine: string): PermissionRules {
		const all = vscode.workspace.getConfiguration(SECTION).get<Record<string, unknown>>('machines') ?? {};
		return all[machine] !== undefined ? readRules(all[machine]) : EMPTY_RULES;
	}

	private projectRules(): PermissionRules {
		// Only the workspace's own value: a project list in the user settings would apply everywhere.
		const inspected = vscode.workspace.getConfiguration(SECTION).inspect<unknown>('project');
		return readRules(inspected?.workspaceFolderValue ?? inspected?.workspaceValue);
	}

	requestFromAcp(toolCall: unknown): PermissionRequest {
		return fromAcpToolCall((toolCall && typeof toolCall === 'object' ? toolCall : {}) as Parameters<typeof fromAcpToolCall>[0]);
	}

	rules(machine: string): PermissionRules {
		return combine(this.machineRules(machine), this.projectRules());
	}

	decide(machine: string, request: PermissionRequest): Decision | undefined {
		return decide(this.rules(machine), request, this.root());
	}

	async ask(agentName: string, machine: string, request: PermissionRequest, signal: AbortSignal): Promise<Decision | undefined> {
		const ruled = this.decide(machine, request);
		if (ruled) {
			return ruled;
		}
		const rule = suggestRule(request, this.root());
		const once = vscode.l10n.t('Allow once');
		const onMachine = vscode.l10n.t('Always on {0}', this.machineName(machine));
		const inProject = vscode.l10n.t('Always in this project');
		const reject = vscode.l10n.t('Reject');
		const buttons = [once, onMachine, ...(vscode.workspace.workspaceFolders?.length ? [inProject] : []), reject];
		const stopped = new Promise<undefined>(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
		const pick = await Promise.race([
			vscode.window.showInformationMessage(vscode.l10n.t('{0} asks for permission: {1}', agentName, request.title), { detail: vscode.l10n.t('“Always” adds the rule {0}.', rule) }, ...buttons),
			stopped,
		]);
		if (pick === onMachine) {
			await this.add({ machine }, rule);
		} else if (pick === inProject) {
			await this.add({ project: true }, rule);
		}
		return pick === reject ? 'deny' : pick ? 'allow' : undefined;
	}

	/** Adds an allow rule to the machine's list (user settings) or the project's (workspace settings). */
	private async add(where: { machine: string } | { project: true }, rule: string): Promise<void> {
		const config = vscode.workspace.getConfiguration(SECTION);
		if ('machine' in where) {
			const all = { ...(config.inspect<Record<string, unknown>>('machines')?.globalValue ?? {}) };
			const current = readRules(all[where.machine]);
			all[where.machine] = { allow: [...new Set([...current.allow, rule])], deny: [...current.deny] };
			await config.update('machines', all, vscode.ConfigurationTarget.Global);
		} else {
			const current = this.projectRules();
			await config.update('project', { allow: [...new Set([...current.allow, rule])], deny: [...current.deny] }, vscode.ConfigurationTarget.Workspace);
		}
	}
}

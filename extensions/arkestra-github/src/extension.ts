/*---------------------------------------------------------------------------------------------
 *  Arkestra. GitHub through the Arkestra GitHub App. The app's webhooks reach the IDE through
 *  the relay on the edge server (AR28), and the workspace's GitHub Project is kept in sync
 *  both ways (AR29). The status bar shows whether the connection is live and when the last
 *  event came; the log lists every change in both directions; the project views (AR30–AR32)
 *  read and write through the API.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { RelayClient, describe, type RelayEvent, type RelayState } from './relayClient';
import { graphqlClient } from './graphql';
import { parseProjectRef, type FieldInput, type ProjectSnapshot } from './project';
import { ProjectSync, type JournalEntry, type SyncStatus } from './sync';

const TOKEN = 'arkestra.github.relayToken';
const SCOPES = ['repo', 'read:org', 'project'];

export interface ArkestraGitHubApi {
	readonly onEvent: vscode.Event<RelayEvent>;
	readonly onState: vscode.Event<RelayState>;
	state(): RelayState;
	/** When the last event arrived (ms), if any. */
	lastEventAt(): number | undefined;

	/** The workspace's GitHub Project, as last read (with changes on their way applied). */
	project(): ProjectSnapshot | undefined;
	readonly onDidChangeProject: vscode.Event<ProjectSnapshot>;
	syncStatus(): SyncStatus;
	readonly onDidChangeSyncStatus: vscode.Event<SyncStatus>;
	/** The sync journal, newest first: both directions. */
	journal(): readonly JournalEntry[];
	readonly onJournal: vscode.Event<JournalEntry>;
	refreshProject(): Promise<void>;
	setField(itemId: string, field: string, value: FieldInput): Promise<void>;
	moveTo(itemId: string, status: string): Promise<void>;
	createIssue(repository: string, title: string, body?: string, fields?: Readonly<Record<string, FieldInput>>): Promise<string>;
	addDependency(blockedItemId: string, blockingItemId: string): Promise<void>;
	removeDependency(blockedItemId: string, blockingItemId: string): Promise<void>;
	updateIssue(itemId: string, change: { title?: string; state?: 'OPEN' | 'CLOSED' }): Promise<void>;
}

/** A GitHub token: the IDE's GitHub sign-in first, then the gh CLI's. */
async function githubToken(create: boolean): Promise<string | undefined> {
	try {
		const session = await vscode.authentication.getSession('github', SCOPES, create ? { createIfNone: true } : { silent: true });
		if (session) {
			return session.accessToken;
		}
	} catch {
		// no GitHub sign-in in this build or it was cancelled: try gh
	}
	return new Promise(resolve => execFile('gh', ['auth', 'token'], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)));
}

export function activate(context: vscode.ExtensionContext): ArkestraGitHubApi {
	const events = new vscode.EventEmitter<RelayEvent>();
	const states = new vscode.EventEmitter<RelayState>();
	const projectChanged = new vscode.EventEmitter<ProjectSnapshot>();
	const syncChanged = new vscode.EventEmitter<SyncStatus>();
	const journalAdded = new vscode.EventEmitter<JournalEntry>();
	const log = vscode.window.createOutputChannel(vscode.l10n.t('Arkestra GitHub'), { log: true });
	const item = vscode.window.createStatusBarItem('arkestra.github', vscode.StatusBarAlignment.Right, 98);
	item.name = vscode.l10n.t('GitHub');
	item.command = 'arkestra.github.log';
	let state: RelayState = { kind: 'off' };
	let lastEventAt: number | undefined;
	let client: RelayClient | undefined;
	let sync: ProjectSync | undefined;
	let syncStatus: SyncStatus = { kind: 'idle' };
	let token: string | undefined;

	const ago = (ms: number) => {
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		return s < 60 ? vscode.l10n.t('{0} s', s) : s < 3600 ? vscode.l10n.t('{0} min', Math.round(s / 60)) : vscode.l10n.t('{0} h', Math.round(s / 3600));
	};
	const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const projectLine = () => {
		const snap = sync?.snapshot;
		const name = snap ? `${snap.title} (${snap.owner}/${snap.number})` : '';
		switch (syncStatus.kind) {
			case 'loading': return vscode.l10n.t('Project {0}: reading…', name || vscode.l10n.t('loading'));
			case 'synced': return syncStatus.live ? vscode.l10n.t('Project {0}: in sync · {1}', name, clock(syncStatus.at)) : vscode.l10n.t('Project {0}: read {1} · polling until the relay is back', name, clock(syncStatus.at));
			case 'error': return vscode.l10n.t('Project {0}: {1}', name, syncStatus.message);
			default: return undefined;
		}
	};
	const paint = () => {
		const project = projectLine();
		if (state.kind === 'off' && !project) {
			item.hide();
			return;
		}
		const lines: string[] = [];
		switch (state.kind) {
			case 'off':
				item.text = syncStatus.kind === 'error' ? `$(github) $(warning)` : `$(github) ${vscode.l10n.t('polling')}`;
				lines.push(vscode.l10n.t('No relay connection: the project is read every minute.'));
				break;
			case 'connecting':
				item.text = `$(sync~spin) GitHub`;
				lines.push(vscode.l10n.t('Connecting to the GitHub relay…'));
				break;
			case 'live':
				item.text = lastEventAt ? `$(github) ${vscode.l10n.t('live · {0}', ago(lastEventAt))}` : `$(github) ${vscode.l10n.t('live')}`;
				lines.push(lastEventAt ? vscode.l10n.t('GitHub webhook connection is live · last event {0} ago', ago(lastEventAt)) : vscode.l10n.t('GitHub webhook connection is live · no event yet'));
				break;
			case 'error':
				item.text = `$(github) $(warning)`;
				lines.push(vscode.l10n.t('GitHub relay: {0} · retrying in {1}', state.message, ago(2 * Date.now() - state.retryAt)));
				break;
		}
		if (project) {
			lines.push(project);
		}
		if (syncStatus.kind === 'error') {
			item.text = `$(github) $(warning)`;
		}
		item.tooltip = lines.join('\n');
		item.show();
	};
	const ticker = setInterval(() => { if (state.kind === 'live') { paint(); } }, 5000);

	const restartRelay = async () => {
		client?.stop();
		client = undefined;
		const url = vscode.workspace.getConfiguration('arkestra.github').get<string>('relayUrl')?.trim();
		const relayToken = await context.secrets.get(TOKEN);
		if (!url || !relayToken) {
			state = { kind: 'off' };
			sync?.setRelayState(state);
			paint();
			return;
		}
		client = new RelayClient({
			url, token: relayToken,
			onEvent: e => {
				lastEventAt = Date.now();
				log.info(`GitHub → ${describe(e)}`);
				events.fire(e);
				sync?.handleEvent(e);
				paint();
			},
			onState: s => {
				state = s;
				if (s.kind === 'error') {
					log.warn(`relay: ${s.message}`);
				} else if (s.kind === 'live') {
					log.info('relay: connected');
				}
				sync?.setRelayState(s);
				states.fire(s);
				paint();
			},
		});
		client.start();
	};

	const cacheKey = (owner: string, number: number) => `arkestra.github.project:${owner.toLowerCase()}/${number}`;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	const restartSync = async () => {
		sync?.dispose();
		sync = undefined;
		syncStatus = { kind: 'idle' };
		const ref = parseProjectRef(vscode.workspace.getConfiguration('arkestra.github').get<string>('project') ?? '');
		if (!ref) {
			paint();
			return;
		}
		const key = cacheKey(ref.owner, ref.number);
		const s = new ProjectSync({
			graphql: graphqlClient(async () => token ??= await githubToken(false)),
			owner: ref.owner,
			number: ref.number,
			initial: context.workspaceState.get<ProjectSnapshot>(key),
			onChange: snap => {
				projectChanged.fire(snap);
				clearTimeout(saveTimer);
				saveTimer = setTimeout(() => void context.workspaceState.update(key, snap), 2000);
			},
			onStatus: st => {
				syncStatus = st;
				if (st.kind === 'error') {
					log.warn(`project: ${st.message}`);
					if (/401|Bad credentials|not signed in/.test(st.message)) {
						token = undefined;
					}
				}
				syncChanged.fire(st);
				paint();
			},
			onJournal: e => {
				const line = `${e.direction === 'in' ? 'GitHub → here' : 'here → GitHub'} ${e.item ? `${e.item} · ` : ''}${e.text}`;
				if (e.error) {
					log.error(line);
				} else {
					log.info(line);
				}
				journalAdded.fire(e);
			},
		});
		sync = s;
		if (s.snapshot) {
			projectChanged.fire(s.snapshot);
		}
		s.setRelayState(state);
		try {
			await s.refresh();
		} catch {
			// shown in the status bar and the log
		}
	};

	const need = () => {
		if (!sync) {
			throw new Error(vscode.l10n.t('No GitHub Project is set for this workspace (arkestra.github.project).'));
		}
		return sync;
	};

	context.subscriptions.push(
		events, states, projectChanged, syncChanged, journalAdded, log, item,
		{ dispose: () => { clearInterval(ticker); clearTimeout(saveTimer); client?.stop(); sync?.dispose(); } },
		vscode.commands.registerCommand('arkestra.github.connect', async () => {
			const config = vscode.workspace.getConfiguration('arkestra.github');
			const url = (await vscode.window.showInputBox({ title: vscode.l10n.t('GitHub relay'), prompt: vscode.l10n.t('The relay\'s address on the edge server'), value: config.get<string>('relayUrl') ?? '', placeHolder: 'https://edge.example.com/arkestra', ignoreFocusOut: true }))?.trim();
			if (!url) {
				return;
			}
			const relayToken = (await vscode.window.showInputBox({ title: vscode.l10n.t('GitHub relay'), prompt: vscode.l10n.t('This client\'s token from the relay\'s clients file'), password: true, ignoreFocusOut: true }))?.trim();
			if (!relayToken) {
				return;
			}
			await context.secrets.store(TOKEN, relayToken);
			await config.update('relayUrl', url, vscode.ConfigurationTarget.Global);
			await restartRelay();
		}),
		vscode.commands.registerCommand('arkestra.github.disconnect', async () => {
			await context.secrets.delete(TOKEN);
			await restartRelay();
		}),
		vscode.commands.registerCommand('arkestra.github.install', async () => {
			const slug = vscode.workspace.getConfiguration('arkestra.github').get<string>('appSlug')?.trim();
			if (!slug) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Set the Arkestra GitHub App\'s slug first (arkestra.github.appSlug).'));
				return;
			}
			await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`));
		}),
		vscode.commands.registerCommand('arkestra.github.log', () => log.show()),
		vscode.commands.registerCommand('arkestra.github.signIn', async () => {
			token = await githubToken(true);
			if (!token) {
				void vscode.window.showWarningMessage(vscode.l10n.t('No GitHub sign-in: sign in here or with the gh CLI (gh auth login -s project).'));
				return;
			}
			await restartSync();
		}),
		vscode.commands.registerCommand('arkestra.github.setProject', async () => {
			const config = vscode.workspace.getConfiguration('arkestra.github');
			const text = await vscode.window.showInputBox({
				title: vscode.l10n.t('GitHub Project'),
				prompt: vscode.l10n.t('The project this workspace follows: owner/number or the project\'s URL'),
				value: config.get<string>('project') ?? '',
				placeHolder: 'tenarkhq/3',
				validateInput: v => !v.trim() || parseProjectRef(v) ? undefined : vscode.l10n.t('owner/number, e.g. tenarkhq/3, or https://github.com/orgs/<org>/projects/<n>'),
				ignoreFocusOut: true,
			});
			if (text === undefined) {
				return;
			}
			const ref = parseProjectRef(text);
			await config.update('project', ref ? `${ref.owner}/${ref.number}` : '', vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('arkestra.github.refreshProject', async () => {
			try {
				await need().refresh();
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('arkestra.github.relayUrl')) {
				void restartRelay();
			}
			if (e.affectsConfiguration('arkestra.github.project')) {
				void restartSync();
			}
		}),
		context.secrets.onDidChange(e => { if (e.key === TOKEN) { void restartRelay(); } }),
		vscode.authentication.onDidChangeSessions(e => { if (e.provider.id === 'github') { token = undefined; void restartSync(); } }),
	);
	void restartRelay().then(restartSync);

	return {
		onEvent: events.event,
		onState: states.event,
		state: () => state,
		lastEventAt: () => lastEventAt,
		project: () => sync?.snapshot,
		onDidChangeProject: projectChanged.event,
		syncStatus: () => syncStatus,
		onDidChangeSyncStatus: syncChanged.event,
		journal: () => sync?.journal ?? [],
		onJournal: journalAdded.event,
		refreshProject: async () => { await need().refresh(); },
		setField: (itemId, field, value) => need().setField(itemId, field, value),
		moveTo: (itemId, status) => need().moveTo(itemId, status),
		createIssue: (repository, title, body, fields) => need().createIssue(repository, title, body, fields),
		addDependency: (a, b) => need().addDependency(a, b),
		removeDependency: (a, b) => need().removeDependency(a, b),
		updateIssue: (itemId, change) => need().updateIssue(itemId, change),
	};
}

export function deactivate(): void { }

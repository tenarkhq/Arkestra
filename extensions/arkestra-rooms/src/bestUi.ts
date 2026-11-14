/*---------------------------------------------------------------------------------------------
 *  Arkestra. Best-of-N in a room: `/best [N] task` runs the attempts side by side in their own
 *  work trees, then shows the comparison with a diff, choose and discard per attempt;
 *  `/compare` lets the room's agents judge the attempts.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentRegistry } from './agent';
import type { Room } from './room';
import { attemptDiff, attemptFiles, attemptPrompt, cleanupRun, collectAttempt, comparePrompt, comparisonTable, createAttempts, parseBest, planAttempts, runAttemptTests, type BestRun } from './best';
import { git, landBranch, repoRoot } from './templates/gitio';

const SCHEME = 'arkestra-best';

export class BestOfN implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly registry: AgentRegistry, private readonly roomById: (id: string) => Promise<Room | undefined>, private readonly save: (room: Room) => Promise<void>) {
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
				provideTextDocumentContent: async uri => {
					const q = JSON.parse(uri.query) as { repo: string; ref: string; path: string };
					const r = await git(q.repo, ['show', `${q.ref}:${q.path}`]);
					return r.ok ? r.out : '';
				},
			}),
			vscode.commands.registerCommand('arkestra.best.diff', (roomId: string, runId: string, n: number) => this.diff(roomId, runId, n)),
			vscode.commands.registerCommand('arkestra.best.choose', (roomId: string, runId: string, n: number) => this.choose(roomId, runId, n)),
			vscode.commands.registerCommand('arkestra.best.discard', (roomId: string, runId: string) => this.discard(roomId, runId)),
		);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private runs(room: Room): BestRun[] {
		return room.state.best ?? (room.state.best = []);
	}

	/** The room's latest run that is finished and not decided yet. */
	openRun(room: Room): BestRun | undefined {
		return [...this.runs(room)].reverse().find(r => r.state === 'done');
	}

	async run(room: Room, prompt: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const repo = folder && await repoRoot(folder);
		if (!repo) {
			stream.markdown(vscode.l10n.t('Best-of-N works in a git repository: open one as the workspace first.'));
			return;
		}
		// Work trees are on this machine: agents running over SSH cannot work in them.
		const local = room.roster.map(id => this.registry.get(id)).filter((a): a is NonNullable<typeof a> => !!a && !a.id.includes('@'));
		const remote = room.roster.filter(id => id.includes('@'));
		if (!local.length) {
			stream.markdown(vscode.l10n.t('Best-of-N needs an agent on this machine in the room; agents over SSH cannot work in local work trees.'));
			return;
		}
		const { perAgent, task } = parseBest(prompt, local.length);
		if (!task) {
			stream.markdown(vscode.l10n.t('Write the task after /best, for example: /best 2 add input validation to the signup form'));
			return;
		}
		const base = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
		if (!base || base === 'HEAD') {
			stream.markdown(vscode.l10n.t('The workspace is not on a branch (detached HEAD); switch to one first.'));
			return;
		}
		const id = Date.now().toString(36).slice(-6);
		const plan = planAttempts(local.map(a => ({ id: a.id, name: a.name })), perAgent);
		const { baseHead, attempts } = await createAttempts(repo, base, id, plan);
		const test = vscode.workspace.getConfiguration('arkestra.bestOfN').get<string>('testCommand')?.trim() || undefined;
		const run: BestRun = { id, task, repo, base, baseHead, attempts, state: 'running', ...(test ? { test } : {}) };
		this.runs(room).push(run);
		room.post(`Best-of-N (${attempts.length} próba, ${base} @ ${baseHead.slice(0, 7)}): ${task}`);
		await this.save(room);
		if (remote.length) {
			stream.markdown(`_${vscode.l10n.t('Left out (over SSH): {0}', remote.join(', '))}_\n\n`);
		}
		stream.markdown(vscode.l10n.t('**Best-of-N**: {0} attempts from {1}, each in its own work tree.', attempts.length, base) + '\n\n');

		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		try {
			await Promise.all(attempts.map(async a => {
				const agent = this.registry.get(a.agentId)!;
				a.state = 'running';
				let last = '';
				try {
					await agent.turn({
						roomId: `${room.id}~best~${id}~${a.n}`,
						cwd: a.dir,
						transcript: [{ id: `best-${id}-${a.n}`, at: new Date().toISOString(), author: { kind: 'user', id: 'user', name: 'You' }, text: attemptPrompt(task, a, attempts.length) }],
					}, event => {
						if (event.kind === 'text') {
							last = event.text;
						} else if (event.kind === 'tool') {
							stream.progress(`${a.n}. ${a.agentName}: ${event.text}`);
						} else {
							a.error = event.text;
						}
					}, abort.signal);
					a.summary = last.split('\n').filter(l => l.trim()).slice(0, 3).join(' ');
					await collectAttempt(a, baseHead, `${a.agentName}: ${task.split('\n')[0].slice(0, 60)}`);
					if (test && !abort.signal.aborted) {
						stream.progress(vscode.l10n.t('{0}. {1}: tests…', a.n, a.agentName));
						a.tests = await runAttemptTests(a.dir, test);
					}
					a.state = a.error && !a.files ? 'failed' : 'done';
				} catch (e) {
					a.state = 'failed';
					a.error = e instanceof Error ? e.message : String(e);
				}
				stream.markdown(`_${a.n}. ${a.agentName}: ${a.state === 'failed' ? vscode.l10n.t('failed') : vscode.l10n.t('done')}_\n\n`);
			}));
		} finally {
			cancel.dispose();
		}
		run.state = 'done';
		room.post(`Best-of-N eredmény:\n\n${comparisonTable(run)}`);
		await this.save(room);
		this.showResult(room, run, stream);
	}

	showResult(room: Room, run: BestRun, stream: vscode.ChatResponseStream): void {
		stream.markdown(`${comparisonTable(run)}\n\n`);
		for (const a of run.attempts.filter(a => a.files)) {
			stream.button({ command: 'arkestra.best.diff', arguments: [room.id, run.id, a.n], title: vscode.l10n.t('Diff {0}', a.n) });
			stream.button({ command: 'arkestra.best.choose', arguments: [room.id, run.id, a.n], title: vscode.l10n.t('Choose {0}', a.n) });
		}
		stream.button({ command: 'arkestra.best.discard', arguments: [room.id, run.id], title: vscode.l10n.t('Discard all') });
		stream.markdown(`\n\n_${vscode.l10n.t('/compare asks the agents in the room to judge the attempts.')}_`);
	}

	/** The comparison round's request for the room's latest open run. */
	async comparePrompt(room: Room): Promise<string | undefined> {
		const run = this.openRun(room);
		if (!run) {
			return undefined;
		}
		const diffs = await Promise.all(run.attempts.map(a => attemptDiff(a, run.baseHead)));
		return comparePrompt(run, diffs);
	}

	private async find(roomId: string, runId: string): Promise<{ room: Room; run: BestRun } | undefined> {
		const room = await this.roomById(roomId);
		const run = room?.state.best?.find(r => r.id === runId);
		return room && run ? { room, run } : undefined;
	}

	private async diff(roomId: string, runId: string, n: number): Promise<void> {
		const found = await this.find(roomId, runId);
		const a = found?.run.attempts.find(x => x.n === n);
		if (!found || !a) {
			return;
		}
		const { run } = found;
		const files = await attemptFiles(a, run.baseHead);
		const at = (ref: string, p: string) => vscode.Uri.from({ scheme: SCHEME, path: `/${p}`, query: JSON.stringify({ repo: run.repo, ref, path: p }) });
		const resources = files.map(f => {
			const uri = vscode.Uri.file(`${a.dir}/${f.path}`);
			return [uri, f.status === 'A' ? undefined : at(run.baseHead, f.path), f.status === 'D' ? undefined : uri] as const;
		});
		await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('Attempt {0} · {1}', n, a.agentName), resources);
	}

	private async choose(roomId: string, runId: string, n: number): Promise<void> {
		const found = await this.find(roomId, runId);
		const a = found?.run.attempts.find(x => x.n === n);
		if (!found || !a || found.run.state !== 'done') {
			void vscode.window.showInformationMessage(vscode.l10n.t('This Best-of-N run is already decided.'));
			return;
		}
		const { room, run } = found;
		const result = await landBranch(run.repo, run.base, a.branch, `${a.agentName}: ${run.task.split('\n')[0].slice(0, 60)}`);
		if (!result.ok) {
			const why = result.reason === 'conflict' ? vscode.l10n.t('it conflicts with {0} in {1}', run.base, (result.files ?? []).join(', '))
				: result.reason === 'dirty' ? vscode.l10n.t('{0} has uncommitted changes in the same files ({1})', run.base, result.detail ?? '')
					: result.reason === 'diverged' ? vscode.l10n.t('{0} moved on and is not checked out anywhere', run.base)
						: result.detail ?? result.reason;
			void vscode.window.showWarningMessage(vscode.l10n.t('Attempt {0} could not be brought into {1}: {2}. The attempts stay.', n, run.base, why));
			return;
		}
		run.state = 'chosen';
		run.chosen = n;
		await cleanupRun(run);
		room.post(`Best-of-N: a(z) ${n}. próba (${a.agentName}) bekerült a ${run.base} ágba (${result.head}); a többi próba törölve.`);
		await this.save(room);
		void vscode.window.showInformationMessage(vscode.l10n.t('Attempt {0} is in {1} ({2}); the work trees are removed.', n, run.base, result.head));
	}

	private async discard(roomId: string, runId: string): Promise<void> {
		const found = await this.find(roomId, runId);
		if (!found || found.run.state !== 'done') {
			return;
		}
		found.run.state = 'discarded';
		await cleanupRun(found.run);
		found.room.post('Best-of-N: minden próba elvetve.');
		await this.save(found.room);
		void vscode.window.showInformationMessage(vscode.l10n.t('All attempts discarded.'));
	}
}

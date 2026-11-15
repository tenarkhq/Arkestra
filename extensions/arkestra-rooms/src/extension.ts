/*---------------------------------------------------------------------------------------------
 *  Arkestra. Rooms in the chat: the room is a chat participant that routes each
 *  message to every agent in it, and agents can be invited at any time.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ActivityBoard, type AgentActivity } from './activity';
import { AgentRegistry, type Agent, type ExistingSession, type InviteEntry } from './agent';
import { AgentNotReadyError, Room, RoomOpener, importedRoomState, newRoomState } from './room';
import { agentKind, cleanSessionMessages, continueOn, elsewhere, healAdopted, homeOf, isForeign, placeLocalSessions, type ListedSession } from './sessionHome';
import { RoomStore } from './store';
import { SessionFollow } from './sessionFollow';
import { laneAgent, laneEntries, type LaneEntry } from './lanes';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { progressItems, taskRooms, type TaskRoom } from './tasks';
import { TURN_TEXT, turnState, workHtml } from './work';
import { ActivityView } from './activityView';
import { currentModelLabel, fitChoice, type Choice } from './choice';
import { threadListItem, threadSnapshot, type ThreadListItem, type ThreadSnapshot } from './threadSnapshot';
import type { AgentChoices } from './agent';
import { TemplateFormPage, type TemplateRequest } from './templateForm';
import { ChangesUi } from './changesView';
import { InlineEdits } from './inlineEditUi';
import { References } from './referencesUi';
import { Permissions, type PermissionsApi } from './permissionsUi';
import { SharedContext } from './sharedUi';
import { extractMemories } from './shared';
import { BestOfN } from './bestUi';
import { ArtifactGallery } from './artifactsUi';
import { SidebarView } from './sidebarView';
import { contextPercent, ringSvg, statusText, tightestLimit, usageLine, formatTokens } from './usage';
import { GitTemplateIO, createWorkTrees } from './templates/gitio';
import { TemplateRun } from './templates/run';
import type { Role } from './templates/signals';
import type { CodeState, ReviewState, TemplateState } from './templates/types';
import { ROOM_ID_KEY, ROOM_SCHEME, historyTurns, projectName, roomIdFromHistory, roomIdFromSessionPath, summarize, titleFrom, type ProjectThreads, type ThreadSummary } from './threads';
import { ThreadViews } from './threadView';
import { DetailsView } from './detailsView';
import { LiveTurns } from './threadModel';
import type { TurnSink } from './room';

/** What adapter extensions (Claude Code, Codex, OpenAI, ACP) receive. */
export interface ArkestraRoomsApi {
	registerAgent(agent: Agent): vscode.Disposable;
	/** Permission lists per machine and project; adapters ask here before an agent acts. */
	readonly permissions: PermissionsApi;
	/** Rooms working on a task (an issue, a PR, a task number), for the project views. */
	tasks(): Promise<TaskRoom[]>;
	readonly onDidChangeTasks: vscode.Event<void>;
	/** What an agent can run with, and the choice per thread (AR38); the mobile view uses these too. */
	agentChoices(agentId: string): Promise<AgentChoices | undefined>;
	setChoice(roomId: string, agentId: string, choice: { model?: string; effort?: string }): Promise<void>;
	/** Threads for another screen (AR36, Remote Control): the list, one thread, writing to it, stopping it. */
	threads(): Promise<ThreadListItem[]>;
	thread(roomId: string): Promise<ThreadSnapshot | undefined>;
	say(roomId: string, text: string): Promise<void>;
	stop(roomId: string): Promise<void>;
	/** A thread changed: a message, an agent's state or work, its model choice. */
	readonly onDidChangeThread: vscode.Event<string>;
}

export type { ThreadListItem, ThreadSnapshot };

export type { TaskRoom };

const ACTIVE_ROOM = 'arkestra.rooms.active';

/** Room lines for Plan mode; the agents read them as instructions (kept in Hungarian, like the 2ARK briefings). */
const PLAN_ON = 'Plan mód: mostantól csak tervezünk. Olvashatjátok a kódot, de semmit ne módosítsatok: fájlt ne írjatok, módosító parancsot ne futtassatok. A válasz egy lépésekre bontott terv (mit, melyik fájlban, milyen sorrendben, hogyan ellenőrizzük); ha valami eldöntendő, kérdezzétek meg. A végrehajtás a felhasználó jóváhagyására indul.';
const PLAN_OFF = 'Plan mód vége: a felhasználó jóváhagyta a tervet. Most már módosíthattok.';
const PLAN_EXECUTE = 'Hajtsátok végre a jóváhagyott tervet, lépésenként, és a végén mondjátok el, mi készült el és hogyan ellenőriztétek.';

export function activate(context: vscode.ExtensionContext): ArkestraRoomsApi {
	const registry = new AgentRegistry();
	const store = new RoomStore(path.join(context.globalStorageUri.fsPath, 'rooms'));
	// One Room object per room: a running round and a mid-run invite must share it.
	const loaded = new Map<string, Room>();
	/** The Changes and Checkpoints views; set once the views exist. */
	let changesUi: ChangesUi | undefined;
	/** Shared rules and memory for every agent (AR23). */
	const shared = new SharedContext(context.globalStorageUri.fsPath);
	context.subscriptions.push(shared);
	/** Untitled native sessions (a new session before its first item exists) and their rooms. */
	const untitledSessions = new Map<string, string>();
	/** The room of the thread used last; the palette commands and the Agents tile follow it. */
	let current: Room | undefined;
	const activity = new ActivityBoard();
	/** The running turns, token by token, for the thread panel. */
	const live = new LiveTurns();
	const currentChanged = new vscode.EventEmitter<void>();
	const threadChanged = new vscode.EventEmitter<string>();
	context.subscriptions.push(threadChanged, activity.onDidChange(roomId => threadChanged.fire(roomId)));

	// AR39 · A thread that continues a CLI session follows it live while loaded.
	const follow = new SessionFollow(registry);
	context.subscriptions.push(follow);
	/** Rooms whose adopted sessions are being checked (a copy moved to its machine, an older import read again). */
	const healing = new Map<string, Promise<void>>();
	/** Whether a folder an agent's session worked in exists on this machine. */
	const localFolder = (cwd: string): boolean => {
		try {
			return statSync(cwd).isDirectory();
		} catch {
			return false;
		}
	};
	// AR39 · The sessions the agents' CLIs already have on their machines; an SSH listing is slow, so kept for a while.
	const sessionLists = new Map<string, { at: number; sessions: readonly ExistingSession[] }>();
	const sessionsOf = async (agent: Agent, fresh = false): Promise<readonly ExistingSession[]> => {
		const cached = sessionLists.get(agent.id);
		if (cached && !fresh && Date.now() - cached.at < 120_000) {
			return cached.sessions;
		}
		const sessions = await agent.existingSessions!();
		sessionLists.set(agent.id, { at: Date.now(), sessions });
		return sessions;
	};
	/** The SSH agents running the same CLI as this one, each with its sessions (none when the machine cannot be read). */
	const twins = (agentId: string) => Promise.all(registry.all()
		.filter(a => a.id.includes('@') && agentKind(a.id) === agentKind(agentId) && a.existingSessions && a.sessionHistory)
		.map(async a => ({ agent: a, sessions: await sessionsOf(a).catch(() => [] as readonly ExistingSession[]) })));
	/** The SSH agent that really has a session this machine holds only a copy of. */
	const sessionHome = async (agentId: string, session: { readonly id: string; readonly cwd?: string }) =>
		isForeign(agentId, session.cwd, localFolder) ? homeOf(agentId, session, localFolder, await twins(agentId)) : undefined;
	/** This machine's sessions without the copies an SSH machine has; a copy nobody has is marked. */
	const listedSessions = async (agent: Agent, fresh = false): Promise<readonly ListedSession[]> => {
		const sessions = await sessionsOf(agent, fresh);
		if (agent.id.includes('@') || !sessions.some(s => isForeign(agent.id, s.cwd, localFolder))) {
			return sessions;
		}
		return placeLocalSessions(agent.id, sessions, localFolder, (await twins(agent.id)).map(t => t.sessions));
	};
	/**
	 * Once per open: a thread that follows a copy of an SSH machine's session moves to that
	 * machine's agent and catches up there; a thread an older reader imported reads its session
	 * again (what it missed goes in at its place). Then it follows live.
	 */
	const heal = async (room: Room): Promise<void> => {
		if (await healAdopted(room.state, registry, sessionHome)) {
			room.touch();
		}
	};
	// An SSH machine's agent comes after the thread opened: a copy's thread can move to it now.
	context.subscriptions.push(registry.onDidChange(() => {
		for (const room of loaded.values()) {
			if (Object.entries(room.state.adopted ?? {}).some(([id, link]) => isForeign(id, link.cwd, localFolder))) {
				const next = (healing.get(room.id) ?? Promise.resolve()).then(() => heal(room)).catch(() => undefined).finally(() => follow.refresh(room));
				healing.set(room.id, next);
			}
		}
	}));

	const track = (room: Room): Room => {
		loaded.set(room.id, room);
		room.shared = () => shared.block();
		room.afterTurn = async (agent, reply) => {
			await changesUi?.take(room.id, vscode.l10n.t('After {0}', agent.name));
			const memories = extractMemories(reply);
			if (memories.length) {
				const added = await shared.remember(memories, agent.name);
				if (added.length) {
					room.post(`Közös memóriába felvéve (${agent.name}): ${added.join(' · ')}`);
				}
			}
		};
		room.onDidChange(() => {
			void store.save(room.state);
			threadChanged.fire(room.id);
			refreshThreadsLater();
			if (room === current) {
				currentChanged.fire();
			}
		});
		if (room.state.adopted) {
			// A session imported by an older build: the CLI's own lines it shows as the user's become short lines.
			if (cleanSessionMessages(room.state)) {
				void store.save(room.state);
			}
			healing.set(room.id, heal(room).catch(() => undefined).finally(() => follow.refresh(room)));
		}
		return room;
	};

	// One Room per thread: opens that overlap (the thread panel, the left bar, the details) share one load.
	const opener = new RoomOpener(loaded, id => store.load(id), state => track(new Room(state, registry)));
	const open = (id: string | undefined): Promise<Room | undefined> => opener.open(id);

	const use = async (room: Room): Promise<Room> => {
		if (current !== room) {
			current = room;
			currentChanged.fire();
		}
		await context.globalState.update(ACTIVE_ROOM, room.id);
		return room;
	};

	// Set once the left column exists; rooms changing before that need no refresh.
	let refreshThreadsLater: () => void = () => { };
	const createRoom = async (title: string, project?: string): Promise<Room> => {
		const workspace = project ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		const room = track(new Room(newRoomState(title, workspace), registry));
		await store.save(room.state);
		return use(room);
	};

	const currentRoom = async (): Promise<Room | undefined> => {
		if (!current) {
			const room = await open(context.globalState.get<string>(ACTIVE_ROOM));
			if (room) {
				await use(room);
			}
		}
		return current;
	};

	const describe = (entry: InviteEntry): string => entry.readiness.ready
		? vscode.l10n.t('ready')
		: entry.readiness.reason ?? vscode.l10n.t('not ready');

	/** An agent that cannot join: say why and offer what fixes it. */
	const explain = async (entry: InviteEntry): Promise<void> => {
		const actions = entry.readiness.actions ?? [];
		const picked = await vscode.window.showWarningMessage(
			vscode.l10n.t('{0} cannot join now: {1}', entry.agent.name, describe(entry)),
			...actions.map(a => a.title));
		await actions.find(a => a.title === picked)?.run();
	};

	/** Who worked in the last new thread (the new-chat page ticks them again). */
	const LAST_AGENTS = 'arkestra.rooms.lastAgents';
	/** A new thread with these agents, in a project (default: this window's). */
	const startThread = async (ids: readonly string[], project?: string): Promise<void> => {
		const room = await createRoom(vscode.l10n.t('Room'), project);
		for (const id of ids) {
			await invite(room, id);
		}
		if (ids.length) {
			await context.globalState.update(LAST_AGENTS, [...ids]);
		}
		refreshThreads();
		await threads.open(room.id);
	};

	// Model and effort per agent and thread (AR38).
	const choiceCache = new Map<string, { choices: AgentChoices; at: number }>();
	const agentChoices = async (agentId: string): Promise<AgentChoices | undefined> => {
		const agent = registry.get(agentId);
		if (!agent?.choices) {
			return undefined;
		}
		const cached = choiceCache.get(agentId);
		if (cached && Date.now() - cached.at < 10 * 60_000) {
			return cached.choices;
		}
		const choices = await agent.choices().catch(() => undefined);
		if (choices?.models.length) {
			choiceCache.set(agentId, { choices, at: Date.now() });
		}
		return choices;
	};
	const setChoice = async (room: Room, agentId: string, choice: Choice): Promise<void> => {
		const fitted = fitChoice(choice, await agentChoices(agentId));
		const all = { ...(room.state.choices ?? {}) };
		if (fitted.model || fitted.effort) {
			all[agentId] = { ...fitted };
		} else {
			delete all[agentId];
		}
		room.state.choices = all;
		await store.save(room.state);
		threadChanged.fire(room.id);
		if (room === current) {
			currentChanged.fire();
		}
	};

	const invite = async (room: Room, agentId: string): Promise<string> => {
		try {
			await room.invite(agentId);
			return vscode.l10n.t('{0} joined and received the thread from the beginning.', registry.get(agentId)?.name ?? agentId);
		} catch (error) {
			if (error instanceof AgentNotReadyError) {
				const agent = registry.get(agentId);
				if (agent) {
					void explain({ agent, readiness: error.readiness });
				}
				return vscode.l10n.t('{0} cannot join now: {1}', agent?.name ?? agentId, error.readiness.reason ?? '');
			}
			throw error;
		}
	};

	const findAgent = (query: string, entries: InviteEntry[]): InviteEntry | undefined => {
		const q = query.trim().toLowerCase();
		return entries.find(e => e.agent.id.toLowerCase() === q || e.agent.name.toLowerCase() === q)
			?? entries.find(e => e.agent.name.toLowerCase().startsWith(q));
	};

	const inviteButton = (stream: vscode.ChatResponseStream, room: Room) =>
		stream.button({ command: 'arkestra.rooms.invite', arguments: [room.id], title: vscode.l10n.t('Invite an agent') });

	context.subscriptions.push(new InlineEdits(context, registry));
	const best = new BestOfN(registry, id => open(id), room => store.save(room.state));
	context.subscriptions.push(best);
	const references = new References(async () => (await store.list()).map(state => loaded.get(state.id)?.state ?? state));
	context.subscriptions.push(references);
	changesUi = new ChangesUi(context.globalStorageUri.fsPath, async () => (await currentRoom())?.id);
	context.subscriptions.push(changesUi, currentChanged.event(() => changesUi?.refresh()));

	// ---- 2ARK template rooms (review, coding, audit) ----------------------------------------
	const runs = new Map<string, TemplateRun>();
	const ensureRun = (room: Room): TemplateRun | undefined => {
		const state = room.state.template;
		if (!state) {
			return undefined;
		}
		let run = runs.get(room.id);
		if (!run) {
			const io = new GitTemplateIO(() => state.code ? { repo: state.code.repo, base: state.code.base, dirs: state.code.dirs, branches: state.code.branches, coordinator: state.code.coordinator } : undefined);
			run = new TemplateRun(room, state, io, (_role, agentId, event) => {
				live.feed(room.id, agentId, event);
				switch (event.kind) {
					case 'start': activity.start(room.id, agentId); break;
					case 'tool': activity.tool(room.id, agentId, event.text); break;
					case 'error': activity.error(room.id, agentId, event.text); break;
					case 'usage': activity.usage(room.id, agentId, event.usage); break;
					case 'work': activity.work(room.id, agentId, event.work); break;
					case 'end': activity.end(room.id, agentId); break;
				}
			});
			runs.set(room.id, run);
		}
		return run;
	};

	/** Streams a template room into a chat response until nobody works; `pauseOnCancel`: the stop button pauses the room. */
	const streamRun = async (run: TemplateRun, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, pauseOnCancel: boolean) => {
		const quote = (text: string) => text.replace(/\n/g, '\n> ');
		const sub = run.on(e => {
			switch (e.kind) {
				case 'start': stream.progress(vscode.l10n.t('{0} is working…', e.name)); break;
				case 'agent':
					if (e.event.kind === 'tool') {
						stream.progress(`${e.name}: ${e.event.text}`);
					}
					break;
				case 'answer': if (e.text.trim()) { stream.markdown(`**${e.name}**\n\n${e.text}\n\n`); } break;
				case 'notice': stream.markdown(`_${e.text}_\n\n`); break;
				case 'wait': stream.markdown(`> **${vscode.l10n.t('Your decision is needed')}** · ${e.name}\n>\n> ${quote(e.question)}\n\n`); break;
				case 'end': stream.markdown(`**${vscode.l10n.t('Done')}:** ${e.reason}\n\n`); break;
				case 'paused': stream.markdown(`**${vscode.l10n.t('Paused')}:** ${e.reason}\n\n`); break;
			}
		});
		const cancel = token.onCancellationRequested(() => { if (pauseOnCancel) { run.pause(vscode.l10n.t('stopped by you')); } });
		try {
			const outcome = await Promise.race([run.settled(), new Promise<'cancelled'>(resolve => token.onCancellationRequested(() => resolve('cancelled')))]);
			if (outcome === 'ended' && run.state.pending) {
				stream.markdown(vscode.l10n.t('The room reached its limit of {0} hand-overs. Type /continue to go on.', run.state.max) + '\n\n');
			} else if (outcome === 'waiting' && run.state.code?.planState === 'waiting') {
				stream.markdown(vscode.l10n.t('Approve the slice plan with /approve, or write what to change.') + '\n\n');
			} else if (outcome === 'paused') {
				stream.markdown(vscode.l10n.t('Write into the room or type /continue to resume.') + '\n\n');
			}
		} finally {
			sub.dispose();
			cancel.dispose();
		}
	};

	/** One message to a room, from the chat or the thread panel. */
	type RoomRequest = { readonly prompt: string; readonly command?: string; readonly references?: readonly vscode.ChatPromptReference[] };
	/** A plain round's events: the activity board, the thread panel's live turn, then the caller's own. */
	const roundSink = (room: Room, extra?: TurnSink): TurnSink => (agent, event) => {
		switch (event.kind) {
			case 'start': activity.start(room.id, agent.id); break;
			case 'tool': activity.tool(room.id, agent.id, event.text); break;
			case 'error': activity.error(room.id, agent.id, event.text); break;
			case 'usage': activity.usage(room.id, agent.id, event.usage); break;
			case 'work': activity.work(room.id, agent.id, event.work); break;
			case 'end': activity.end(room.id, agent.id); break;
		}
		live.feed(room.id, agent.id, event);
		extra?.(agent, event);
	};

	/** The user's word in a template room goes to the template, not to a plain round. */
	/** `prompt`: the message with its @-referenced material; addressing reads the user's own text. */
	const templateTurn = async (room: Room, request: RoomRequest, prompt: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
		const run = ensureRun(room)!;
		run.unpause();
		if (request.command === 'continue') {
			if (run.state.pending) {
				run.engine.resume();
			} else if (request.prompt.trim()) {
				room.addUser(prompt);
				await run.engine.user(prompt, run.addressed(request.prompt));
			} else {
				run.state.ended = undefined;
				for (const role of ['A', 'B'] as Role[]) {
					if (run.state.waiting[role] === undefined) {
						continue;
					}
					await run.engine.user(vscode.l10n.t('Continue.'), [role]);
				}
			}
		} else if (request.command === 'approve') {
			if (request.prompt.trim()) {
				room.addUser(prompt);
			}
			run.engine.approvePlan(prompt.trim());
		} else {
			room.addUser(prompt);
			await run.engine.user(prompt, run.addressed(request.prompt));
		}
		await streamRun(run, stream, token, true);
	};

	/** One message to a room (slash commands, template rooms, Best-of-N, Plan mode, a plain round); the chat and the thread panel both send through here. */
	const sendToRoom = async (room: Room, request: RoomRequest, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> => {
		// The message with its @-referenced material, resolved only when it goes to agents.
		const expand = async () => {
			const expanded = await references.expand(request.prompt, request.references, room.id);
			if (expanded.notes.length) {
				stream.markdown(`_${vscode.l10n.t('Attached: {0}', expanded.notes.join(' · '))}_\n\n`);
			}
			return expanded.text;
		};

		if (request.command === 'agents' || request.command === 'invite') {
			const entries = await registry.inviteList(room.roster);
			if (request.command === 'invite' && request.prompt.trim()) {
				const target = findAgent(request.prompt, entries);
				stream.markdown(target ? await invite(room, target.agent.id) : vscode.l10n.t('No agent named "{0}".', request.prompt.trim()));
				return;
			}
			if (request.command === 'invite') {
				// The invite list opens on the thread's page, above + agent.
				await vscode.commands.executeCommand('arkestra.rooms.invite', room.id);
				return;
			}
			const inRoom = room.roster.map(id => registry.get(id)?.name ?? id).join(', ') || vscode.l10n.t('nobody yet');
			stream.markdown(vscode.l10n.t('In this room: {0}', inRoom) + '\n\n');
			for (const entry of entries) {
				stream.markdown(`- **${entry.agent.name}** · ${entry.agent.detail} · ${describe(entry)}\n`);
			}
			inviteButton(stream, room);
			return;
		}

		if (request.command === 'template') {
			await vscode.commands.executeCommand('arkestra.rooms.newTemplateRoom');
			return;
		}

		if (room.state.template) {
			if (request.command === 'best' || request.command === 'compare') {
				stream.markdown(vscode.l10n.t('Best-of-N runs in a plain room, not in a template room.'));
				return;
			}
			if (request.command === 'plan' || request.command === 'execute') {
				stream.markdown(vscode.l10n.t('A template room has its own plan step: the slice plan waits for /approve when the room was set up so.'));
				return;
			}
			await templateTurn(room, request, await expand(), stream, token);
			return;
		}

		if (request.command === 'best') {
			await best.run(room, await expand(), stream, token);
			return;
		}

		// Plan mode: the agents read and plan; nothing changes until /execute.
		let fallback: string | undefined;
		if (request.command === 'plan') {
			if (room.state.mode !== 'plan') {
				room.state.mode = 'plan';
				room.post(PLAN_ON);
				await store.save(room.state);
			}
			if (!request.prompt.trim()) {
				stream.markdown(vscode.l10n.t('Plan mode is on: the agents may read the code but change nothing. Write the task; when the plan is right, /execute runs it.'));
				return;
			}
		} else if (request.command === 'compare') {
			const compare = await best.comparePrompt(room);
			if (!compare) {
				stream.markdown(vscode.l10n.t('There is no finished Best-of-N run to compare in this room. Start one with /best.'));
				return;
			}
			fallback = request.prompt.trim() ? `${compare}\n\nA felhasználó kiegészítése: ${await expand()}` : compare;
		} else if (request.command === 'execute') {
			if (room.state.mode !== 'plan') {
				stream.markdown(vscode.l10n.t('This room is not in Plan mode. Start one with /plan.'));
				return;
			}
			room.state.mode = undefined;
			room.post(PLAN_OFF);
			await store.save(room.state);
			fallback = PLAN_EXECUTE;
		}

		if (!room.roster.length) {
			stream.markdown(vscode.l10n.t('There is no agent in this room yet. Invite one with /invite.'));
			inviteButton(stream, room);
			return;
		}

		// Clickable while the round runs: whoever joins answers in this round too.
		inviteButton(stream, room);
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		activity.queue(room.id, room.roster);
		const prompt = fallback !== undefined && (request.command === 'compare' || !request.prompt.trim()) ? fallback : await expand();
		await changesUi?.take(room.id, vscode.l10n.t('Before: {0}', titleFrom(request.prompt, vscode.l10n.t('Room'))));
		try {
			await room.say(prompt, roundSink(room, (agent, event) => {
				switch (event.kind) {
					case 'start': stream.markdown(`\n\n**${agent.name}**\n\n`); break;
					case 'text': stream.markdown(event.text); break;
					case 'tool': stream.progress(`${agent.name}: ${event.text}`); break;
					case 'error': stream.markdown(`\n\n> ${agent.name}: ${event.text}\n`); break;
				}
			}), abort.signal);
		} finally {
			activity.settle(room.id);
			cancel.dispose();
		}
		if (room.state.mode === 'plan') {
			stream.markdown(`\n\n_${vscode.l10n.t('Plan mode: nothing was changed. Refine the plan, or run it with /execute.')}_`);
		}
		const compared = request.command === 'compare' ? best.openRun(room) : undefined;
		if (compared) {
			stream.markdown('\n\n');
			best.showResult(room, compared, stream); // the choice stays the user's
		}
	};

	const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token): Promise<vscode.ChatResult> => {
		// This thread's room: a native Arkestra session carries it in its URI, an @room chat in
		// its history; a thread without one (a new chat) gets a new room.
		const session = chatContext.chatSessionContext?.chatSessionItem.resource;
		const sessionRoomId = session ? roomIdFromSessionPath(session.path) ?? untitledSessions.get(session.toString()) : undefined;
		const room = request.command === 'new'
			? await createRoom(titleFrom(request.prompt, vscode.l10n.t('Room')))
			: await use(await open(sessionRoomId ?? roomIdFromHistory(chatContext.history)) ?? await createRoom(titleFrom(request.prompt, vscode.l10n.t('Room'))));
		if (session && !roomIdFromSessionPath(session.path)) {
			untitledSessions.set(session.toString(), room.id);
		}
		const result: vscode.ChatResult = { metadata: { [ROOM_ID_KEY]: room.id } };
		if (request.command === 'new') {
			stream.markdown(vscode.l10n.t('New room: **{0}**. Invite agents with /invite.', room.state.title));
			inviteButton(stream, room);
			return result;
		}
		await sendToRoom(room, request, stream, token);
		return result;
	};

	// The room's tokens, the fullest context and quota in the status bar (AR25).
	const usageItem = vscode.window.createStatusBarItem('arkestra.usage', vscode.StatusBarAlignment.Right, 99);
	usageItem.name = vscode.l10n.t('Agent usage');
	usageItem.command = 'arkestra.rooms.showAgents';
	const renderUsage = async () => {
		const room = await currentRoom();
		const rows = room ? room.roster.map(id => ({ name: registry.get(id)?.name ?? id, usage: activity.get(room.id, id).usage })) : [];
		const text = statusText(rows.map(r => r.usage));
		if (!text) {
			usageItem.hide();
			return;
		}
		usageItem.text = `$(pulse) ${text}`;
		const md = new vscode.MarkdownString(`**${vscode.l10n.t('Agents in this room')}**\n\n| | ${vscode.l10n.t('Context')} | ${vscode.l10n.t('Quota')} | ${vscode.l10n.t('Tokens')} |\n|---|---|---|---|\n`);
		for (const r of rows) {
			const ctx = contextPercent(r.usage);
			const limit = tightestLimit(r.usage);
			md.appendMarkdown(`| ${r.name} | ${ctx !== undefined ? `${ctx}% (${formatTokens(r.usage!.context!.used)})` : '–'} | ${limit ? `${limit.usedPercent}% · ${limit.label}` : '–'} | ${usageLine(r.usage) || '–'} |\n`);
		}
		usageItem.tooltip = md;
		usageItem.show();
	};
	context.subscriptions.push(usageItem, currentChanged.event(() => void renderUsage()), activity.onDidChange(roomId => { void currentRoom().then(r => { if (r?.id === roomId) { void renderUsage(); } }); }));

	// The Agents tile: who is in the current room and what each one is doing.
	let agentsPanel: vscode.WebviewPanel | undefined;
	const renderAgents = async () => {
		if (!agentsPanel) {
			return;
		}
		const room = await currentRoom();
		agentsPanel.title = room ? vscode.l10n.t('Agents · {0}', room.state.title) : vscode.l10n.t('Agents');
		agentsPanel.webview.html = agentsHtml(room ? room.roster.map(id => {
			const agent = registry.get(id);
			return { id, name: agent?.name ?? id, detail: agent?.detail ?? vscode.l10n.t('not available now'), activity: activity.get(room.id, id), choice: currentModelLabel(room.state.choices?.[id], choiceCache.get(id)?.choices, room.state.adopted?.[id]?.model), canChoose: !!agent?.choices };
		}) : undefined);
	};
	const adoptAgentsPanel = (panel: vscode.WebviewPanel) => {
		agentsPanel = panel;
		panel.iconPath = new vscode.ThemeIcon('organization');
		panel.webview.options = { enableScripts: true };
		panel.onDidDispose(() => { agentsPanel = undefined; });
		panel.webview.onDidReceiveMessage(async (message: { type?: string; agentId?: string }) => {
			if (message.type === 'invite') {
				await vscode.commands.executeCommand('arkestra.rooms.invite', (await currentRoom())?.id);
			}
			if (message.type === 'choose' && typeof message.agentId === 'string') {
				await vscode.commands.executeCommand('arkestra.rooms.chooseModel', (await currentRoom())?.id, message.agentId);
			}
		});
		void renderAgents();
	};
	const showAgents = async (column?: unknown) => {
		const viewColumn = typeof column === 'number' && column > 0 ? column : vscode.ViewColumn.Beside;
		if (agentsPanel) {
			agentsPanel.reveal(viewColumn, true);
			return;
		}
		adoptAgentsPanel(vscode.window.createWebviewPanel('arkestra.agents', vscode.l10n.t('Agents'), { viewColumn, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: false }));
	};
	context.subscriptions.push(
		currentChanged,
		currentChanged.event(() => void renderAgents()),
		activity.onDidChange(roomId => { if (roomId === current?.id) { void renderAgents(); } }),
		vscode.window.registerWebviewPanelSerializer('arkestra.agents', { deserializeWebviewPanel: async panel => adoptAgentsPanel(panel) }),
		vscode.commands.registerCommand('arkestra.rooms.showAgents', showAgents),
	);

	// Agent activity in every thread and in total (AR37): the Activity view and the status bar.
	context.subscriptions.push(new ActivityView(activity, id => loaded.get(id)?.state.title ?? id, id => registry.get(id)?.name ?? id));

	// Pult lanes: one tile per agent slot of the current room (slot n = the room's n-th agent).
	const lanes = new Map<number, vscode.WebviewPanel>();
	const renderLane = async (slot: number) => {
		const panel = lanes.get(slot);
		if (!panel) {
			return;
		}
		const room = await currentRoom();
		const agentId = room ? laneAgent(room.roster, slot) : undefined;
		const agent = agentId ? registry.get(agentId) : undefined;
		panel.title = agentId ? agent?.name ?? agentId : vscode.l10n.t('Free lane');
		panel.webview.html = laneHtml(slot, room && agentId ? {
			name: agent?.name ?? agentId,
			detail: agent?.detail ?? vscode.l10n.t('not available now'),
			activity: activity.get(room.id, agentId),
			entries: laneEntries(room.messages, agentId),
		} : undefined, !!room);
	};
	const renderLanes = () => { for (const slot of lanes.keys()) { void renderLane(slot); } };
	const adoptLane = (panel: vscode.WebviewPanel, slot: number) => {
		lanes.get(slot)?.dispose();
		lanes.set(slot, panel);
		panel.iconPath = new vscode.ThemeIcon('person');
		panel.webview.options = { enableScripts: true };
		panel.onDidDispose(() => { if (lanes.get(slot) === panel) { lanes.delete(slot); } });
		panel.webview.onDidReceiveMessage(async (message: { type?: string }) => {
			if (message.type === 'invite') {
				await vscode.commands.executeCommand('arkestra.rooms.invite', (await currentRoom())?.id);
			}
		});
		void renderLane(slot);
	};
	const showLane = async (slot?: unknown, column?: unknown) => {
		const n = typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 ? slot : 0;
		const viewColumn = typeof column === 'number' && column > 0 ? column : vscode.ViewColumn.Beside;
		const existing = lanes.get(n);
		if (existing) {
			existing.reveal(viewColumn, true);
			return;
		}
		adoptLane(vscode.window.createWebviewPanel('arkestra.lane', vscode.l10n.t('Lane'), { viewColumn, preserveFocus: true }, { enableScripts: true }), n);
	};
	context.subscriptions.push(
		currentChanged.event(renderLanes),
		activity.onDidChange(roomId => { if (roomId === current?.id) { renderLanes(); } }),
		vscode.window.registerWebviewPanelSerializer('arkestra.lane', {
			deserializeWebviewPanel: async (panel, state: { slot?: unknown } | undefined) => adoptLane(panel, typeof state?.slot === 'number' ? state.slot : 0),
		}),
		vscode.commands.registerCommand('arkestra.rooms.showLane', showLane),
		// The agents of the current room in answer order; Pult sizes its lanes from it.
		vscode.commands.registerCommand('arkestra.rooms.roster', async () => [...(await currentRoom())?.roster ?? []]),
	);

	const participant = vscode.chat.createChatParticipant('arkestra.room', handler);
	participant.iconPath = new vscode.ThemeIcon('organization');
	participant.participantVariableProvider = references.completionProvider();

	// Threads open in Arkestra's own panel; the right panel follows the one used last.
	const threads = new ThreadViews(context, {
		registry, activity, live, onDidChangeThread: threadChanged.event, open, use,
		createRoom: async (agentIds, title, project) => {
			const room = await createRoom(title, project);
			for (const id of agentIds) {
				await invite(room, id);
			}
			if (agentIds.length) {
				await context.globalState.update(LAST_AGENTS, [...agentIds]);
			}
			refreshThreads();
			return room;
		},
		send: sendToRoom,
		stop: roomId => remoteStop(roomId),
		modelLabel: async (room, agentId) => currentModelLabel(room.state.choices?.[agentId], await agentChoices(agentId), room.state.adopted?.[agentId]?.model, vscode.l10n.t('Default')),
		agentChoices,
		setChoice,
		invite,
		setMode: async (room, mode) => {
			if (room.state.mode === mode || room.state.template) {
				return;
			}
			room.state.mode = mode;
			room.post(mode === 'plan' ? PLAN_ON : PLAN_OFF);
			await store.save(room.state);
			threadChanged.fire(room.id);
		},
		// A thread whose local agent's CLI is not on this computer: the SSH machine that has its session takes over.
		sessionElsewhere: async (room, agentId) => {
			const agent = elsewhere(agentId, room.state.adopted?.[agentId]?.session, await twins(agentId));
			return agent ? { id: agent.id, machine: agent.name.split(' · ')[1] || agent.id.slice(agent.id.indexOf('@') + 1) } : undefined;
		},
		continueOn: async (room, from, to) => {
			const agent = registry.get(to);
			if (agent && await continueOn(room.state, from, agent)) {
				room.touch();
				follow.refresh(room);
			}
		},
	});
	context.subscriptions.push(threads, new DetailsView({
		registry, activity, onDidChangeThread: threadChanged.event, threads, open,
		changes: async roomId => await changesUi?.checkpoints()?.changes(roomId) ?? [],
	}));

	// ---- Threads as native chat sessions: history, session list, the left column ----------
	const sessionUri = (roomId: string) => vscode.Uri.from({ scheme: ROOM_SCHEME, path: `/room/${roomId}` });
	const sessionParticipant = vscode.chat.createChatParticipant(ROOM_SCHEME, handler);
	sessionParticipant.iconPath = new vscode.ThemeIcon('organization');
	sessionParticipant.participantVariableProvider = references.completionProvider();
	// ChatRequestTurn's constructor is internal in the typings; the runtime class takes these arguments.
	const RequestTurn = vscode.ChatRequestTurn as unknown as new (prompt: string, command: string | undefined, references: [], participant: string, toolReferences: []) => vscode.ChatRequestTurn;

	// The artifact gallery: every agent's output of every thread (AR26).
	const gallery = new ArtifactGallery(context, async () => (await store.list()).map(state => loaded.get(state.id)?.state ?? state), async roomId => {
		await threads.open(roomId);
	});
	context.subscriptions.push(gallery, currentChanged.event(() => gallery.refresh()));

	const allThreads = async (): Promise<ThreadSummary[]> => (await store.list()).map(state => summarize(loaded.get(state.id)?.state ?? state));
	const busy = (roomId: string) => (loaded.get(roomId)?.roster ?? []).some(id => activity.get(roomId, id).state !== 'idle');

	const controller = vscode.chat.createChatSessionItemController(ROOM_SCHEME, async () => {
		const threads = await allThreads();
		controller.items.replace(threads.map(t => {
			const item = controller.createChatSessionItem(sessionUri(t.id), t.title);
			item.description = [projectName(t.project), t.category].filter(Boolean).join(' · ') || undefined;
			item.iconPath = new vscode.ThemeIcon(t.pinned ? 'pinned' : 'organization');
			item.status = busy(t.id) ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
			if (t.lastAt) {
				item.timing = { created: Date.parse(t.lastAt), lastRequestEnded: Date.parse(t.lastAt) };
			}
			return item;
		}));
	});
	controller.newChatSessionItemHandler = async context => {
		const room = await createRoom(titleFrom(context.request.prompt, vscode.l10n.t('Room')));
		return controller.createChatSessionItem(sessionUri(room.id), room.state.title);
	};

	const contentProvider: vscode.ChatSessionContentProvider = {
		provideChatSessionContent: async (resource): Promise<vscode.ChatSession> => {
			const roomId = roomIdFromSessionPath(resource.path) ?? untitledSessions.get(resource.toString());
			const room = await open(roomId);
			if (room) {
				await use(room);
			}
			const history = historyTurns(room?.messages ?? []).map(turn => turn.kind === 'request'
				? new RequestTurn(turn.prompt, undefined, [], ROOM_SCHEME, [])
				: new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(turn.markdown)], { metadata: room ? { [ROOM_ID_KEY]: room.id } : {} }, ROOM_SCHEME));
			const run = room && runs.get(room.id);
			return {
				...(room ? { title: room.state.title } : {}),
				history,
				requestHandler: handler,
				// A template room still working streams on in the opened thread.
				...(run?.busy ? { activeResponseCallback: (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => streamRun(run, stream, token, false) } : {}),
			};
		},
	};

	// The left bar (arkestra.sidebar): fed with the threads, the boards, the pins and the machines' sessions.
	const changedThreads = new vscode.EventEmitter<void>();
	type BoardEntry = { readonly key: string; readonly title: string; readonly workspace: boolean; readonly pinned: boolean };
	interface GitHubBoards { boards(): readonly BoardEntry[]; readonly onDidChangeBoards: vscode.Event<void> }
	let github: GitHubBoards | undefined;
	// Not awaited: the GitHub extension waits for this one while it starts.
	void Promise.resolve(vscode.extensions.getExtension<GitHubBoards>('vscode.arkestra-github')?.activate()).then(api => {
		if (api?.boards) {
			github = api;
			context.subscriptions.push(api.onDidChangeBoards(() => changedThreads.fire()));
			changedThreads.fire();
		}
	}, () => undefined);
	const sessionAgents = () => registry.all().filter(a => a.existingSessions && a.sessionHistory && a.adoptSession).sort((a, b) => a.name.localeCompare(b.name));
	/** Sessions being continued now, by CLI and session id: a second click waits for the first. */
	const adopting = new Map<string, Promise<string | undefined>>();
	/**
	 * The thread that continues a CLI session (AR39): the one made before (it catches up first
	 * when it is to be shown), else a new one with the session's history that follows it live.
	 * A copy here of an SSH machine's session goes on there. Its room id; a failed read throws.
	 */
	const adoptSession = (agentId: string, asSession: ExistingSession, show: boolean): Promise<string | undefined> => {
		const key = `${agentKind(agentId)}\n${asSession.id}`;
		const running = adopting.get(key);
		if (running) {
			return running;
		}
		const work = (async (): Promise<string | undefined> => {
			const asked = registry.get(agentId);
			if (!asked?.sessionHistory) {
				return undefined;
			}
			// A copy here of an SSH machine's session goes on there: that is where it grows and where Claude runs it.
			const { agent, session } = await sessionHome(asked.id, asSession) ?? { agent: asked, session: asSession };
			if (!agent.sessionHistory) {
				return undefined;
			}
			// A session continued here before opens its thread again (also one that followed this machine's copy of it).
			const before = (await store.list()).find(s => Object.entries(s.adopted ?? {}).some(([id, link]) => link.session === session.id && agentKind(id) === agentKind(agent.id)));
			if (before) {
				// It catches up on what the session wrote since, then follows it live (AR39).
				if (show && await open(before.id)) {
					await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the {0} session…', agent.name) }, async () => {
						await healing.get(before.id);
						await follow.caughtUp(before.id);
					});
				}
				return before.id;
			}
			// The history and where its live follow goes on: nothing written after the read is lost.
			const history = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the {0} session…', agent.name) }, () => agent.sessionHistory!(session.id));
			// A local session's folder is its project; an SSH machine's folder is not one here.
			const project = !agent.id.includes('@') && session.cwd ? vscode.Uri.file(session.cwd).toString() : undefined;
			const room = track(new Room(importedRoomState({ id: agent.id, name: agent.name, ...(agent.historyVersion !== undefined ? { historyVersion: agent.historyVersion } : {}) }, session, history, project), registry));
			await store.save(room.state);
			refreshThreads();
			return room.id;
		})().finally(() => adopting.delete(key));
		adopting.set(key, work);
		return work;
	};
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const refreshThreads: () => void = () => {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			changedThreads.fire();
			void controller.refreshHandler(new vscode.CancellationTokenSource().token);
			gallery.refresh();
		}, 300);
	};
	refreshThreadsLater = refreshThreads;
	const tasksChanged = new vscode.EventEmitter<void>();
	context.subscriptions.push(tasksChanged, changedThreads.event(() => tasksChanged.fire()));
	const tasks = async (): Promise<TaskRoom[]> => {
		const states = (await store.list()).map(state => loaded.get(state.id)?.state ?? state);
		const progress = new Map<string, { text: string; done: boolean }[]>();
		await Promise.all(states.filter(s => s.template).map(async s => {
			try {
				progress.set(s.id, progressItems(await readFile(path.join(context.globalStorageUri.fsPath, 'room-files', s.id, 'haladas.md'), 'utf8')));
			} catch {
				// no progress list yet
			}
		}));
		return taskRooms(states, busy, id => progress.get(id));
	};
	const threadId = (arg: unknown) => typeof arg === 'string' ? arg : (arg as { thread?: ThreadSummary } | undefined)?.thread?.id;
	const editRoom = async (arg: unknown, edit: (room: Room) => void) => {
		const room = await open(threadId(arg));
		if (room) {
			edit(room);
			await store.save(room.state);
			refreshThreads();
		}
	};

	// A 2ARK template room from its page: the room, both agents, its folder and work trees, then its thread.
	const startTemplateRoom = async (req: TemplateRequest): Promise<void> => {
		const room = await createRoom(req.title);
		for (const role of ['A', 'B'] as Role[]) {
			await room.invite(req.members[role].id);
		}
		const folder = path.join(context.globalStorageUri.fsPath, 'room-files', room.id);
		await mkdir(folder, { recursive: true });
		let review: ReviewState | undefined;
		if (req.review) {
			const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
			const local = req.review.source && !/^https?:/.test(req.review.source) ? path.resolve(project, req.review.source) : undefined;
			const isFile = local ? await stat(local).then(st => st.isFile(), () => false) : false;
			if (local && isFile) {
				await copyFile(local, path.join(folder, 'v1.md'));
			}
			review = {
				reviewer: req.review.reviewer,
				prompt: req.review.source && !isFile ? `${req.review.prompt}\n\nAz anyag: ${req.review.source}` : req.review.prompt,
				...(req.review.source ? { source: req.review.source } : {}),
				version: isFile ? 1 : 0,
				strict: req.review.strict,
			};
		}
		let code: CodeState | undefined;
		if (req.code) {
			const trees = await createWorkTrees(req.code.repo, req.code.base, room.id, { A: req.members.A.name, B: req.members.B.name });
			code = { ...req.code, ...trees };
		}
		const state: TemplateState = {
			type: req.type, members: req.members, folder, rounds: 0, max: req.max, briefed: {}, waiting: {},
			...(review ? { review } : {}),
			...(code ? { code } : {}),
			...(req.audit ? { audit: { ...req.audit, phase: 'audit' as const, done: {} } } : {}),
		};
		room.state.template = state;
		await store.save(room.state);
		ensureRun(room)!.engine.start();
		refreshThreads();
		await threads.open(room.id);
	};
	const templatePage = new TemplateFormPage(registry, startTemplateRoom);
	context.subscriptions.push(templatePage);

	context.subscriptions.push(
		sessionParticipant,
		controller,
		changedThreads,
		vscode.chat.registerChatSessionContentProvider(ROOM_SCHEME, contentProvider, sessionParticipant),
		new SidebarView(context, {
			threads: allThreads,
			busy,
			currentThread: () => current?.id,
			boards: () => github?.boards() ?? [],
			pinnedArtifacts: () => gallery.pinnedArtifacts(),
			machineSessions: () => sessionAgents().map(a => ({ id: a.id, name: a.name, sessions: (fresh?: boolean) => listedSessions(a, fresh) })),
			adoptSession: (agentId, session) => adoptSession(agentId, session, false),
			refreshSessions: () => sessionLists.clear(),
			continuedSessions: async () => new Map((await store.list()).flatMap(s => Object.entries((loaded.get(s.id)?.state ?? s).adopted ?? {}).map(([agentId, a]) => [`${agentId}\n${a.session}`, s.id] as const))),
			onDidChange: changedThreads.event,
		}),
		gallery.onDidChangePins(() => changedThreads.fire()),
		activity.onDidChange(refreshThreads),
		currentChanged.event(refreshThreads),
		vscode.workspace.onDidChangeWorkspaceFolders(refreshThreads),
		vscode.commands.registerCommand('arkestra.rooms.refreshSessions', () => {
			sessionLists.clear();
			changedThreads.fire();
		}),
		vscode.commands.registerCommand('arkestra.rooms.continueSession', async (arg: unknown, sessionArg?: ExistingSession) => {
			const node = arg as { agentId?: string; session?: ExistingSession } | undefined;
			const agentId = typeof arg === 'string' ? arg : node?.agentId ?? '';
			const asSession = sessionArg ?? node?.session;
			if (!asSession) {
				return;
			}
			try {
				const room = await adoptSession(agentId, asSession, true);
				if (room) {
					await vscode.commands.executeCommand('arkestra.rooms.openThread', room);
				}
			} catch (error) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Could not read the session: {0}', error instanceof Error ? error.message : String(error)));
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.openThread', async (arg: unknown, column?: unknown) => {
			const id = threadId(arg) ?? (await currentRoom())?.id;
			if (id) {
				await threads.open(id, typeof column === 'number' ? column : undefined);
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.newTemplateRoom', async (arg?: unknown) => {
			// From a project view: { type, brief } presets the form (the task's link as the brief).
			const preset = arg && typeof arg === 'object' && !Array.isArray(arg) ? arg as { type?: 'coding' | 'audit' | 'review'; brief?: string } : undefined;
			await templatePage.open((await currentRoom())?.roster, preset);
		}),
		vscode.commands.registerCommand('arkestra.rooms.newThread', async (arg?: unknown) => {
			// From a project's row: a thread of that project.
			const project = (arg as { kind?: string; group?: ProjectThreads } | undefined)?.group?.project;
			threads.openNew(project ? { project } : {});
		}),
		vscode.commands.registerCommand('arkestra.rooms.newThreadWith', async (arg?: unknown) => {
			const id = typeof arg === 'string' ? arg : (arg as { entry?: InviteEntry } | undefined)?.entry?.agent.id;
			if (id) {
				await startThread([id]);
			} else {
				threads.openNew(); // who works in it is chosen on the new-chat page
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.pin', arg => editRoom(arg, room => { room.state.pinned = true; })),
		vscode.commands.registerCommand('arkestra.rooms.unpin', arg => editRoom(arg, room => { delete room.state.pinned; })),
		vscode.commands.registerCommand('arkestra.rooms.archive', arg => editRoom(arg, room => { room.state.archived = true; delete room.state.pinned; })),
		vscode.commands.registerCommand('arkestra.rooms.unarchive', arg => editRoom(arg, room => { delete room.state.archived; })),
		vscode.commands.registerCommand('arkestra.rooms.delete', async (arg: unknown) => {
			const room = await open(threadId(arg));
			if (!room) {
				return;
			}
			const yes = vscode.l10n.t('Delete');
			const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Delete the thread “{0}” for good? Its messages cannot be brought back.', room.state.title), { modal: true }, yes);
			if (answer !== yes) {
				return;
			}
			const uri = sessionUri(room.id).toString();
			const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(tab => (tab.input as { uri?: vscode.Uri } | undefined)?.uri?.toString() === uri);
			if (tabs.length) {
				await vscode.window.tabGroups.close(tabs);
			}
			threads.close(room.id);
			runs.delete(room.id);
			loaded.delete(room.id);
			follow.detach(room.id);
			if (current === room) {
				current = undefined;
				await context.globalState.update(ACTIVE_ROOM, undefined);
				currentChanged.fire();
			}
			await store.remove(room.id);
			refreshThreads();
		}),
		vscode.commands.registerCommand('arkestra.rooms.rename', async (arg: unknown, name?: unknown) => {
			// The left bar renames in place and passes the new name.
			const room = await open(threadId(arg));
			const title = typeof name === 'string' ? name.trim() : '';
			if (room && title) {
				await editRoom(room.id, r => { r.state.title = title; });
			}
		}),
	);

	context.subscriptions.push(
		participant,
		// The new-chat page: who works in the thread, then its first message.
		vscode.commands.registerCommand('arkestra.rooms.new', () => threads.openNew()),
		vscode.commands.registerCommand('arkestra.rooms.invite', async (roomId?: unknown) => {
			// From a thread's page, a tile or /invite: that thread. From the palette: the thread used last. The list opens above + agent.
			const id = threadId(roomId);
			const room = (id ? await open(id) : undefined) ?? await currentRoom();
			if (!room) {
				threads.openNew();
				return;
			}
			await threads.showMenu(room.id, 'invite');
		}),
		vscode.commands.registerCommand('arkestra.rooms.chooseModel', async (arg?: unknown, agentArg?: unknown) => {
			// The model popover on the thread's page: at the agent's chip, or whose model first.
			const id = typeof arg === 'string' ? arg : (arg as { thread?: { id: string } } | undefined)?.thread?.id;
			const room = (id ? await open(id) : undefined) ?? await currentRoom();
			if (!room) {
				threads.openNew();
				return;
			}
			const agentId = typeof agentArg === 'string' ? agentArg : undefined;
			await threads.showMenu(room.id, agentId ? 'model' : 'models', agentId);
		}),
		// The palette's way to a thread (the left bar lists them too).
		vscode.commands.registerCommand('arkestra.rooms.open', async () => {
			const rooms = await store.list();
			const pick = await vscode.window.showQuickPick(rooms.map(r => ({ label: r.title, description: `${r.roster.length} agent`, id: r.id })),
				{ title: vscode.l10n.t('Open a room') });
			if (pick) {
				await threads.open(pick.id);
			}
		}),
	);

	// Writing to a thread from another screen (AR36): the same round as the chat's, without a chat view.
	const remoteRounds = new Map<string, AbortController>();
	const remoteSay = async (roomId: string, text: string): Promise<void> => {
		const room = await open(roomId);
		if (!room) {
			throw new Error('no such thread');
		}
		if (!text.trim()) {
			return;
		}
		if (room.state.template) {
			const run = ensureRun(room)!;
			run.unpause();
			room.addUser(text);
			await run.engine.user(text, run.addressed(text));
			return;
		}
		if (!room.roster.length) {
			throw new Error('there is no agent in this thread yet');
		}
		if (remoteRounds.has(roomId) || room.roster.some(id => activity.get(roomId, id).state !== 'idle')) {
			throw new Error('a round is running in this thread; wait for it or stop it');
		}
		const abort = new AbortController();
		remoteRounds.set(roomId, abort);
		activity.queue(room.id, room.roster);
		await changesUi?.take(room.id, vscode.l10n.t('Before: {0}', titleFrom(text, vscode.l10n.t('Room'))));
		void (async () => {
			try {
				await room.say(text, roundSink(room), abort.signal);
			} finally {
				activity.settle(room.id);
				remoteRounds.delete(roomId);
			}
		})();
	};
	const remoteStop = async (roomId: string): Promise<void> => {
		remoteRounds.get(roomId)?.abort();
		runs.get(roomId)?.pause(vscode.l10n.t('Stopped from another screen.'));
	};
	const snapshot = async (roomId: string): Promise<ThreadSnapshot | undefined> => {
		const room = await open(roomId);
		if (!room) {
			return undefined;
		}
		const choices = new Map<string, AgentChoices | undefined>();
		await Promise.all(room.roster.map(async id => choices.set(id, await agentChoices(id))));
		return threadSnapshot(room.state, id => ({ name: registry.get(id)?.name ?? id, activity: activity.get(roomId, id), ...(choices.get(id) ? { choices: choices.get(id)! } : {}) }));
	};

	const permissions = new Permissions(machine => machine === 'local' ? vscode.l10n.t('this machine') : machine);
	context.subscriptions.push(permissions);
	return {
		registerAgent: agent => new vscode.Disposable(registry.register(agent).dispose),
		permissions,
		tasks,
		onDidChangeTasks: tasksChanged.event,
		agentChoices,
		threads: async () => (await store.list()).map(s => loaded.get(s.id)?.state ?? s).sort((a, b) => (b.messages.at(-1)?.at ?? '').localeCompare(a.messages.at(-1)?.at ?? '')).map(s => threadListItem(s, id => activity.get(s.id, id))),
		thread: snapshot,
		say: remoteSay,
		stop: remoteStop,
		onDidChangeThread: threadChanged.event,
		setChoice: async (roomId, agentId, choice) => {
			const room = await open(roomId);
			if (room) {
				await setChoice(room, agentId, choice);
			}
		},
	};
}

export function deactivate(): void { }

interface AgentRow {
	readonly id: string;
	readonly choice: string;
	readonly canChoose: boolean;
	readonly name: string;
	readonly detail: string;
	readonly activity: AgentActivity;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

function agentsHtml(rows: readonly AgentRow[] | undefined): string {
	const nonce = randomBytes(16).toString('base64');
	const time = (iso: string) => iso ? new Date(iso).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' }) : '';
	const state = (a: AgentActivity) => {
		const turn = turnState(a.state, a.work, a.error, !!a.ran);
		const cls = turn === 'working' ? 'busy' : turn === 'waiting' || turn === 'queued' ? 'wait' : turn === 'error' ? 'err' : 'idle';
		const tool = a.tool ? (turn === 'working' ? ` · ${a.tool}` : turn === 'done' || turn === 'idle' ? ` · last: ${a.tool}` : '') : '';
		return { cls, text: vscode.l10n.t(TURN_TEXT[turn]) + tool };
	};
	const body = !rows
		? `<p class="mut">${escapeHtml(vscode.l10n.t('No room yet. Start one in the chat with @room.'))}</p>`
		: !rows.length
			? `<p class="mut">${escapeHtml(vscode.l10n.t('Nobody in this room yet.'))}</p>`
			: rows.map(r => {
				const s = state(r.activity);
				const u = r.activity.usage;
				const ctx = contextPercent(u);
				const limit = tightestLimit(u);
				const rings = [
					ctx !== undefined ? ringSvg(ctx, vscode.l10n.t('Context {0}% full ({1} of {2} tokens)', ctx, formatTokens(u!.context!.used), formatTokens(u!.context!.window!))) : '',
					limit ? ringSvg(limit.usedPercent, vscode.l10n.t('Quota {0}: {1}% used{2}', limit.label, limit.usedPercent, limit.resetsAt ? vscode.l10n.t(', resets {0}', new Date(limit.resetsAt).toLocaleString(vscode.env.language)) : '')) : '',
				].join('');
				const line = usageLine(u);
				return `<div class="agent">
					<div class="top"><span class="dot ${s.cls}"></span><b>${escapeHtml(r.name)}</b><span class="rings">${rings}</span><span class="mut when">${escapeHtml(time(r.activity.since))}</span></div>
					<div class="mut">${escapeHtml(r.detail)}${line ? ` · ${escapeHtml(line)}` : ''}</div>
					${r.canChoose ? `<div class="choice"><span>${escapeHtml(r.choice || vscode.l10n.t('default model'))}</span> <a href="#" data-choose="${escapeHtml(r.id)}">${escapeHtml(vscode.l10n.t('Model & effort…'))}</a></div>` : ''}
					<div class="${s.cls}">${escapeHtml(s.text)}</div>
					${r.activity.error ? `<div class="err">${escapeHtml(r.activity.error)}</div>` : ''}
					${workHtml(r.activity.work, escapeHtml)}
				</div>`;
			}).join('');
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 10px 12px; }
	.agent { padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); display: grid; gap: 3px; }
	.top { display: flex; align-items: center; gap: 8px; }
	.when { font-size: .9em; }
	.rings { margin-left: auto; display: inline-flex; gap: 4px; }
	.ring .track { stroke: var(--vscode-panel-border); }
	.ring.ok .fill { stroke: var(--vscode-charts-green, var(--vscode-progressBar-background)); }
	.ring.warn .fill { stroke: var(--vscode-editorWarning-foreground); }
	.ring.crit .fill { stroke: var(--vscode-errorForeground); }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
	.dot.busy { background: var(--vscode-progressBar-background); }
	.dot.wait { background: var(--vscode-editorWarning-foreground); }
	.mut { color: var(--vscode-descriptionForeground); }
	.busy { color: var(--vscode-foreground); }
	.wait { color: var(--vscode-editorWarning-foreground); }
	.err { color: var(--vscode-errorForeground); }
	.dot.err { background: var(--vscode-errorForeground); }
	.choice { font-size: .92em; }
	.choice a { color: var(--vscode-textLink-foreground); text-decoration: none; margin-left: 6px; }
	details.work { margin-top: 2px; }
	details.work summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: .92em; }
	details.work ul, details.work ol { margin: 4px 0 2px; padding-left: 18px; }
	details.work ul { list-style: none; padding-left: 4px; }
	.todo.completed { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
	.todo.in_progress { font-weight: 600; }
	.item .st { display: inline-block; width: 1em; }
	.item.running .st { color: var(--vscode-progressBar-background); }
	.item.done .st { color: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); }
	.item.error .st { color: var(--vscode-errorForeground); }
	button { margin-top: 12px; font: inherit; padding: 4px 12px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-hoverBackground); }
</style></head><body>
	${body}
	<button id="invite">+ ${escapeHtml(vscode.l10n.t('Invite an agent'))}</button>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('invite').addEventListener('click', () => vscode.postMessage({ type: 'invite' }));
		for (const a of document.querySelectorAll('[data-choose]')) {
			a.addEventListener('click', e => { e.preventDefault(); vscode.postMessage({ type: 'choose', agentId: a.getAttribute('data-choose') }); });
		}
	</script>
</body></html>`;
}

interface LaneView {
	readonly name: string;
	readonly detail: string;
	readonly activity: AgentActivity;
	readonly entries: readonly LaneEntry[];
}

function laneHtml(slot: number, lane: LaneView | undefined, hasRoom: boolean): string {
	const nonce = randomBytes(16).toString('base64');
	const time = (iso: string) => iso ? new Date(iso).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' }) : '';
	let body: string;
	if (!lane) {
		body = `<div class="free"><p class="mut">${escapeHtml(hasRoom ? vscode.l10n.t('No agent in this lane yet.') : vscode.l10n.t('No room yet. Start one in the chat with @room.'))}</p>
			${hasRoom ? `<button id="invite">+ ${escapeHtml(vscode.l10n.t('Invite an agent'))}</button>` : ''}</div>`;
	} else {
		const a = lane.activity;
		const cls = a.state === 'answering' ? 'busy' : a.state === 'queued' ? 'wait' : 'idle';
		const state = a.state === 'answering' ? vscode.l10n.t('working') : a.state === 'queued' ? vscode.l10n.t('waiting for its turn') : vscode.l10n.t('idle');
		const entries = lane.entries.map(e => `<div class="entry"><div class="mut when">${escapeHtml(time(e.at))}</div><div class="text">${escapeHtml(e.text)}</div></div>`).join('');
		body = `<header><div class="top"><span class="dot ${cls}"></span><b>${escapeHtml(lane.name)}</b><span class="${cls} state">${escapeHtml(state)}</span></div>
			<div class="mut">${escapeHtml(lane.detail)}</div></header>
			<main>${entries || `<p class="mut">${escapeHtml(vscode.l10n.t('Nothing written in this thread yet.'))}</p>`}
			${a.state === 'answering' && a.tool ? `<div class="entry live"><div class="mut when">${escapeHtml(time(a.since))}</div><div class="text">${escapeHtml(a.tool)}</div></div>` : ''}
			${a.error ? `<div class="entry err">${escapeHtml(a.error)}</div>` : ''}</main>`;
	}
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0; margin: 0; }
	header { position: sticky; top: 0; padding: 10px 12px 8px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); display: grid; gap: 2px; }
	.top { display: flex; align-items: center; gap: 8px; }
	.state { margin-left: auto; font-size: .9em; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
	.dot.busy { background: var(--vscode-progressBar-background); }
	.dot.wait { background: var(--vscode-editorWarning-foreground); }
	main, .free { padding: 6px 12px 16px; }
	.entry { padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); display: grid; gap: 3px; }
	.entry.live .text { color: var(--vscode-progressBar-background); }
	.text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
	.when { font-size: .85em; }
	.mut { color: var(--vscode-descriptionForeground); }
	.wait { color: var(--vscode-editorWarning-foreground); }
	.err { color: var(--vscode-errorForeground); }
	button { font: inherit; padding: 4px 12px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-hoverBackground); }
</style></head><body>
	${body}
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		vscode.setState({ slot: ${slot} });
		document.getElementById('invite')?.addEventListener('click', () => vscode.postMessage({ type: 'invite' }));
		scrollTo(0, document.body.scrollHeight);
	</script>
</body></html>`;
}

/*---------------------------------------------------------------------------------------------
 *  Arkestra. Rooms in the chat: the room is a chat participant that routes each
 *  message to every agent in it, and agents can be invited at any time.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ActivityBoard, type AgentActivity } from './activity';
import { AgentRegistry, type Agent, type InviteEntry } from './agent';
import { AgentNotReadyError, Room, newRoomState } from './room';
import { RoomStore } from './store';
import { laneAgent, laneEntries, type LaneEntry } from './lanes';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { templateForm } from './templateForm';
import { ChangesUi } from './changesView';
import { InlineEdits } from './inlineEditUi';
import { References } from './referencesUi';
import { Permissions, type PermissionsApi } from './permissionsUi';
import { SharedContext } from './sharedUi';
import { extractMemories } from './shared';
import { GitTemplateIO, createWorkTrees } from './templates/gitio';
import { TemplateRun } from './templates/run';
import type { Role } from './templates/signals';
import type { CodeState, ReviewState, TemplateState } from './templates/types';
import { ROOM_ID_KEY, ROOM_SCHEME, groupThreads, historyTurns, projectName, roomIdFromHistory, roomIdFromSessionPath, summarize, titleFrom, type ProjectThreads, type ThreadSummary } from './threads';

/** What adapter extensions (Claude Code, Codex, OpenAI, ACP) receive. */
export interface ArkestraRoomsApi {
	registerAgent(agent: Agent): vscode.Disposable;
	/** Permission lists per machine and project; adapters ask here before an agent acts. */
	readonly permissions: PermissionsApi;
}

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
	const currentChanged = new vscode.EventEmitter<void>();

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
			refreshThreadsLater();
			if (room === current) {
				currentChanged.fire();
			}
		});
		return room;
	};

	const open = async (id: string | undefined): Promise<Room | undefined> => {
		if (!id) {
			return undefined;
		}
		const cached = loaded.get(id);
		if (cached) {
			return cached;
		}
		const state = await store.load(id);
		return state ? track(new Room(state, registry)) : undefined;
	};

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
	const createRoom = async (title: string): Promise<Room> => {
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
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

	const pickAndInvite = async (room: Room): Promise<string | undefined> => {
		const entries = await registry.inviteList(room.roster);
		if (!entries.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No other agent is known yet.'));
			return undefined;
		}
		const pick = await vscode.window.showQuickPick(entries.map(entry => ({
			label: entry.readiness.ready ? entry.agent.name : `$(warning) ${entry.agent.name}`,
			description: entry.agent.detail,
			detail: describe(entry),
			entry,
		})), { title: vscode.l10n.t('Invite an agent into “{0}”', room.state.title), placeHolder: vscode.l10n.t('It receives the thread from the beginning') });
		if (!pick) {
			return undefined;
		}
		if (!pick.entry.readiness.ready) {
			await explain(pick.entry);
			return undefined;
		}
		return invite(room, pick.entry.agent.id);
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
				switch (event.kind) {
					case 'start': activity.start(room.id, agentId); break;
					case 'tool': activity.tool(room.id, agentId, event.text); break;
					case 'error': activity.error(room.id, agentId, event.text); break;
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

	/** The user's word in a template room goes to the template, not to a plain round. */
	/** `prompt`: the message with its @-referenced material; addressing reads the user's own text. */
	const templateTurn = async (room: Room, request: vscode.ChatRequest, prompt: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
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
		// The message with its @-referenced material, resolved only when it goes to agents.
		const expand = async () => {
			const expanded = await references.expand(request.prompt, request.references, room.id);
			if (expanded.notes.length) {
				stream.markdown(`_${vscode.l10n.t('Attached: {0}', expanded.notes.join(' · '))}_\n\n`);
			}
			return expanded.text;
		};

		if (request.command === 'new') {
			stream.markdown(vscode.l10n.t('New room: **{0}**. Invite agents with /invite.', room.state.title));
			inviteButton(stream, room);
			return result;
		}

		if (request.command === 'agents' || request.command === 'invite') {
			const entries = await registry.inviteList(room.roster);
			if (request.command === 'invite' && request.prompt.trim()) {
				const target = findAgent(request.prompt, entries);
				stream.markdown(target ? await invite(room, target.agent.id) : vscode.l10n.t('No agent named "{0}".', request.prompt.trim()));
				return result;
			}
			if (request.command === 'invite') {
				const message = await pickAndInvite(room);
				if (message) {
					stream.markdown(message);
				}
				return result;
			}
			const inRoom = room.roster.map(id => registry.get(id)?.name ?? id).join(', ') || vscode.l10n.t('nobody yet');
			stream.markdown(vscode.l10n.t('In this room: {0}', inRoom) + '\n\n');
			for (const entry of entries) {
				stream.markdown(`- **${entry.agent.name}** · ${entry.agent.detail} · ${describe(entry)}\n`);
			}
			inviteButton(stream, room);
			return result;
		}

		if (request.command === 'template') {
			await vscode.commands.executeCommand('arkestra.rooms.newTemplateRoom');
			return result;
		}

		if (room.state.template) {
			if (request.command === 'plan' || request.command === 'execute') {
				stream.markdown(vscode.l10n.t('A template room has its own plan step: the slice plan waits for /approve when the room was set up so.'));
				return result;
			}
			await templateTurn(room, request, await expand(), stream, token);
			return result;
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
				return result;
			}
		} else if (request.command === 'execute') {
			if (room.state.mode !== 'plan') {
				stream.markdown(vscode.l10n.t('This room is not in Plan mode. Start one with /plan.'));
				return result;
			}
			room.state.mode = undefined;
			room.post(PLAN_OFF);
			await store.save(room.state);
			fallback = PLAN_EXECUTE;
		}

		if (!room.roster.length) {
			stream.markdown(vscode.l10n.t('There is no agent in this room yet. Invite one with /invite.'));
			inviteButton(stream, room);
			return result;
		}

		// Clickable while the round runs: whoever joins answers in this round too.
		inviteButton(stream, room);
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		activity.queue(room.id, room.roster);
		const prompt = !request.prompt.trim() && fallback ? fallback : await expand();
		await changesUi?.take(room.id, vscode.l10n.t('Before: {0}', titleFrom(request.prompt, vscode.l10n.t('Room'))));
		try {
			await room.say(prompt, (agent, event) => {
				switch (event.kind) {
					case 'start': activity.start(room.id, agent.id); stream.markdown(`\n\n**${agent.name}**\n\n`); break;
					case 'text': stream.markdown(event.text); break;
					case 'tool': activity.tool(room.id, agent.id, event.text); stream.progress(`${agent.name}: ${event.text}`); break;
					case 'error': activity.error(room.id, agent.id, event.text); stream.markdown(`\n\n> ${agent.name}: ${event.text}\n`); break;
					case 'end': activity.end(room.id, agent.id); break;
				}
			}, abort.signal);
		} finally {
			activity.settle(room.id);
			cancel.dispose();
		}
		if (room.state.mode === 'plan') {
			stream.markdown(`\n\n_${vscode.l10n.t('Plan mode: nothing was changed. Refine the plan, or run it with /execute.')}_`);
		}
		return result;
	};

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
			return { name: agent?.name ?? id, detail: agent?.detail ?? vscode.l10n.t('not available now'), activity: activity.get(room.id, id) };
		}) : undefined);
	};
	const adoptAgentsPanel = (panel: vscode.WebviewPanel) => {
		agentsPanel = panel;
		panel.iconPath = new vscode.ThemeIcon('organization');
		panel.webview.options = { enableScripts: true };
		panel.onDidDispose(() => { agentsPanel = undefined; });
		panel.webview.onDidReceiveMessage(async (message: { type?: string }) => {
			if (message.type === 'invite') {
				await vscode.commands.executeCommand('arkestra.rooms.invite', (await currentRoom())?.id);
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

	// ---- Threads as native chat sessions: history, session list, the left column ----------
	const sessionUri = (roomId: string) => vscode.Uri.from({ scheme: ROOM_SCHEME, path: `/room/${roomId}` });
	const sessionParticipant = vscode.chat.createChatParticipant(ROOM_SCHEME, handler);
	sessionParticipant.iconPath = new vscode.ThemeIcon('organization');
	sessionParticipant.participantVariableProvider = references.completionProvider();
	// ChatRequestTurn's constructor is internal in the typings; the runtime class takes these arguments.
	const RequestTurn = vscode.ChatRequestTurn as unknown as new (prompt: string, command: string | undefined, references: [], participant: string, toolReferences: []) => vscode.ChatRequestTurn;

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

	// The left column: threads of this project, then of the others.
	const changedThreads = new vscode.EventEmitter<void>();
	type Node = { kind: 'project'; label: string; group: ProjectThreads; current: boolean } | { kind: 'category'; name: string; threads: readonly ThreadSummary[] } | { kind: 'thread'; thread: ThreadSummary };
	const currentProject = () => vscode.workspace.workspaceFolders?.[0]?.uri.toString();
	const threadsOf = (group: ProjectThreads): Node[] => [
		...group.pinned.map(thread => ({ kind: 'thread' as const, thread })),
		...group.categories.map(c => ({ kind: 'category' as const, name: c.name, threads: c.threads })),
		...group.uncategorized.map(thread => ({ kind: 'thread' as const, thread })),
	];
	const treeProvider: vscode.TreeDataProvider<Node> = {
		onDidChangeTreeData: changedThreads.event,
		getChildren: async node => {
			if (!node) {
				const { current, others } = groupThreads(await allThreads(), currentProject());
				const here = projectName(current.project) || vscode.l10n.t('No project');
				return [
					{ kind: 'project', label: vscode.l10n.t('Threads · {0}', here), group: current, current: true },
					...others.map(group => ({ kind: 'project' as const, label: projectName(group.project) || vscode.l10n.t('No project'), group, current: false })),
				];
			}
			return node.kind === 'project' ? threadsOf(node.group)
				: node.kind === 'category' ? node.threads.map(thread => ({ kind: 'thread' as const, thread }))
					: [];
		},
		getTreeItem: node => {
			if (node.kind === 'project') {
				const item = new vscode.TreeItem(node.label, node.current ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
				item.description = node.current ? undefined : String(node.group.count);
				item.contextValue = 'project';
				return item;
			}
			if (node.kind === 'category') {
				const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
				item.iconPath = new vscode.ThemeIcon('tag');
				item.description = String(node.threads.length);
				return item;
			}
			const t = node.thread;
			const item = new vscode.TreeItem(t.title, vscode.TreeItemCollapsibleState.None);
			item.id = t.id;
			item.iconPath = new vscode.ThemeIcon(busy(t.id) ? 'loading~spin' : t.pinned ? 'pinned' : 'comment-discussion');
			item.description = t.lastAt ? new Date(t.lastAt).toLocaleString(vscode.env.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : undefined;
			item.tooltip = vscode.l10n.t('{0} agents', t.agents);
			item.contextValue = t.pinned ? 'thread.pinned' : 'thread';
			item.command = { command: 'arkestra.rooms.openThread', title: vscode.l10n.t('Open'), arguments: [t.id] };
			return item;
		},
	};
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const refreshThreads: () => void = () => {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			changedThreads.fire();
			void controller.refreshHandler(new vscode.CancellationTokenSource().token);
		}, 300);
	};
	refreshThreadsLater = refreshThreads;
	const threadId = (arg: unknown) => typeof arg === 'string' ? arg : (arg as { thread?: ThreadSummary } | undefined)?.thread?.id;
	const editRoom = async (arg: unknown, edit: (room: Room) => void) => {
		const room = await open(threadId(arg));
		if (room) {
			edit(room);
			await store.save(room.state);
			refreshThreads();
		}
	};

	context.subscriptions.push(
		sessionParticipant,
		controller,
		changedThreads,
		vscode.chat.registerChatSessionContentProvider(ROOM_SCHEME, contentProvider, sessionParticipant),
		vscode.window.createTreeView('arkestra.threads', { treeDataProvider: treeProvider, showCollapseAll: true }),
		activity.onDidChange(refreshThreads),
		currentChanged.event(refreshThreads),
		vscode.workspace.onDidChangeWorkspaceFolders(refreshThreads),
		vscode.commands.registerCommand('arkestra.rooms.openThread', async (arg: unknown, column?: unknown) => {
			const id = threadId(arg) ?? (await currentRoom())?.id;
			if (id) {
				await vscode.commands.executeCommand('vscode.open', sessionUri(id), typeof column === 'number' ? { viewColumn: column } : undefined);
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.newTemplateRoom', async () => {
			const req = await templateForm(registry, (await currentRoom())?.roster);
			if (!req) {
				return;
			}
			try {
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
				await vscode.commands.executeCommand('vscode.open', sessionUri(room.id));
			} catch (error) {
				void vscode.window.showErrorMessage(vscode.l10n.t('The template room could not start: {0}', error instanceof Error ? error.message : String(error)));
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.newThread', async () => {
			const room = await createRoom(vscode.l10n.t('Room'));
			refreshThreads();
			await vscode.commands.executeCommand('vscode.open', sessionUri(room.id));
		}),
		vscode.commands.registerCommand('arkestra.rooms.pin', arg => editRoom(arg, room => { room.state.pinned = true; })),
		vscode.commands.registerCommand('arkestra.rooms.unpin', arg => editRoom(arg, room => { delete room.state.pinned; })),
		vscode.commands.registerCommand('arkestra.rooms.rename', async (arg: unknown) => {
			const room = await open(threadId(arg));
			const title = room && (await vscode.window.showInputBox({ title: vscode.l10n.t('Rename thread'), value: room.state.title }))?.trim();
			if (room && title) {
				await editRoom(room.id, r => { r.state.title = title; });
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.setCategory', async (arg: unknown) => {
			const room = await open(threadId(arg));
			if (!room) {
				return;
			}
			const existing = [...new Set((await allThreads()).map(t => t.category).filter((c): c is string => !!c))].sort();
			const none = vscode.l10n.t('No category');
			const other = vscode.l10n.t('New category…');
			const pick = await vscode.window.showQuickPick([...existing, other, none], { title: vscode.l10n.t('Category of “{0}”', room.state.title) });
			const category = pick === other ? (await vscode.window.showInputBox({ title: vscode.l10n.t('New category') }))?.trim() : pick;
			if (pick === none) {
				await editRoom(room.id, r => { delete r.state.category; });
			} else if (category) {
				await editRoom(room.id, r => { r.state.category = category; });
			}
		}),
	);

	context.subscriptions.push(
		participant,
		vscode.commands.registerCommand('arkestra.rooms.new', async () => {
			const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name of the new room') });
			if (title !== undefined) {
				await createRoom(title || vscode.l10n.t('Room'));
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.invite', async (roomId?: unknown) => {
			// From a thread's button: that thread's room. From the palette: the room used last.
			const room = (typeof roomId === 'string' ? await open(roomId) : undefined) ?? await currentRoom();
			if (!room) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Start a room in the chat with @room first.'));
				return;
			}
			const message = await pickAndInvite(room);
			if (message) {
				void vscode.window.showInformationMessage(message);
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.open', async () => {
			const rooms = await store.list();
			const pick = await vscode.window.showQuickPick(rooms.map(r => ({ label: r.title, description: `${r.roster.length} agent`, id: r.id })),
				{ title: vscode.l10n.t('Open a room') });
			const room = pick && await open(pick.id);
			if (room) {
				await use(room);
			}
		}),
	);

	const permissions = new Permissions(machine => machine === 'local' ? vscode.l10n.t('this machine') : machine);
	context.subscriptions.push(permissions);
	return {
		registerAgent: agent => new vscode.Disposable(registry.register(agent).dispose),
		permissions,
	};
}

export function deactivate(): void { }

interface AgentRow {
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
	const state = (a: AgentActivity) => a.state === 'answering'
		? { cls: 'busy', text: a.tool ? vscode.l10n.t('working · {0}', a.tool) : vscode.l10n.t('working') }
		: a.state === 'queued'
			? { cls: 'wait', text: vscode.l10n.t('waiting for its turn') }
			: { cls: 'idle', text: a.tool ? vscode.l10n.t('idle · last: {0}', a.tool) : vscode.l10n.t('idle') };
	const body = !rows
		? `<p class="mut">${escapeHtml(vscode.l10n.t('No room yet. Start one in the chat with @room.'))}</p>`
		: !rows.length
			? `<p class="mut">${escapeHtml(vscode.l10n.t('Nobody in this room yet.'))}</p>`
			: rows.map(r => {
				const s = state(r.activity);
				return `<div class="agent">
					<div class="top"><span class="dot ${s.cls}"></span><b>${escapeHtml(r.name)}</b><span class="mut when">${escapeHtml(time(r.activity.since))}</span></div>
					<div class="mut">${escapeHtml(r.detail)}</div>
					<div class="${s.cls}">${escapeHtml(s.text)}</div>
					${r.activity.error ? `<div class="err">${escapeHtml(r.activity.error)}</div>` : ''}
				</div>`;
			}).join('');
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 10px 12px; }
	.agent { padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); display: grid; gap: 3px; }
	.top { display: flex; align-items: center; gap: 8px; }
	.when { margin-left: auto; font-size: .9em; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
	.dot.busy { background: var(--vscode-progressBar-background); }
	.dot.wait { background: var(--vscode-editorWarning-foreground); }
	.mut { color: var(--vscode-descriptionForeground); }
	.busy { color: var(--vscode-foreground); }
	.wait { color: var(--vscode-editorWarning-foreground); }
	.err { color: var(--vscode-errorForeground); }
	button { margin-top: 12px; font: inherit; padding: 4px 12px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-hoverBackground); }
</style></head><body>
	${body}
	<button id="invite">+ ${escapeHtml(vscode.l10n.t('Invite an agent'))}</button>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('invite').addEventListener('click', () => vscode.postMessage({ type: 'invite' }));
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

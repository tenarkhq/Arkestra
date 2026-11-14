/*---------------------------------------------------------------------------------------------
 *  Arkestra. Rooms in the chat: the room is a chat participant that routes each
 *  message to every agent in it, and agents can be invited at any time.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import { AgentRegistry, type Agent, type InviteEntry } from './agent';
import { AgentNotReadyError, Room, newRoomState } from './room';
import { RoomStore } from './store';
import { ROOM_ID_KEY, roomIdFromHistory, titleFrom } from './threads';

/** What adapter extensions (Claude Code, Codex, OpenAI, ACP) receive. */
export interface ArkestraRoomsApi {
	registerAgent(agent: Agent): vscode.Disposable;
}

const ACTIVE_ROOM = 'arkestra.rooms.active';

export function activate(context: vscode.ExtensionContext): ArkestraRoomsApi {
	const registry = new AgentRegistry();
	const store = new RoomStore(path.join(context.globalStorageUri.fsPath, 'rooms'));
	// One Room object per room: a running round and a mid-run invite must share it.
	const loaded = new Map<string, Room>();
	/** The room of the thread used last; the palette commands act on it. */
	let current: Room | undefined;

	const track = (room: Room): Room => {
		loaded.set(room.id, room);
		room.onDidChange(() => { void store.save(room.state); });
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
		current = room;
		await context.globalState.update(ACTIVE_ROOM, room.id);
		return room;
	};

	const createRoom = async (title: string): Promise<Room> => {
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		const room = track(new Room(newRoomState(title, workspace), registry));
		await store.save(room.state);
		return use(room);
	};

	const currentRoom = async (): Promise<Room | undefined> =>
		current ?? (current = await open(context.globalState.get<string>(ACTIVE_ROOM)));

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

	const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token): Promise<vscode.ChatResult> => {
		// This thread's room; a thread without one (a new chat) gets a new room.
		const room = request.command === 'new'
			? await createRoom(titleFrom(request.prompt, vscode.l10n.t('Room')))
			: await use(await open(roomIdFromHistory(chatContext.history)) ?? await createRoom(titleFrom(request.prompt, vscode.l10n.t('Room'))));
		const result: vscode.ChatResult = { metadata: { [ROOM_ID_KEY]: room.id } };

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

		if (!room.roster.length) {
			stream.markdown(vscode.l10n.t('There is no agent in this room yet. Invite one with /invite.'));
			inviteButton(stream, room);
			return result;
		}

		// Clickable while the round runs: whoever joins answers in this round too.
		inviteButton(stream, room);
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		try {
			await room.say(request.prompt, (agent, event) => {
				switch (event.kind) {
					case 'start': stream.markdown(`\n\n**${agent.name}**\n\n`); break;
					case 'text': stream.markdown(event.text); break;
					case 'tool': stream.progress(`${agent.name}: ${event.text}`); break;
					case 'error': stream.markdown(`\n\n> ${agent.name}: ${event.text}\n`); break;
				}
			}, abort.signal);
		} finally {
			cancel.dispose();
		}
		return result;
	};

	const participant = vscode.chat.createChatParticipant('arkestra.room', handler);
	participant.iconPath = new vscode.ThemeIcon('organization');

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

	return {
		registerAgent: agent => new vscode.Disposable(registry.register(agent).dispose),
	};
}

export function deactivate(): void { }

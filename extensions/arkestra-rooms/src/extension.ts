/*---------------------------------------------------------------------------------------------
 *  Arkestra. Rooms in the chat: the room is a chat participant that routes each
 *  message to every agent in it, and agents can be invited at any time.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import { AgentRegistry, type Agent, type InviteEntry } from './agent';
import { AgentNotReadyError, Room, newRoomState } from './room';
import { RoomStore } from './store';

/** What adapter extensions (Claude Code, Codex, OpenAI, ACP) receive. */
export interface ArkestraRoomsApi {
	registerAgent(agent: Agent): vscode.Disposable;
}

const ACTIVE_ROOM = 'arkestra.rooms.active';

export function activate(context: vscode.ExtensionContext): ArkestraRoomsApi {
	const registry = new AgentRegistry();
	const store = new RoomStore(path.join(context.globalStorageUri.fsPath, 'rooms'));
	let active: Room | undefined;

	const open = async (id: string | undefined): Promise<Room | undefined> => {
		const state = id ? await store.load(id) : undefined;
		if (!state) {
			return undefined;
		}
		const room = new Room(state, registry);
		room.onDidChange(() => { void store.save(room.state); });
		return room;
	};

	const activeRoom = async (): Promise<Room> => {
		active ??= await open(context.globalState.get<string>(ACTIVE_ROOM));
		if (!active) {
			active = await createRoom(vscode.l10n.t('Room'));
		}
		return active;
	};

	const createRoom = async (title: string): Promise<Room> => {
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		const room = new Room(newRoomState(title, workspace), registry);
		room.onDidChange(() => { void store.save(room.state); });
		await store.save(room.state);
		await context.globalState.update(ACTIVE_ROOM, room.id);
		active = room;
		return room;
	};

	const describe = (entry: InviteEntry): string => entry.readiness.ready
		? vscode.l10n.t('ready')
		: entry.readiness.reason ?? vscode.l10n.t('not ready');

	const pickAndInvite = async (room: Room): Promise<string | undefined> => {
		const entries = await registry.inviteList(room.roster);
		if (!entries.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No other agent is known yet.'));
			return undefined;
		}
		const pick = await vscode.window.showQuickPick(entries.map(entry => ({
			label: entry.agent.name,
			description: entry.agent.detail,
			detail: describe(entry),
			entry,
		})), { title: vscode.l10n.t('Invite an agent into this thread'), placeHolder: vscode.l10n.t('It receives the thread from the beginning') });
		if (!pick) {
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
				return vscode.l10n.t('{0} cannot join now: {1}', registry.get(agentId)?.name ?? agentId, error.readiness.reason ?? '');
			}
			throw error;
		}
	};

	const findAgent = (query: string, entries: InviteEntry[]): InviteEntry | undefined => {
		const q = query.trim().toLowerCase();
		return entries.find(e => e.agent.id.toLowerCase() === q || e.agent.name.toLowerCase() === q)
			?? entries.find(e => e.agent.name.toLowerCase().startsWith(q));
	};

	const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
		const room = await activeRoom();

		if (request.command === 'new') {
			const created = await createRoom(request.prompt.trim() || vscode.l10n.t('Room'));
			stream.markdown(vscode.l10n.t('New room: **{0}**. Invite agents with /invite.', created.state.title));
			return;
		}

		if (request.command === 'agents' || request.command === 'invite') {
			const entries = await registry.inviteList(room.roster);
			if (request.command === 'invite' && request.prompt.trim()) {
				const target = findAgent(request.prompt, entries);
				stream.markdown(target ? await invite(room, target.agent.id) : vscode.l10n.t('No agent named "{0}".', request.prompt.trim()));
				return;
			}
			if (request.command === 'invite') {
				const result = await pickAndInvite(room);
				if (result) {
					stream.markdown(result);
				}
				return;
			}
			const inRoom = room.roster.map(id => registry.get(id)?.name ?? id).join(', ') || vscode.l10n.t('nobody yet');
			stream.markdown(vscode.l10n.t('In this room: {0}', inRoom) + '\n\n');
			for (const entry of entries) {
				stream.markdown(`- **${entry.agent.name}** · ${entry.agent.detail} · ${describe(entry)}\n`);
			}
			return;
		}

		if (!room.roster.length) {
			stream.markdown(vscode.l10n.t('There is no agent in this room yet. Invite one with /invite.'));
			return;
		}

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
		vscode.commands.registerCommand('arkestra.rooms.invite', async () => {
			const result = await pickAndInvite(await activeRoom());
			if (result) {
				void vscode.window.showInformationMessage(result);
			}
		}),
		vscode.commands.registerCommand('arkestra.rooms.open', async () => {
			const rooms = await store.list();
			const pick = await vscode.window.showQuickPick(rooms.map(r => ({ label: r.title, description: `${r.roster.length} agent`, id: r.id })),
				{ title: vscode.l10n.t('Open a room') });
			if (pick) {
				active = await open(pick.id);
				await context.globalState.update(ACTIVE_ROOM, pick.id);
			}
		}),
	);

	return {
		registerAgent: agent => new vscode.Disposable(registry.register(agent).dispose),
	};
}

export function deactivate(): void { }

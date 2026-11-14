/*---------------------------------------------------------------------------------------------
 *  Arkestra. Every chat thread is its own room: the room id travels in the chat result's
 *  metadata, so the next request in the same thread finds it again in the history.
 *--------------------------------------------------------------------------------------------*/

export const ROOM_ID_KEY = 'arkestraRoomId';

/** The room id of the thread from its history (the newest answer that carries one), if any. */
export function roomIdFromHistory(history: readonly unknown[]): string | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const id = (history[i] as { result?: { metadata?: Record<string, unknown> } })?.result?.metadata?.[ROOM_ID_KEY];
		if (typeof id === 'string' && /^[A-Za-z0-9-]+$/.test(id)) {
			return id;
		}
	}
	return undefined;
}

/** A room title from the thread's first message. */
export function titleFrom(prompt: string, fallback: string): string {
	const line = prompt.trim().split('\n')[0].trim();
	if (!line) {
		return fallback;
	}
	return line.length > 48 ? line.slice(0, 47).trimEnd() + '…' : line;
}

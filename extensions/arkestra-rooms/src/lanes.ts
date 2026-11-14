/*---------------------------------------------------------------------------------------------
 *  Arkestra. Pult lanes: one column per agent of the room, showing what that agent wrote.
 *--------------------------------------------------------------------------------------------*/

import type { Message } from './room';

export interface LaneEntry {
	readonly at: string;
	readonly text: string;
}

/** The longest entry a lane shows; the whole answer stays in the thread. */
export const LANE_ENTRY_LIMIT = 600;

/** What the agent in this lane wrote, oldest first, at most `limit` entries (the newest ones). */
export function laneEntries(messages: readonly Message[], agentId: string, limit = 50): LaneEntry[] {
	const own = messages.filter(m => m.author.kind === 'agent' && m.author.id === agentId);
	return own.slice(-limit).map(m => ({
		at: m.at,
		text: m.text.length > LANE_ENTRY_LIMIT ? `${m.text.slice(0, LANE_ENTRY_LIMIT).trimEnd()}…` : m.text,
	}));
}

/** The agent of a lane slot: the slot-th agent of the room, or none (the lane offers an invite). */
export function laneAgent(roster: readonly string[], slot: number): string | undefined {
	return Number.isInteger(slot) && slot >= 0 ? roster[slot] : undefined;
}

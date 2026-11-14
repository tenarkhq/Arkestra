/*---------------------------------------------------------------------------------------------
 *  Arkestra. Rooms are kept as one JSON file each, written atomically.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RoomState } from './room';

export class RoomStore {
	constructor(private readonly dir: string) { }

	private file(id: string): string {
		if (!/^[A-Za-z0-9-]+$/.test(id)) {
			throw new Error(`bad room id: ${id}`);
		}
		return path.join(this.dir, `${id}.json`);
	}

	async save(state: RoomState): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true });
		const target = this.file(state.id);
		const temp = `${target}.${process.pid}.tmp`;
		await fs.writeFile(temp, JSON.stringify(state, null, '\t'), 'utf8');
		await fs.rename(temp, target);
	}

	async load(id: string): Promise<RoomState | undefined> {
		try {
			return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as RoomState;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw error;
		}
	}

	/** Deletes a room for good. */
	async remove(id: string): Promise<void> {
		await fs.rm(this.file(id), { force: true });
	}

	/** Every stored room, newest activity first. */
	async list(): Promise<RoomState[]> {
		let names: string[];
		try {
			names = await fs.readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw error;
		}
		const rooms = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => this.load(n.slice(0, -5))));
		const last = (r: RoomState) => r.messages.at(-1)?.at ?? '';
		return rooms.filter((r): r is RoomState => !!r).sort((a, b) => last(b).localeCompare(last(a)));
	}
}

/*---------------------------------------------------------------------------------------------
 *  Arkestra. The parts of the connections contract this adapter uses
 *  (arkestra-connections/src/extension.ts).
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface ConnectionMachine {
	readonly id: string;
	readonly name: string;
}

export interface ArkestraConnectionsApi {
	machines(): ConnectionMachine[];
	readonly onDidChangeMachines: (listener: () => void) => { dispose(): void };
	spawnFor(machineId: string): ((command: string, args: string[], options: SpawnOptions) => ChildProcess) | undefined;
}

/*---------------------------------------------------------------------------------------------
 *  Arkestra. The state of a 2ARK template room: kept in the room, so it survives a restart.
 *--------------------------------------------------------------------------------------------*/

import type { Role } from './signals';

export type TemplateType = 'review' | 'coding' | 'audit';

export interface Member {
	/** Agent id in the registry. */
	readonly id: string;
	readonly name: string;
}

export interface ReviewState {
	reviewer: Role;
	/** The user's task. */
	prompt: string;
	/** Where the material came from, when it was given. */
	source?: string;
	/** The latest version written (v1.md…); 0 while nothing is written. */
	version: number;
	/** What may stay open at PASS. */
	strict: 'all' | 'major' | 'critical';
}

export interface CodeState {
	/** The repository folder (the workspace). */
	repo: string;
	base: string;
	coordinator: Role;
	/** The brief: text, and/or a link, #N or task number the agents read themselves. */
	prompt: string;
	issue?: string;
	branches: Record<Role, string>;
	dirs: Record<Role, string>;
	plan: 'approve' | 'none';
	planState?: 'waiting' | 'approved';
	test?: string;
	verify: boolean;
	/** The head under verification, and the work trees' state when it started. */
	verifying?: string;
	verification?: Record<Role, { head: string; dirty: boolean }>;
}

export interface AuditState {
	auditors: 'both' | Role;
	lead: Role;
	since?: string;
	focus?: string;
	goal: 'doc' | 'fix';
	fix?: 'approve' | 'auto';
	levels?: 'P0' | 'P1' | 'P2' | 'P3';
	phase: 'audit' | 'merge' | 'approval' | 'fix' | 'verify' | 'fixed' | 'closed';
	done: Partial<Record<Role, boolean>>;
	head?: string;
}

export interface TemplateState {
	readonly type: TemplateType;
	readonly members: Record<Role, Member>;
	/** The room's own folder: document versions, progress lists, audit documents. */
	readonly folder: string;
	/** Relays since the user last wrote, and the limit. */
	rounds: number;
	max: number;
	/** Why the room stopped, when it did. */
	ended?: string;
	/** The relay held back when the limit was reached; Continue sends it. */
	pending?: { to: Role; text: string };
	/** Agents that already got their briefing. */
	briefed: Partial<Record<Role, boolean>>;
	/** Agents waiting for the user's decision. */
	waiting: Partial<Record<Role, string>>;
	review?: ReviewState;
	code?: CodeState;
	audit?: AuditState;
}

export const DEFAULT_MAX = { review: 25, coding: 60, audit: 60 } as const;

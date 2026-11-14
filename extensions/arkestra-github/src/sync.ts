/*---------------------------------------------------------------------------------------------
 *  Arkestra. Live two-way sync with a GitHub Project (AR29). GitHub → here: every relay event
 *  names the project items it touches, and those items are read again within a moment (many
 *  events in a row become one query). Here → GitHub: a change shows at once (optimistic) and
 *  is written straight away; if GitHub refuses it, the old value comes back. Polling runs only
 *  while the relay connection is down; after it comes back, one full read catches up.
 *  No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import { describe, type RelayEvent, type RelayState } from './relayClient';
import { MUTATIONS, itemsQuery, parseFields, parseItem, projectQuery, resolveInput, valueText, type FieldInput, type FieldValue, type IssueRef, type ProjectField, type ProjectItem, type ProjectSnapshot } from './project';

export type GraphQL = (query: string, variables?: Record<string, unknown>) => Promise<any>;

export interface JournalEntry {
	readonly at: number;
	/** `in`: GitHub → here; `out`: here → GitHub. */
	readonly direction: 'in' | 'out';
	readonly item?: string;
	readonly text: string;
	readonly error?: boolean;
}

export type SyncStatus =
	| { readonly kind: 'idle' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'synced'; readonly at: number; readonly live: boolean }
	| { readonly kind: 'error'; readonly message: string; readonly at: number };

export interface SyncOptions {
	readonly graphql: GraphQL;
	readonly owner: string;
	readonly number: number;
	readonly initial?: ProjectSnapshot;
	readonly debounceMs?: number;
	readonly pollMs?: number;
	readonly journalSize?: number;
	readonly now?: () => number;
	readonly onChange?: (snapshot: ProjectSnapshot) => void;
	readonly onJournal?: (entry: JournalEntry) => void;
	readonly onStatus?: (status: SyncStatus) => void;
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The project items an event touches: to read again, to drop, or the whole project. */
export function eventTargets(e: RelayEvent, snap: ProjectSnapshot): { items: string[]; remove: string[]; full: boolean } {
	const p = e.payload ?? {};
	if (e.event === 'projects_v2_item') {
		const it = p.projects_v2_item;
		if (!it?.node_id || (it.project_node_id && it.project_node_id !== snap.id)) {
			return { items: [], remove: [], full: false };
		}
		return e.action === 'deleted' || e.action === 'archived' ? { items: [], remove: [it.node_id], full: false } : { items: [it.node_id], remove: [], full: false };
	}
	if (e.event === 'projects_v2') {
		return { items: [], remove: [], full: p.projects_v2?.node_id === snap.id };
	}
	const contents = new Set<string>();
	for (const key of ['issue', 'pull_request', 'blocked_issue', 'blocking_issue']) {
		if (typeof p[key]?.node_id === 'string') {
			contents.add(p[key].node_id);
		}
	}
	const repo = e.repository;
	const prs: { number: number; repo?: string }[] = [];
	const shas = new Set<string>();
	const branches = new Set<string>();
	if (p.pull_request?.number) {
		prs.push({ number: p.pull_request.number, repo });
	}
	for (const run of [p.check_run, p.check_suite, p.workflow_run]) {
		for (const pr of run?.pull_requests ?? []) {
			prs.push({ number: pr.number, repo });
		}
		if (run?.head_sha) {
			shas.add(run.head_sha);
		}
		if (run?.head_branch) {
			branches.add(run.head_branch);
		}
	}
	if (e.event === 'status' && p.sha) {
		shas.add(p.sha);
	}
	if (e.event === 'push' && typeof p.ref === 'string' && p.ref.startsWith('refs/heads/')) {
		branches.add(p.ref.slice('refs/heads/'.length));
	}
	const items = snap.items.filter(item =>
		(item.contentId && contents.has(item.contentId))
		|| item.blockedBy.some(b => contents.has(b.id))
		|| item.pullRequests.some(pr =>
			prs.some(x => x.number === pr.number && (!x.repo || same(x.repo, pr.repository)))
			|| (pr.headSha && shas.has(pr.headSha))
			|| (pr.headRef && branches.has(pr.headRef) && same(repo, pr.repository) && pr.state === 'OPEN')));
	return { items: items.map(i => i.id), remove: [], full: false };
}

export function itemLabel(item: ProjectItem | undefined): string | undefined {
	return item ? (item.number ? `#${item.number}` : item.title) : undefined;
}

interface Pending {
	readonly value: FieldValue | undefined;
}

export class ProjectSync {
	private snap: ProjectSnapshot | undefined;
	private readonly pending = new Map<string, Map<string, Pending>>();
	private readonly queue = new Set<string>();
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private live = false;
	private down = false;
	private deps = true;
	private ownerKind: 'organization' | 'user' | undefined;
	private readonly repoIds = new Map<string, string>();
	private flushing: Promise<void> = Promise.resolve();
	private disposed = false;
	readonly journal: JournalEntry[] = [];
	status: SyncStatus = { kind: 'idle' };

	constructor(private readonly o: SyncOptions) {
		this.snap = o.initial;
	}

	get snapshot(): ProjectSnapshot | undefined {
		return this.snap;
	}

	get polling(): boolean {
		return !!this.pollTimer;
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.flushTimer);
		clearInterval(this.pollTimer);
	}

	private now(): number {
		return (this.o.now ?? Date.now)();
	}

	private setStatus(s: SyncStatus): void {
		this.status = s;
		this.o.onStatus?.(s);
	}

	private log(entry: Omit<JournalEntry, 'at'>): void {
		const e = { at: this.now(), ...entry };
		this.journal.unshift(e);
		this.journal.length = Math.min(this.journal.length, this.o.journalSize ?? 200);
		this.o.onJournal?.(e);
	}

	private emit(): void {
		if (this.snap) {
			this.o.onChange?.(this.snap);
		}
	}

	private synced(): void {
		this.setStatus({ kind: 'synced', at: this.now(), live: this.live });
	}

	/** A GraphQL call that drops the dependency fields when this GitHub does not know them. */
	private async query(make: (deps: boolean) => string, vars: Record<string, unknown>): Promise<any> {
		try {
			return await this.o.graphql(make(this.deps), vars);
		} catch (error) {
			if (this.deps && /blockedBy/.test(String(error instanceof Error ? error.message : error))) {
				this.deps = false;
				return this.o.graphql(make(false), vars);
			}
			throw error;
		}
	}

	/** Reads the whole project. */
	async refresh(): Promise<ProjectSnapshot> {
		this.setStatus({ kind: 'loading' });
		try {
			const kinds: ('organization' | 'user')[] = this.ownerKind ? [this.ownerKind] : ['organization', 'user'];
			let project: any;
			let lastError: unknown;
			const items: ProjectItem[] = [];
			for (const kind of kinds) {
				try {
					let after: string | null = null;
					items.length = 0;
					do {
						const data: any = await this.query(deps => projectQuery(kind, deps), { owner: this.o.owner, number: this.o.number, after });
						const p = data?.[kind]?.projectV2;
						if (!p) {
							throw new Error(`${this.o.owner}/${this.o.number}: no such project`);
						}
						project = p;
						for (const n of p.items?.nodes ?? []) {
							const item = parseItem(n);
							if (item) {
								items.push(this.overlay(item));
							}
						}
						after = p.items?.pageInfo?.hasNextPage ? p.items.pageInfo.endCursor : null;
					} while (after);
					this.ownerKind = kind;
					break;
				} catch (error) {
					project = undefined;
					lastError = error;
				}
			}
			if (!project) {
				throw lastError instanceof Error ? lastError : new Error(String(lastError));
			}
			this.snap = { id: project.id, owner: this.o.owner, number: project.number ?? this.o.number, title: project.title, url: project.url, fields: parseFields(project.fields?.nodes), items, fetchedAt: this.now() };
			this.emit();
			this.synced();
			return this.snap;
		} catch (error) {
			this.setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error), at: this.now() });
			throw error;
		}
	}

	/** A relay event: the items it touches are read again shortly. */
	handleEvent(e: RelayEvent): void {
		const snap = this.snap;
		if (!snap || this.disposed) {
			return;
		}
		const t = eventTargets(e, snap);
		if (t.full) {
			this.log({ direction: 'in', text: describe(e) });
			void this.refresh().catch(() => { });
			return;
		}
		if (t.remove.length) {
			const label = itemLabel(snap.items.find(i => i.id === t.remove[0]));
			this.snap = { ...snap, items: snap.items.filter(i => !t.remove.includes(i.id)) };
			this.log({ direction: 'in', ...(label ? { item: label } : {}), text: `removed from the project (${e.action})` });
			this.emit();
		}
		if (!t.items.length) {
			return;
		}
		const label = itemLabel(snap.items.find(i => i.id === t.items[0]));
		this.log({ direction: 'in', ...(label ? { item: label } : {}), text: describe(e) });
		for (const id of t.items) {
			this.queue.add(id);
		}
		clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => void this.flush(), this.o.debounceMs ?? 400);
	}

	/** Reads the queued items again, in one query per 50. */
	flush(): Promise<void> {
		this.flushing = this.flushing.then(() => this.doFlush()).catch(() => { });
		return this.flushing;
	}

	private async doFlush(): Promise<void> {
		const ids = [...this.queue];
		this.queue.clear();
		if (!ids.length || !this.snap) {
			return;
		}
		try {
			const got = new Map<string, ProjectItem | undefined>();
			for (let i = 0; i < ids.length; i += 50) {
				const chunk = ids.slice(i, i + 50);
				const data = await this.query(itemsQuery, { ids: chunk });
				const nodes: any[] = data?.nodes ?? [];
				chunk.forEach((id, n) => {
					const node = nodes[n];
					got.set(id, node && node.project?.id === this.snap?.id ? parseItem(node) : undefined);
				});
			}
			this.apply(got);
			this.synced();
		} catch (error) {
			this.setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error), at: this.now() });
		}
	}

	/** Puts read items in place (new ones at the end); `undefined` drops one. */
	private apply(got: Map<string, ProjectItem | undefined>): void {
		const snap = this.snap;
		if (!snap) {
			return;
		}
		const items: ProjectItem[] = [];
		for (const item of snap.items) {
			if (!got.has(item.id)) {
				items.push(item);
				continue;
			}
			const fresh = got.get(item.id);
			got.delete(item.id);
			if (fresh) {
				items.push(this.overlay(fresh));
			}
		}
		for (const fresh of got.values()) {
			if (fresh) {
				items.push(this.overlay(fresh));
			}
		}
		this.snap = { ...snap, items, fetchedAt: this.now() };
		this.emit();
	}

	/** Writes still on their way to GitHub stay on top of what a read brings. */
	private overlay(item: ProjectItem): ProjectItem {
		const p = this.pending.get(item.id);
		if (!p?.size) {
			return item;
		}
		const fields = { ...item.fields };
		for (const [fieldId, { value }] of p) {
			if (value) {
				fields[fieldId] = value;
			} else {
				delete fields[fieldId];
			}
		}
		return { ...item, fields };
	}

	/** The relay connection's state: polling while it is down, one full read when it is back. */
	setRelayState(s: RelayState): void {
		if (s.kind === 'connecting') {
			return;
		}
		this.live = s.kind === 'live';
		if (this.live) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
			if (this.down && this.snap) {
				void this.refresh().catch(() => { });
			} else if (this.status.kind === 'synced') {
				this.synced();
			}
			this.down = false;
			return;
		}
		this.down = true;
		if (!this.pollTimer && !this.disposed) {
			this.pollTimer = setInterval(() => void this.refresh().catch(() => { }), this.o.pollMs ?? 60_000);
		}
	}

	private need(): ProjectSnapshot {
		if (!this.snap) {
			throw new Error('the project is not loaded yet');
		}
		return this.snap;
	}

	private itemById(id: string): ProjectItem {
		const item = this.need().items.find(i => i.id === id);
		if (!item) {
			throw new Error('no such item on the project');
		}
		return item;
	}

	field(ref: string): ProjectField {
		const f = this.need().fields.find(x => x.id === ref) ?? this.need().fields.find(x => x.name.toLowerCase() === ref.toLowerCase());
		if (!f) {
			throw new Error(`the project has no field "${ref}"`);
		}
		return f;
	}

	private patch(itemId: string, change: (item: ProjectItem) => ProjectItem): void {
		const snap = this.need();
		this.snap = { ...snap, items: snap.items.map(i => i.id === itemId ? change(i) : i) };
		this.emit();
	}

	/** Sets a field (by id or name) on an item: shown at once, written to GitHub straight away. */
	async setField(itemId: string, fieldRef: string, input: FieldInput): Promise<void> {
		const snap = this.need();
		const item = this.itemById(itemId);
		const field = this.field(fieldRef);
		const { value, graphql } = resolveInput(field, input);
		const before = item.fields[field.id];
		const mark: Pending = { value };
		const map = this.pending.get(itemId) ?? new Map<string, Pending>();
		map.set(field.id, mark);
		this.pending.set(itemId, map);
		const put = (v: FieldValue | undefined) => this.patch(itemId, i => {
			const fields = { ...i.fields };
			if (v) {
				fields[field.id] = v;
			} else {
				delete fields[field.id];
			}
			return { ...i, fields };
		});
		put(value);
		const label = itemLabel(item);
		try {
			if (graphql) {
				await this.o.graphql(MUTATIONS.setField, { project: snap.id, item: itemId, field: field.id, value: graphql });
			} else {
				await this.o.graphql(MUTATIONS.clearField, { project: snap.id, item: itemId, field: field.id });
			}
			this.log({ direction: 'out', ...(label ? { item: label } : {}), text: `${field.name}: ${valueText(before)} → ${valueText(value)}` });
		} catch (error) {
			if (map.get(field.id) === mark) {
				put(before);
			}
			this.log({ direction: 'out', ...(label ? { item: label } : {}), text: `${field.name} → ${valueText(value)} refused: ${error instanceof Error ? error.message : String(error)}`, error: true });
			throw error;
		} finally {
			if (map.get(field.id) === mark) {
				map.delete(field.id);
			}
		}
	}

	/** Moves a card to a status column (the Status field). */
	async moveTo(itemId: string, status: string): Promise<void> {
		return this.setField(itemId, 'Status', status);
	}

	/** A new issue in `owner/name`, added to the project, with field values. Returns the item id. */
	async createIssue(repository: string, title: string, body?: string, fields?: Readonly<Record<string, FieldInput>>): Promise<string> {
		const snap = this.need();
		const [owner, name] = repository.split('/');
		if (!owner || !name || !title.trim()) {
			throw new Error('a repository (owner/name) and a title are needed');
		}
		try {
			let repoId = this.repoIds.get(repository.toLowerCase());
			if (!repoId) {
				repoId = (await this.o.graphql(MUTATIONS.repository, { owner, name }))?.repository?.id as string | undefined;
				if (!repoId) {
					throw new Error(`no repository ${repository}`);
				}
				this.repoIds.set(repository.toLowerCase(), repoId);
			}
			const issue = (await this.o.graphql(MUTATIONS.createIssue, { repo: repoId, title: title.trim(), body: body ?? '' }))?.createIssue?.issue;
			const itemId = (await this.o.graphql(MUTATIONS.addItem, { project: snap.id, content: issue.id }))?.addProjectV2ItemById?.item?.id as string;
			this.log({ direction: 'out', item: `#${issue.number}`, text: `new issue in ${repository}: ${title.trim()}` });
			this.queue.add(itemId);
			await this.flush();
			for (const [field, value] of Object.entries(fields ?? {})) {
				await this.setField(itemId, field, value);
			}
			return itemId;
		} catch (error) {
			this.log({ direction: 'out', text: `new issue "${title.trim()}" refused: ${error instanceof Error ? error.message : String(error)}`, error: true });
			throw error;
		}
	}

	private issuePair(blockedItemId: string, blockingItemId: string): { blocked: ProjectItem; blocking: ProjectItem } {
		const blocked = this.itemById(blockedItemId);
		const blocking = this.itemById(blockingItemId);
		if (blocked.type !== 'issue' || blocking.type !== 'issue' || !blocked.contentId || !blocking.contentId) {
			throw new Error('dependencies link issues only');
		}
		if (blocked.id === blocking.id) {
			throw new Error('an issue cannot block itself');
		}
		return { blocked, blocking };
	}

	/** `blocked` is blocked by `blocking` (GitHub's issue dependency). */
	async addDependency(blockedItemId: string, blockingItemId: string): Promise<void> {
		const { blocked, blocking } = this.issuePair(blockedItemId, blockingItemId);
		if (blocked.blockedBy.some(b => b.id === blocking.contentId)) {
			return;
		}
		const ref: IssueRef = { id: blocking.contentId!, number: blocking.number ?? 0, repository: blocking.repository ?? '' };
		return this.dependency(blocked, blocking, MUTATIONS.addBlockedBy, i => ({ ...i, blockedBy: [...i.blockedBy, ref] }), i => ({ ...i, blockedBy: i.blockedBy.filter(b => b.id !== ref.id) }), 'blocked by');
	}

	async removeDependency(blockedItemId: string, blockingItemId: string): Promise<void> {
		const { blocked, blocking } = this.issuePair(blockedItemId, blockingItemId);
		const ref = blocked.blockedBy.find(b => b.id === blocking.contentId);
		if (!ref) {
			return;
		}
		return this.dependency(blocked, blocking, MUTATIONS.removeBlockedBy, i => ({ ...i, blockedBy: i.blockedBy.filter(b => b.id !== ref.id) }), i => ({ ...i, blockedBy: [...i.blockedBy, ref] }), 'no longer blocked by');
	}

	private async dependency(blocked: ProjectItem, blocking: ProjectItem, mutation: string, apply: (i: ProjectItem) => ProjectItem, undo: (i: ProjectItem) => ProjectItem, words: string): Promise<void> {
		this.patch(blocked.id, apply);
		const label = itemLabel(blocked);
		try {
			await this.o.graphql(mutation, { issue: blocked.contentId, blocking: blocking.contentId });
			this.log({ direction: 'out', ...(label ? { item: label } : {}), text: `${words} ${itemLabel(blocking)}` });
		} catch (error) {
			this.patch(blocked.id, undo);
			this.log({ direction: 'out', ...(label ? { item: label } : {}), text: `${words} ${itemLabel(blocking)} refused: ${error instanceof Error ? error.message : String(error)}`, error: true });
			throw error;
		}
	}

	/** Renames or closes / reopens an issue. */
	async updateIssue(itemId: string, change: { title?: string; state?: 'OPEN' | 'CLOSED' }): Promise<void> {
		const item = this.itemById(itemId);
		if (item.type !== 'issue' || !item.contentId) {
			throw new Error('only issues can be changed this way');
		}
		const before = { title: item.title, state: item.state };
		this.patch(itemId, i => ({ ...i, ...(change.title ? { title: change.title } : {}), ...(change.state ? { state: change.state } : {}) }));
		const label = itemLabel(item);
		const what = [change.title ? `title → ${change.title}` : '', change.state ? (change.state === 'CLOSED' ? 'closed' : 'reopened') : ''].filter(Boolean).join(', ');
		try {
			await this.o.graphql(MUTATIONS.updateIssue, { id: item.contentId, ...(change.title ? { title: change.title } : {}), ...(change.state ? { state: change.state } : {}) });
			this.log({ direction: 'out', ...(label ? { item: label } : {}), text: what });
		} catch (error) {
			this.patch(itemId, i => ({ ...i, title: before.title, ...(before.state ? { state: before.state } : {}) }));
			this.log({ direction: 'out', ...(label ? { item: label } : {}), text: `${what} refused: ${error instanceof Error ? error.message : String(error)}`, error: true });
			throw error;
		}
	}
}

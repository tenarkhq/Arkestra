/*---------------------------------------------------------------------------------------------
 *  Arkestra. The GitHub Project model and the two-way sync: reading, event routing, batched
 *  re-reads, optimistic writes with rollback, dependencies, new issues, polling fallback.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MUTATIONS, parseItem, parseProjectRef, resolveInput, type ProjectField } from '../project';
import { ProjectSync, eventTargets, type GraphQL, type JournalEntry } from '../sync';
import type { RelayEvent } from '../relayClient';

const STATUS: ProjectField = { id: 'F_status', name: 'Status', type: 'single_select', options: [{ id: 'o_todo', name: 'Todo' }, { id: 'o_prog', name: 'In progress' }, { id: 'o_done', name: 'Done' }] };

function itemNode(id: string, n: number, extra: { status?: string; pr?: boolean; blockedBy?: string[]; sha?: string; branch?: string; title?: string; prs?: { number: number; sha: string }[] } = {}): any {
	const opt = STATUS.options!.find(o => o.name === (extra.status ?? 'Todo'))!;
	const ci = (sha: string) => ({ commits: { nodes: [{ commit: { oid: sha, statusCheckRollup: { state: 'PENDING' } } }] } });
	return {
		id, type: extra.pr ? 'PULL_REQUEST' : 'ISSUE', isArchived: false, project: { id: 'P1' },
		fieldValues: { nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: opt.id, name: opt.name, field: { id: 'F_status' } }, { __typename: 'ProjectV2ItemFieldTextValue', text: '0.9', field: { id: 'F_line' } }] },
		content: extra.pr
			? { __typename: 'PullRequest', id: `C${n}`, number: n, title: extra.title ?? `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, state: 'OPEN', isDraft: false, headRefName: extra.branch ?? `b${n}`, repository: { nameWithOwner: 'o/r' }, labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0 }, ...ci(extra.sha ?? `sha${n}`) }
			: {
				__typename: 'Issue', id: `C${n}`, number: n, title: extra.title ?? `Issue ${n}`, url: `https://github.com/o/r/issues/${n}`, state: 'OPEN', repository: { nameWithOwner: 'o/r' },
				labels: { nodes: [{ name: 'feature' }] }, assignees: { nodes: [{ login: 'dev' }] }, comments: { totalCount: 2 },
				blockedBy: { nodes: (extra.blockedBy ?? []).map(b => ({ id: b, number: Number(b.slice(1)), repository: { nameWithOwner: 'o/r' } })) },
				closedByPullRequestsReferences: { nodes: (extra.prs ?? []).map(p => ({ number: p.number, url: '', state: 'OPEN', headRefName: `b${p.number}`, repository: { nameWithOwner: 'o/r' }, ...ci(p.sha) })) },
			},
	};
}

/** A fake GitHub: a project in an organization, item nodes by id, and a record of every call. */
function fakeGitHub(opts: { refuse?: RegExp; noDeps?: boolean; user?: boolean } = {}) {
	const nodes = new Map<string, any>([
		['I1', itemNode('I1', 1, { prs: [{ number: 9, sha: 'abc' }] })],
		['I2', itemNode('I2', 2, { status: 'In progress', blockedBy: ['C1'] })],
		['I3', itemNode('I3', 3, { pr: true, sha: 'def', branch: 'feature-x' })],
	]);
	const calls: { query: string; vars: any }[] = [];
	const gql: GraphQL = async (query, v) => {
		const vars: any = v ?? {};
		calls.push({ query, vars });
		if (opts.noDeps && query.includes('blockedBy(first')) {
			throw new Error('Field \'blockedBy\' doesn\'t exist on type \'Issue\'');
		}
		if (opts.refuse?.test(query)) {
			throw new Error('Resource not accessible by integration');
		}
		if (query.includes('projectV2(number')) {
			const kind = query.includes('organization(') ? 'organization' : 'user';
			if ((kind === 'organization') === !!opts.user) {
				throw new Error(`Could not resolve to an ${kind === 'organization' ? 'Organization' : 'User'}`);
			}
			const all = [...nodes.values()];
			const page = vars?.after ? all.slice(2) : all.slice(0, 2);
			return { [kind]: { projectV2: { id: 'P1', title: 'Arkestra', url: 'https://github.com/orgs/o/projects/3', number: 3, fields: { nodes: [{ id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: STATUS.options }, { id: 'F_line', name: 'Line', dataType: 'TEXT' }, { id: 'F_title', name: 'Title', dataType: 'TITLE' }] }, items: { pageInfo: { hasNextPage: !vars?.after, endCursor: 'c1' }, nodes: page } } } };
		}
		if (query.includes('nodes(ids')) {
			return { nodes: vars.ids.map((id: string) => nodes.get(id) ?? null) };
		}
		if (query === MUTATIONS.repository) {
			return { repository: { id: 'R1' } };
		}
		if (query === MUTATIONS.createIssue) {
			nodes.set('I4', itemNode('I4', 4, { title: vars.title }));
			return { createIssue: { issue: { id: 'C4', number: 4, url: '' } } };
		}
		if (query === MUTATIONS.addItem) {
			return { addProjectV2ItemById: { item: { id: 'I4' } } };
		}
		return {};
	};
	return { gql, nodes, calls };
}

const event = (event: string, payload: any, action?: string): RelayEvent => ({ id: 1, delivery: 'd', event, action, repository: 'o/r', receivedAt: 0, payload });

test('project references: owner/number and project URLs', () => {
	assert.deepEqual(parseProjectRef('tenarkhq/3'), { owner: 'tenarkhq', number: 3 });
	assert.deepEqual(parseProjectRef('https://github.com/orgs/tenarkhq/projects/3/views/1'), { owner: 'tenarkhq', number: 3 });
	assert.deepEqual(parseProjectRef('https://github.com/users/someone/projects/12'), { owner: 'someone', number: 12 });
	assert.equal(parseProjectRef('tenarkhq'), undefined);
});

test('an item node becomes fields, dependencies, linked PRs and CI', () => {
	const item = parseItem(itemNode('I2', 2, { status: 'In progress', blockedBy: ['C1'], prs: [{ number: 9, sha: 'abc' }] }))!;
	assert.equal(item.type, 'issue');
	assert.deepEqual(item.fields.F_status, { kind: 'option', optionId: 'o_prog', name: 'In progress' });
	assert.deepEqual(item.blockedBy, [{ id: 'C1', number: 1, repository: 'o/r' }]);
	assert.equal(item.pullRequests[0].ci, 'pending');
	assert.equal(item.pullRequests[0].headSha, 'abc');
	assert.deepEqual([item.labels, item.assignees, item.comments], [['feature'], ['dev'], 2]);
	assert.equal(parseItem({ ...itemNode('I9', 9), isArchived: true }), undefined);
});

test('inputs: options by name, numbers, dates; bad input refused', () => {
	assert.deepEqual(resolveInput(STATUS, 'done').graphql, { singleSelectOptionId: 'o_done' });
	assert.deepEqual(resolveInput(STATUS, null), {});
	assert.throws(() => resolveInput(STATUS, 'Nope'), /no option/);
	assert.deepEqual(resolveInput({ id: 'n', name: 'Estimate', type: 'number' }, '2.5').graphql, { number: 2.5 });
	assert.throws(() => resolveInput({ id: 'd', name: 'Due', type: 'date' }, 'tomorrow'), /date/);
});

test('reading: organization or user, every page, dependencies dropped where GitHub lacks them', async () => {
	const org = fakeGitHub();
	const s = new ProjectSync({ graphql: org.gql, owner: 'o', number: 3 });
	const snap = await s.refresh();
	assert.deepEqual(snap.items.map(i => i.id), ['I1', 'I2', 'I3']);
	assert.deepEqual(snap.fields.map(f => [f.name, f.type]), [['Status', 'single_select'], ['Line', 'text'], ['Title', 'other']]);
	assert.equal(s.status.kind, 'synced');

	const user = fakeGitHub({ user: true, noDeps: true });
	const u = new ProjectSync({ graphql: user.gql, owner: 'someone', number: 3 });
	assert.equal((await u.refresh()).items.length, 3);
	assert.ok(user.calls.some(c => c.query.includes('user(') && !c.query.includes('blockedBy(first')));
});

test('events find their items: project item, issue, blocking issue, PR checks by number, sha and branch', async () => {
	const g = fakeGitHub();
	const s = new ProjectSync({ graphql: g.gql, owner: 'o', number: 3 });
	const snap = await s.refresh();
	assert.deepEqual(eventTargets(event('projects_v2_item', { projects_v2_item: { node_id: 'I2', project_node_id: 'P1' } }, 'edited'), snap).items, ['I2']);
	assert.deepEqual(eventTargets(event('projects_v2_item', { projects_v2_item: { node_id: 'I2', project_node_id: 'OTHER' } }, 'edited'), snap).items, []);
	assert.deepEqual(eventTargets(event('projects_v2_item', { projects_v2_item: { node_id: 'I2', project_node_id: 'P1' } }, 'deleted'), snap).remove, ['I2']);
	// Issue 1 changes: its own card and the card it blocks.
	assert.deepEqual(eventTargets(event('issues', { issue: { node_id: 'C1' } }, 'closed'), snap).items, ['I1', 'I2']);
	assert.deepEqual(eventTargets(event('check_run', { check_run: { head_sha: 'zzz', pull_requests: [{ number: 9 }] } }, 'completed'), snap).items, ['I1']);
	assert.deepEqual(eventTargets(event('status', { sha: 'def' }), snap).items, ['I3']);
	assert.deepEqual(eventTargets(event('push', { ref: 'refs/heads/feature-x' }), snap).items, ['I3']);
	assert.deepEqual(eventTargets(event('push', { ref: 'refs/heads/main' }), snap).items, []);
});

test('GitHub → here: events in a row become one re-read; a removed item leaves', async () => {
	const g = fakeGitHub();
	const journal: JournalEntry[] = [];
	const s = new ProjectSync({ graphql: g.gql, owner: 'o', number: 3, debounceMs: 5, onJournal: e => journal.push(e) });
	await s.refresh();
	g.nodes.set('I2', itemNode('I2', 2, { status: 'Done', blockedBy: ['C1'] }));
	g.nodes.set('I3', itemNode('I3', 3, { pr: true, sha: 'def', title: 'Renamed' }));
	const before = g.calls.length;
	s.handleEvent(event('projects_v2_item', { projects_v2_item: { node_id: 'I2', project_node_id: 'P1' } }, 'edited'));
	s.handleEvent(event('pull_request', { pull_request: { node_id: 'C3', number: 3 } }, 'edited'));
	await new Promise(r => setTimeout(r, 30));
	await s.flush();
	const reads = g.calls.slice(before).filter(c => c.query.includes('nodes(ids'));
	assert.equal(reads.length, 1);
	assert.deepEqual(reads[0].vars.ids, ['I2', 'I3']);
	assert.equal(s.snapshot!.items.find(i => i.id === 'I2')!.fields.F_status?.kind === 'option' && (s.snapshot!.items.find(i => i.id === 'I2')!.fields.F_status as any).name, 'Done');
	assert.equal(s.snapshot!.items.find(i => i.id === 'I3')!.title, 'Renamed');
	assert.ok(journal.every(e => e.direction === 'in'));

	s.handleEvent(event('projects_v2_item', { projects_v2_item: { node_id: 'I3', project_node_id: 'P1' } }, 'deleted'));
	assert.deepEqual(s.snapshot!.items.map(i => i.id), ['I1', 'I2']);
	s.dispose();
});

test('here → GitHub: a move shows at once, is written, and comes back if GitHub refuses', async () => {
	const g = fakeGitHub();
	const journal: JournalEntry[] = [];
	const seen: string[] = [];
	const s = new ProjectSync({ graphql: g.gql, owner: 'o', number: 3, onJournal: e => journal.push(e), onChange: snap => seen.push((snap.items[0].fields.F_status as any)?.name) });
	await s.refresh();
	const write = s.moveTo('I1', 'In progress');
	assert.equal((s.snapshot!.items[0].fields.F_status as any).name, 'In progress'); // before GitHub answered
	await write;
	const call = g.calls.at(-1)!;
	assert.equal(call.query, MUTATIONS.setField);
	assert.deepEqual(call.vars, { project: 'P1', item: 'I1', field: 'F_status', value: { singleSelectOptionId: 'o_prog' } });
	assert.equal(journal.at(-1)!.text, 'Status: Todo → In progress');
	assert.equal(journal.at(-1)!.item, '#1');

	await s.setField('I1', 'Line', null);
	assert.equal(g.calls.at(-1)!.query, MUTATIONS.clearField);
	assert.equal(s.snapshot!.items[0].fields.F_line, undefined);

	const refusing = fakeGitHub({ refuse: /updateProjectV2ItemFieldValue/ });
	const r = new ProjectSync({ graphql: refusing.gql, owner: 'o', number: 3, onJournal: e => journal.push(e) });
	await r.refresh();
	await assert.rejects(r.moveTo('I1', 'Done'), /not accessible/);
	assert.equal((r.snapshot!.items[0].fields.F_status as any).name, 'Todo');
	assert.equal(journal.at(-1)!.error, true);
	assert.ok(seen.includes('In progress'));
});

test('a re-read while a write is on its way keeps the written value', async () => {
	let release!: () => void;
	const g = fakeGitHub();
	const slow: GraphQL = async (q, v) => {
		if (q === MUTATIONS.setField) {
			await new Promise<void>(r => { release = r; });
		}
		return g.gql(q, v);
	};
	const s = new ProjectSync({ graphql: slow, owner: 'o', number: 3, debounceMs: 1 });
	await s.refresh();
	const write = s.moveTo('I1', 'Done');
	s.handleEvent(event('issues', { issue: { node_id: 'C1' } }, 'edited'));
	await new Promise(r => setTimeout(r, 10));
	await s.flush();
	assert.equal((s.snapshot!.items[0].fields.F_status as any).name, 'Done'); // GitHub still says Todo
	release();
	await write;
	s.dispose();
});

test('dependencies and new issues are written to GitHub', async () => {
	const g = fakeGitHub();
	const s = new ProjectSync({ graphql: g.gql, owner: 'o', number: 3 });
	await s.refresh();
	await s.addDependency('I1', 'I2');
	assert.deepEqual(g.calls.at(-1)!.vars, { issue: 'C1', blocking: 'C2' });
	assert.deepEqual(s.snapshot!.items[0].blockedBy.map(b => b.number), [2]);
	await s.removeDependency('I2', 'I1');
	assert.equal(g.calls.at(-1)!.query, MUTATIONS.removeBlockedBy);
	assert.deepEqual(s.snapshot!.items[1].blockedBy, []);
	await assert.rejects(s.addDependency('I1', 'I3'), /issues only/);

	const id = await s.createIssue('o/r', 'Board view', 'details', { Status: 'In progress' });
	assert.equal(id, 'I4');
	const created = s.snapshot!.items.find(i => i.id === 'I4')!;
	assert.equal(created.title, 'Board view');
	assert.equal((created.fields.F_status as any).name, 'In progress');

	await s.updateIssue('I1', { state: 'CLOSED' });
	assert.deepEqual(g.calls.at(-1)!.vars, { id: 'C1', state: 'CLOSED' });
	assert.equal(s.snapshot!.items[0].state, 'CLOSED');
});

test('polling runs only while the relay is down; when it is back, one full read catches up', async () => {
	const g = fakeGitHub();
	const s = new ProjectSync({ graphql: g.gql, owner: 'o', number: 3, pollMs: 60_000 });
	await s.refresh();
	s.setRelayState({ kind: 'live', since: 0 });
	assert.equal(s.polling, false);
	s.setRelayState({ kind: 'error', message: 'down', retryAt: 0 });
	assert.equal(s.polling, true);
	const reads = () => g.calls.filter(c => c.query.includes('projectV2(number')).length;
	const before = reads();
	s.setRelayState({ kind: 'live', since: 1 });
	assert.equal(s.polling, false);
	await new Promise(r => setTimeout(r, 10));
	assert.ok(reads() > before);
	s.dispose();
});

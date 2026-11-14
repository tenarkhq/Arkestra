/*---------------------------------------------------------------------------------------------
 *  Arkestra. The GitHub Project model (AR29): fields, items and their values, read with
 *  GraphQL, and the mutations that write changes back. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

export type FieldType = 'single_select' | 'text' | 'number' | 'date' | 'iteration' | 'other';

export interface FieldOption {
	readonly id: string;
	readonly name: string;
	readonly color?: string;
}

export interface ProjectField {
	readonly id: string;
	readonly name: string;
	readonly type: FieldType;
	readonly options?: readonly FieldOption[];
	readonly iterations?: readonly { readonly id: string; readonly title: string; readonly startDate?: string }[];
}

export type FieldValue =
	| { readonly kind: 'option'; readonly optionId: string; readonly name: string }
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'number'; readonly number: number }
	| { readonly kind: 'date'; readonly date: string }
	| { readonly kind: 'iteration'; readonly iterationId: string; readonly title: string };

/** What a write sets: an option (by id or name), text, a number, a date, an iteration, or nothing (clear). */
export type FieldInput = string | number | null | { readonly optionId: string } | { readonly iterationId: string } | { readonly date: string };

export type Ci = 'success' | 'failure' | 'pending' | 'error' | 'expected';

export interface IssueRef {
	readonly id: string;
	readonly number: number;
	readonly repository: string;
}

export interface LinkedPr {
	readonly number: number;
	readonly url: string;
	readonly state: string;
	readonly repository: string;
	readonly headRef?: string;
	readonly headSha?: string;
	readonly ci?: Ci;
}

export interface ProjectItem {
	/** The project item's node id. */
	readonly id: string;
	readonly type: 'issue' | 'pr' | 'draft';
	/** The issue's, PR's or draft's node id. */
	readonly contentId?: string;
	readonly number?: number;
	readonly title: string;
	readonly url?: string;
	/** OPEN, CLOSED, MERGED. */
	readonly state?: string;
	readonly isDraft?: boolean;
	readonly repository?: string;
	readonly labels: readonly string[];
	readonly assignees: readonly string[];
	/** By field id. */
	readonly fields: Readonly<Record<string, FieldValue>>;
	readonly blockedBy: readonly IssueRef[];
	/** The PR itself (for a PR item) or the PRs that close the issue. */
	readonly pullRequests: readonly LinkedPr[];
	readonly reviewDecision?: string;
	readonly comments?: number;
	readonly updatedAt?: string;
}

export interface ProjectSnapshot {
	readonly id: string;
	readonly owner: string;
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly fields: readonly ProjectField[];
	readonly items: readonly ProjectItem[];
	readonly fetchedAt: number;
}

/** `tenarkhq/3`, `https://github.com/orgs/tenarkhq/projects/3` or `https://github.com/users/x/projects/3`. */
export function parseProjectRef(text: string): { owner: string; number: number } | undefined {
	const t = text.trim();
	const url = /github\.com\/(?:orgs|users)\/([^/\s]+)\/projects\/(\d+)/.exec(t);
	const short = /^([A-Za-z0-9][\w.-]*)\/(\d+)$/.exec(t);
	const m = url ?? short;
	return m ? { owner: m[1], number: Number(m[2]) } : undefined;
}

/** The projects the signed-in user can open: their own, then their organizations'. */
export const PROJECT_LIST_QUERY = `query{ viewer{ login
	projectsV2(first:50, orderBy:{field:UPDATED_AT, direction:DESC}){ nodes{ number title closed } }
	organizations(first:50){ nodes{ login projectsV2(first:50, orderBy:{field:UPDATED_AT, direction:DESC}){ nodes{ number title closed } } } } } }`;

export interface ProjectChoice {
	readonly owner: string;
	readonly number: number;
	readonly title: string;
	readonly closed: boolean;
}

/** The project list's answer: open projects first, the user's own before the organizations'. */
export function parseProjectList(data: any): ProjectChoice[] {
	const viewer = data?.viewer;
	const of = (owner: unknown, nodes: unknown): ProjectChoice[] => typeof owner === 'string' && Array.isArray(nodes)
		? nodes.filter((p: any) => typeof p?.number === 'number').map((p: any) => ({ owner, number: p.number, title: typeof p.title === 'string' && p.title ? p.title : `#${p.number}`, closed: !!p.closed }))
		: [];
	const all = [
		...of(viewer?.login, viewer?.projectsV2?.nodes),
		...(Array.isArray(viewer?.organizations?.nodes) ? viewer.organizations.nodes.flatMap((o: any) => of(o?.login, o?.projectsV2?.nodes)) : []),
	];
	return [...all.filter(p => !p.closed), ...all.filter(p => p.closed)];
}

const FIELD_ID = 'field{ ... on ProjectV2FieldCommon{ id } }';
const CI = 'commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state } } } }';

/** The item fragment; `deps` adds the issue dependencies (blocked by). */
export function itemFragment(deps: boolean): string {
	return `fragment I on ProjectV2Item { id type updatedAt isArchived
		fieldValues(first:30){ nodes{ __typename
			... on ProjectV2ItemFieldSingleSelectValue{ optionId name ${FIELD_ID} }
			... on ProjectV2ItemFieldTextValue{ text ${FIELD_ID} }
			... on ProjectV2ItemFieldNumberValue{ number ${FIELD_ID} }
			... on ProjectV2ItemFieldDateValue{ date ${FIELD_ID} }
			... on ProjectV2ItemFieldIterationValue{ iterationId title ${FIELD_ID} } } }
		content{ __typename
			... on DraftIssue{ id title }
			... on Issue{ id number title url state updatedAt repository{ nameWithOwner }
				labels(first:20){ nodes{ name } } assignees(first:10){ nodes{ login } } comments{ totalCount }
				${deps ? 'blockedBy(first:20){ nodes{ id number repository{ nameWithOwner } } }' : ''}
				closedByPullRequestsReferences(first:5){ nodes{ number url state headRefName repository{ nameWithOwner } ${CI} } } }
			... on PullRequest{ id number title url state isDraft reviewDecision updatedAt headRefName repository{ nameWithOwner }
				labels(first:20){ nodes{ name } } assignees(first:10){ nodes{ login } } comments{ totalCount } ${CI} } } }`;
}

const PROJECT_BODY = `id title url number
	fields(first:50){ nodes{ __typename
		... on ProjectV2FieldCommon{ id name dataType }
		... on ProjectV2SingleSelectField{ options{ id name color } }
		... on ProjectV2IterationField{ configuration{ iterations{ id title startDate } } } } }
	items(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ...I } }`;

export function projectQuery(ownerKind: 'organization' | 'user', deps: boolean): string {
	return `query($owner:String!, $number:Int!, $after:String){ ${ownerKind}(login:$owner){ projectV2(number:$number){ ${PROJECT_BODY} } } } ${itemFragment(deps)}`;
}

export function itemsQuery(deps: boolean): string {
	return `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProjectV2Item{ ...I project{ id } } } } ${itemFragment(deps)}`;
}

export const MUTATIONS = {
	setField: `mutation($project:ID!, $item:ID!, $field:ID!, $value:ProjectV2FieldValue!){ updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:$value}){ projectV2Item{ id } } }`,
	clearField: `mutation($project:ID!, $item:ID!, $field:ID!){ clearProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field}){ projectV2Item{ id } } }`,
	repository: `query($owner:String!, $name:String!){ repository(owner:$owner, name:$name){ id } }`,
	createIssue: `mutation($repo:ID!, $title:String!, $body:String){ createIssue(input:{repositoryId:$repo, title:$title, body:$body}){ issue{ id number url } } }`,
	addItem: `mutation($project:ID!, $content:ID!){ addProjectV2ItemById(input:{projectId:$project, contentId:$content}){ item{ id } } }`,
	addBlockedBy: `mutation($issue:ID!, $blocking:ID!){ addBlockedBy(input:{issueId:$issue, blockingIssueId:$blocking}){ issue{ id } } }`,
	removeBlockedBy: `mutation($issue:ID!, $blocking:ID!){ removeBlockedBy(input:{issueId:$issue, blockingIssueId:$blocking}){ issue{ id } } }`,
	updateIssue: `mutation($id:ID!, $title:String, $state:IssueState){ updateIssue(input:{id:$id, title:$title, state:$state}){ issue{ id } } }`,
};

function fieldType(dataType: string | undefined): FieldType {
	switch (dataType) {
		case 'SINGLE_SELECT': return 'single_select';
		case 'TEXT': return 'text';
		case 'NUMBER': return 'number';
		case 'DATE': return 'date';
		case 'ITERATION': return 'iteration';
		default: return 'other';
	}
}

export function parseFields(nodes: any[] | undefined): ProjectField[] {
	return (nodes ?? []).filter(n => n?.id && n?.name).map(n => ({
		id: n.id,
		name: n.name,
		type: fieldType(n.dataType),
		...(n.options ? { options: n.options.map((o: any) => ({ id: o.id, name: o.name, ...(o.color ? { color: o.color } : {}) })) } : {}),
		...(n.configuration?.iterations ? { iterations: n.configuration.iterations.map((i: any) => ({ id: i.id, title: i.title, startDate: i.startDate })) } : {}),
	}));
}

function ciOf(node: any): { headSha?: string; ci?: Ci } {
	const commit = node?.commits?.nodes?.[0]?.commit;
	const state = commit?.statusCheckRollup?.state as string | undefined;
	return { ...(commit?.oid ? { headSha: commit.oid } : {}), ...(state ? { ci: state.toLowerCase() as Ci } : {}) };
}

function prOf(n: any): LinkedPr {
	return { number: n.number, url: n.url, state: n.state, repository: n.repository?.nameWithOwner ?? '', ...(n.headRefName ? { headRef: n.headRefName } : {}), ...ciOf(n) };
}

/** One item from its GraphQL node; undefined for archived or empty nodes. */
export function parseItem(node: any): ProjectItem | undefined {
	if (!node?.id || node.isArchived) {
		return undefined;
	}
	const fields: Record<string, FieldValue> = {};
	for (const v of node.fieldValues?.nodes ?? []) {
		const id = v?.field?.id;
		if (!id) {
			continue;
		}
		switch (v.__typename) {
			case 'ProjectV2ItemFieldSingleSelectValue': fields[id] = { kind: 'option', optionId: v.optionId, name: v.name }; break;
			case 'ProjectV2ItemFieldTextValue': fields[id] = { kind: 'text', text: v.text ?? '' }; break;
			case 'ProjectV2ItemFieldNumberValue': fields[id] = { kind: 'number', number: Number(v.number) }; break;
			case 'ProjectV2ItemFieldDateValue': fields[id] = { kind: 'date', date: v.date }; break;
			case 'ProjectV2ItemFieldIterationValue': fields[id] = { kind: 'iteration', iterationId: v.iterationId, title: v.title }; break;
		}
	}
	const c = node.content ?? {};
	const type = c.__typename === 'PullRequest' ? 'pr' : c.__typename === 'Issue' ? 'issue' : 'draft';
	return {
		id: node.id,
		type,
		...(c.id ? { contentId: c.id } : {}),
		...(c.number ? { number: c.number } : {}),
		title: c.title ?? '',
		...(c.url ? { url: c.url } : {}),
		...(c.state ? { state: c.state } : {}),
		...(type === 'pr' ? { isDraft: !!c.isDraft } : {}),
		...(c.repository?.nameWithOwner ? { repository: c.repository.nameWithOwner } : {}),
		labels: (c.labels?.nodes ?? []).map((l: any) => l.name),
		assignees: (c.assignees?.nodes ?? []).map((a: any) => a.login),
		fields,
		blockedBy: (c.blockedBy?.nodes ?? []).map((b: any) => ({ id: b.id, number: b.number, repository: b.repository?.nameWithOwner ?? '' })),
		pullRequests: type === 'pr' ? [prOf(c)] : (c.closedByPullRequestsReferences?.nodes ?? []).map(prOf),
		...(c.reviewDecision ? { reviewDecision: c.reviewDecision } : {}),
		...(typeof c.comments?.totalCount === 'number' ? { comments: c.comments.totalCount } : {}),
		...(c.updatedAt ?? node.updatedAt ? { updatedAt: c.updatedAt ?? node.updatedAt } : {}),
	};
}

/** The value a field gets from a write's input, for the optimistic update; throws on a bad input. */
export function resolveInput(field: ProjectField, input: FieldInput): { value?: FieldValue; graphql?: Record<string, unknown> } {
	if (input === null || input === '') {
		return {};
	}
	switch (field.type) {
		case 'single_select': {
			const want = typeof input === 'object' && 'optionId' in input ? input.optionId : String(input);
			const option = field.options?.find(o => o.id === want) ?? field.options?.find(o => o.name.toLowerCase() === want.toLowerCase());
			if (!option) {
				throw new Error(`"${field.name}" has no option "${want}"`);
			}
			return { value: { kind: 'option', optionId: option.id, name: option.name }, graphql: { singleSelectOptionId: option.id } };
		}
		case 'text':
			return { value: { kind: 'text', text: String(input) }, graphql: { text: String(input) } };
		case 'number': {
			const n = typeof input === 'number' ? input : Number(input);
			if (!Number.isFinite(n)) {
				throw new Error(`"${field.name}" needs a number`);
			}
			return { value: { kind: 'number', number: n }, graphql: { number: n } };
		}
		case 'date': {
			const d = typeof input === 'object' && 'date' in input ? input.date : String(input);
			if (!/^\d{4}-\d{2}-\d{2}/.test(d)) {
				throw new Error(`"${field.name}" needs a date (YYYY-MM-DD)`);
			}
			return { value: { kind: 'date', date: d.slice(0, 10) }, graphql: { date: d.slice(0, 10) } };
		}
		case 'iteration': {
			const want = typeof input === 'object' && 'iterationId' in input ? input.iterationId : String(input);
			const it = field.iterations?.find(i => i.id === want) ?? field.iterations?.find(i => i.title.toLowerCase() === want.toLowerCase());
			if (!it) {
				throw new Error(`"${field.name}" has no iteration "${want}"`);
			}
			return { value: { kind: 'iteration', iterationId: it.id, title: it.title }, graphql: { iterationId: it.id } };
		}
		default:
			throw new Error(`"${field.name}" cannot be set from Arkestra`);
	}
}

/** A value as text, as the views and the journal show it. */
export function valueText(v: FieldValue | undefined): string {
	if (!v) {
		return '—';
	}
	switch (v.kind) {
		case 'option': return v.name;
		case 'text': return v.text;
		case 'number': return String(v.number);
		case 'date': return v.date;
		case 'iteration': return v.title;
	}
}

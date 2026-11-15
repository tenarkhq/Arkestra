/*---------------------------------------------------------------------------------------------
 *  Arkestra. The new-room form of the 2ARK templates as one page: the type, the two agents and
 *  what each type asks for, with 2ARK's defaults; and the request built from what came back.
 *  No VS Code here, so it is testable; the texts come in already translated.
 *--------------------------------------------------------------------------------------------*/

import type { FormSpec } from './pageForm';
import type { Role } from './templates/signals';
import { DEFAULT_MAX, type AuditState, type Member, type TemplateType } from './templates/types';

export interface TemplateRequest {
	readonly type: TemplateType;
	readonly members: Record<Role, Member>;
	readonly title: string;
	readonly max: number;
	readonly review?: { reviewer: Role; prompt: string; source?: string; strict: 'all' | 'major' | 'critical' };
	readonly code?: { repo: string; base: string; coordinator: Role; prompt: string; issue?: string; plan: 'approve' | 'none'; test?: string; verify: boolean };
	readonly audit?: Pick<AuditState, 'auditors' | 'lead' | 'since' | 'focus' | 'goal' | 'fix' | 'levels'>;
}

/** A brief that is a reference the agents read themselves: an issue or PR link, #123, or a task number. */
export function briefReference(text: string): { issue?: string; prompt: string } {
	const [first, ...rest] = text.trim().split('\n');
	const ref = first.trim();
	if (/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+|#\d+|T\d+(·\d+)?)$/.test(ref)) {
		return { issue: ref, prompt: rest.join('\n').trim() };
	}
	return { prompt: text.trim() };
}

/** The form's words, already translated. */
export interface TemplateFormStrings {
	readonly formTitle: string;
	readonly intro: string;
	readonly start: string;
	readonly cancel: string;
	readonly type: string;
	readonly coding: string; readonly codingDetail: string;
	readonly audit: string; readonly auditDetail: string;
	readonly review: string; readonly reviewDetail: string;
	readonly first: string; readonly second: string;
	readonly sameAgent: string;
	readonly reviewPrompt: string; readonly reviewSource: string; readonly reviewSourceHint: string;
	readonly reviewer: string; readonly firstReviews: string; readonly secondReviews: string;
	readonly strict: string; readonly strictAll: string; readonly strictMajor: string; readonly strictCritical: string;
	readonly base: string; readonly noRepo: string;
	readonly brief: string; readonly briefHint: string;
	readonly coordinator: string; readonly firstCoordinates: string; readonly secondCoordinates: string;
	readonly plan: string; readonly planNone: string; readonly planApprove: string;
	readonly codeTest: string; readonly testHint: string;
	readonly verify: string; readonly verifyYes: string; readonly verifyNo: string;
	readonly auditors: string; readonly auditorsBoth: string; readonly auditorsFirst: string; readonly auditorsSecond: string;
	readonly lead: string; readonly leadFirst: string; readonly leadSecond: string;
	readonly since: string; readonly sinceHint: string;
	readonly focus: string;
	readonly goal: string; readonly goalDoc: string; readonly goalApprove: string; readonly goalP0: string; readonly goalP1: string; readonly goalP2: string; readonly goalP3: string;
	readonly auditTest: string;
	/** Titles of the new room: `{0}` is the brief's first line, the scope or the base branch. */
	readonly reviewTitle: string; readonly codingTitle: string; readonly auditTitle: string; readonly sinceTitle: string;
}

export interface TemplateContext {
	/** The ready agents (at least two). */
	readonly agents: readonly Member[];
	/** The agents of the thread used last: the first two come chosen. */
	readonly preset?: readonly string[];
	/** From a project view: the type and the task's link as the brief. */
	readonly task?: { readonly type?: TemplateType; readonly brief?: string };
	/** The workspace's git repository and its current branch; coding and audit need one. */
	readonly repo?: string;
	readonly branch?: string;
}

const fill = (text: string, value: string) => text.replace('{0}', value);

/** The whole form: every type's fields, each shown only for its type (and for its choices). */
export function templateFormSpec(ctx: TemplateContext, t: TemplateFormStrings): FormSpec {
	const agents = ctx.agents.map(a => ({ value: a.id, label: a.name }));
	const first = ctx.preset?.[0] && ctx.agents.some(a => a.id === ctx.preset![0]) ? ctx.preset[0] : ctx.agents[0]?.id;
	const second = ctx.preset?.[1] && ctx.preset[1] !== first && ctx.agents.some(a => a.id === ctx.preset![1]) ? ctx.preset[1] : ctx.agents.find(a => a.id !== first)?.id;
	const review = { field: 'type', in: ['review'] };
	const code = { field: 'type', in: ['coding'] };
	const audit = { field: 'type', in: ['audit'] };
	const repo = { field: 'type', in: ['coding', 'audit'] };
	const brief = ctx.task?.brief ?? '';
	return {
		id: 'template',
		title: t.formTitle,
		intro: t.intro,
		submit: t.start,
		cancel: t.cancel,
		fields: [
			{
				kind: 'choice', id: 'type', label: t.type, value: ctx.task?.type ?? 'coding', options: [
					{ value: 'coding', label: t.coding, detail: t.codingDetail },
					{ value: 'audit', label: t.audit, detail: t.auditDetail },
					{ value: 'review', label: t.review, detail: t.reviewDetail },
				],
			},
			{ kind: 'choice', id: 'first', label: t.first, style: 'select', options: agents, ...(first ? { value: first } : {}) },
			{ kind: 'choice', id: 'second', label: t.second, style: 'select', options: agents, ...(second ? { value: second } : {}) },
			// Brief check
			{ kind: 'textarea', id: 'reviewPrompt', label: t.reviewPrompt, when: review },
			{ kind: 'text', id: 'reviewSource', label: t.reviewSource, hint: t.reviewSourceHint, value: brief, optional: true, when: review },
			{ kind: 'choice', id: 'reviewer', label: t.reviewer, when: review, options: [{ value: 'A', label: t.firstReviews }, { value: 'B', label: t.secondReviews }] },
			{ kind: 'choice', id: 'strict', label: t.strict, when: review, options: [{ value: 'all', label: t.strictAll }, { value: 'major', label: t.strictMajor }, { value: 'critical', label: t.strictCritical }] },
			// Coding and audit work in the workspace's repository.
			...(ctx.repo
				? [{ kind: 'text' as const, id: 'base', label: t.base, value: ctx.branch || 'main', when: repo }]
				: [{ kind: 'note' as const, id: 'noRepo', label: t.noRepo, when: repo }]),
			{ kind: 'textarea', id: 'brief', label: t.brief, hint: t.briefHint, value: brief, when: code },
			{ kind: 'choice', id: 'coordinator', label: t.coordinator, when: code, options: [{ value: 'A', label: t.firstCoordinates }, { value: 'B', label: t.secondCoordinates }] },
			{ kind: 'choice', id: 'plan', label: t.plan, when: code, options: [{ value: 'none', label: t.planNone }, { value: 'approve', label: t.planApprove }] },
			{ kind: 'text', id: 'codeTest', label: t.codeTest, hint: t.testHint, optional: true, when: code },
			{ kind: 'choice', id: 'verify', label: t.verify, when: code, options: [{ value: 'yes', label: t.verifyYes }, { value: 'no', label: t.verifyNo }] },
			{ kind: 'choice', id: 'auditors', label: t.auditors, when: audit, options: [{ value: 'both', label: t.auditorsBoth }, { value: 'A', label: t.auditorsFirst }, { value: 'B', label: t.auditorsSecond }] },
			{ kind: 'choice', id: 'lead', label: t.lead, when: { field: 'auditors', in: ['both'] }, options: [{ value: 'A', label: t.leadFirst }, { value: 'B', label: t.leadSecond }] },
			{ kind: 'text', id: 'since', label: t.since, hint: t.sinceHint, optional: true, when: audit },
			{ kind: 'text', id: 'focus', label: t.focus, value: brief, optional: true, when: audit },
			{
				kind: 'choice', id: 'goal', label: t.goal, when: audit, options: [
					{ value: 'doc', label: t.goalDoc }, { value: 'approve', label: t.goalApprove },
					{ value: 'P0', label: t.goalP0 }, { value: 'P1', label: t.goalP1 }, { value: 'P2', label: t.goalP2 }, { value: 'P3', label: t.goalP3 },
				],
			},
			{ kind: 'text', id: 'auditTest', label: t.auditTest, hint: t.testHint, optional: true, when: { field: 'goal', in: ['approve', 'P0', 'P1', 'P2', 'P3'] } },
		],
	};
}

/** The room asked for, from the form's checked values (readForm), or what is wrong and where. */
export function templateRequest(values: Readonly<Record<string, string>>, ctx: TemplateContext, t: TemplateFormStrings): TemplateRequest | { readonly field: string; readonly message: string } {
	const member = (id: string) => ctx.agents.find(a => a.id === id);
	const a = member(values.first ?? '');
	const b = member(values.second ?? '');
	if (!a || !b) {
		return { field: a ? 'second' : 'first', message: t.sameAgent };
	}
	if (a.id === b.id) {
		return { field: 'second', message: t.sameAgent };
	}
	const members: Record<Role, Member> = { A: { id: a.id, name: a.name }, B: { id: b.id, name: b.name } };
	const role = (v: string | undefined): Role => v === 'B' ? 'B' : 'A';
	const line = (text: string) => text.split('\n')[0].slice(0, 50);
	const type: TemplateType = values.type === 'review' || values.type === 'audit' ? values.type : 'coding';
	if (type === 'review') {
		const prompt = values.reviewPrompt ?? '';
		const source = values.reviewSource ?? '';
		const strict = values.strict === 'major' || values.strict === 'critical' ? values.strict : 'all';
		return { type, members, title: fill(t.reviewTitle, line(prompt)), max: DEFAULT_MAX.review, review: { reviewer: role(values.reviewer), prompt, ...(source ? { source } : {}), strict } };
	}
	if (!ctx.repo) {
		return { field: 'noRepo', message: t.noRepo };
	}
	const base = values.base || ctx.branch || 'main';
	if (type === 'coding') {
		const brief = values.brief ?? '';
		const ref = briefReference(brief);
		const test = values.codeTest ?? '';
		return {
			type, members, title: fill(t.codingTitle, line(brief)), max: DEFAULT_MAX.coding,
			code: { repo: ctx.repo, base, coordinator: role(values.coordinator), prompt: ref.prompt, ...(ref.issue ? { issue: ref.issue } : {}), plan: values.plan === 'approve' ? 'approve' : 'none', ...(test ? { test } : {}), verify: values.verify !== 'no' },
		};
	}
	const auditors: 'both' | Role = values.auditors === 'A' || values.auditors === 'B' ? values.auditors : 'both';
	const lead = auditors === 'both' ? role(values.lead) : auditors;
	const since = values.since ?? '';
	const focus = values.focus ?? '';
	const goal: Pick<AuditState, 'goal' | 'fix' | 'levels'> = values.goal === 'approve' ? { goal: 'fix', fix: 'approve' }
		: values.goal === 'P0' || values.goal === 'P1' || values.goal === 'P2' || values.goal === 'P3' ? { goal: 'fix', fix: 'auto', levels: values.goal }
			: { goal: 'doc' };
	const test = goal.goal === 'fix' ? values.auditTest ?? '' : '';
	return {
		type, members, title: fill(t.auditTitle, since ? fill(t.sinceTitle, since) : base), max: DEFAULT_MAX.audit,
		code: { repo: ctx.repo, base, coordinator: lead, prompt: '', plan: 'none', verify: true, ...(test ? { test } : {}) },
		audit: { auditors, lead, ...(since ? { since } : {}), ...(focus ? { focus } : {}), ...goal },
	};
}

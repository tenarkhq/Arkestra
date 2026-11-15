/*---------------------------------------------------------------------------------------------
 *  Arkestra. A sample project for the Boards page's tests: a Status and a Line field, two lines.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */

export const sampleSnapshot = (over: Record<string, unknown> = {}): any => ({
	id: 'P1', owner: 'TenarkHQ', number: 3, title: 'Arkestra', url: 'https://github.com/orgs/TenarkHQ/projects/3', fetchedAt: 1_700_000_000_000,
	fields: [
		{ id: 'S', name: 'Status', type: 'single_select', options: [{ id: 'r', name: 'Ready' }, { id: 'p', name: 'In progress' }, { id: 'd', name: 'Done' }] },
		{ id: 'L', name: 'Line', type: 'single_select', options: [{ id: 'l9', name: '0.9' }, { id: 'l10', name: '1.0' }] },
	],
	items: [
		{ id: 'a', type: 'issue', title: 'A', state: 'CLOSED', labels: [], assignees: [], fields: { S: { kind: 'option', optionId: 'd', name: 'Done' }, L: { kind: 'option', optionId: 'l9', name: '0.9' } }, blockedBy: [], pullRequests: [] },
		{ id: 'b', type: 'issue', title: 'B', state: 'CLOSED', labels: [], assignees: [], fields: { S: { kind: 'option', optionId: 'd', name: 'Done' }, L: { kind: 'option', optionId: 'l9', name: '0.9' } }, blockedBy: [], pullRequests: [] },
		{ id: 'c', type: 'issue', title: 'C', state: 'OPEN', labels: [], assignees: [], fields: { S: { kind: 'option', optionId: 'r', name: 'Ready' }, L: { kind: 'option', optionId: 'l10', name: '1.0' } }, blockedBy: [], pullRequests: [] },
		{ id: 'e', type: 'issue', title: 'E', state: 'OPEN', labels: [], assignees: [], fields: { S: { kind: 'option', optionId: 'd', name: 'Done' }, L: { kind: 'option', optionId: 'l10', name: '1.0' } }, blockedBy: [], pullRequests: [] },
	],
	...over,
});

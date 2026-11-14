/*---------------------------------------------------------------------------------------------
 *  Arkestra. A small GitHub GraphQL client (AR29): one POST per call; GitHub's errors become
 *  one readable message. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

import type { GraphQL } from './sync';

export function graphqlClient(token: () => Promise<string | undefined>, options: { endpoint?: string; fetch?: typeof fetch } = {}): GraphQL {
	return async (query, variables) => {
		const t = await token();
		if (!t) {
			throw new Error('not signed in to GitHub');
		}
		const res = await (options.fetch ?? fetch)(options.endpoint ?? 'https://api.github.com/graphql', {
			method: 'POST',
			headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/vnd.github+json', 'user-agent': 'Arkestra' },
			body: JSON.stringify({ query, variables: variables ?? {} }),
		});
		let body: any;
		try {
			body = await res.json();
		} catch {
			body = undefined;
		}
		if (!res.ok) {
			const retry = res.headers?.get?.('retry-after');
			throw new Error(`GitHub answered ${res.status}${body?.message ? `: ${body.message}` : ''}${retry ? ` (retry in ${retry} s)` : ''}`);
		}
		if (Array.isArray(body?.errors) && body.errors.length) {
			throw new Error(body.errors.map((e: any) => e?.message ?? String(e)).join('; '));
		}
		return body?.data;
	};
}

/*---------------------------------------------------------------------------------------------
 *  Arkestra. GPT in a room through the OpenAI Responses API with the user's own key.
 *  A talking agent: it reads the thread and answers; it has no workspace tools.
 *  Nothing is stored at OpenAI (store: false); each turn sends the thread.
 *--------------------------------------------------------------------------------------------*/

import type { Agent, AgentEvent, Message, Readiness, TurnInput } from './rooms';

export interface OpenAIOptions {
	readonly model: string;
	/** `https://api.openai.com/v1` unless configured. */
	readonly baseUrl: string;
	readonly reasoningEffort?: 'low' | 'medium' | 'high';
	readonly apiKey: () => Promise<string | undefined>;
	readonly fetch?: typeof fetch;
}

export const ROOM_INSTRUCTIONS = 'You are GPT in an Arkestra room: a thread shared by the user and other AI agents. '
	+ 'Messages are labelled by author. Answer the latest user request, take the other agents\' messages into account, '
	+ 'and do not repeat what they already did. You cannot run tools or change files; the coding agents in the room can.';

/** The thread as Responses API input: GPT's own messages as assistant turns, everyone else labelled. */
export function toInput(messages: readonly Message[], selfId: string): { role: 'user' | 'assistant'; content: string }[] {
	return messages.filter(m => !m.to || m.to.includes(selfId)).map(m => m.author.kind === 'agent' && m.author.id === selfId
		? { role: 'assistant', content: m.text }
		: {
			role: 'user', content: m.author.kind === 'user' ? `[${m.author.name}]\n${m.text}`
				: m.author.kind === 'system' ? `[room] ${m.text}`
					: `[${m.author.name} (agent)]\n${m.text}`
		});
}

/** One server-sent event's data, as the turn reads it. */
export function parseEvent(data: any): { text?: string; error?: string; done?: boolean } {
	switch (data?.type) {
		case 'response.output_text.delta':
			return typeof data.delta === 'string' ? { text: data.delta } : {};
		case 'response.completed':
			return { done: true };
		case 'response.incomplete':
			return { done: true, error: `Answer cut short: ${data.response?.incomplete_details?.reason ?? 'incomplete'}` };
		case 'response.failed':
			return { done: true, error: data.response?.error?.message ?? 'OpenAI response failed' };
		case 'error':
			return { done: true, error: data.message ?? data.error?.message ?? 'OpenAI error' };
		default:
			return {};
	}
}

export class OpenAIAgent implements Agent {
	readonly id = 'gpt';
	readonly name = 'GPT';

	constructor(private readonly options: OpenAIOptions) { }

	get detail(): string {
		return `OpenAI API · ${this.options.model}`;
	}

	async readiness(): Promise<Readiness> {
		const key = await this.options.apiKey();
		if (!key) {
			return { ready: false, reason: 'No OpenAI API key stored', fix: 'signIn' };
		}
		try {
			// Checks the key and the model without spending tokens.
			const res = await this.http(`/models/${encodeURIComponent(this.options.model)}`, key, { method: 'GET' }, AbortSignal.timeout(10_000));
			if (res.ok) {
				return { ready: true };
			}
			if (res.status === 401) {
				return { ready: false, reason: 'OpenAI API key rejected', fix: 'signIn' };
			}
			if (res.status === 404) {
				return { ready: false, reason: `Model ${this.options.model} is not available to this key`, fix: 'retry' };
			}
			return { ready: false, reason: await errorText(res), fix: res.status === 429 ? 'quota' : 'retry' };
		} catch (e) {
			return { ready: false, reason: e instanceof Error ? e.message : String(e), fix: 'retry' };
		}
	}

	async turn(input: TurnInput, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
		const key = await this.options.apiKey();
		if (!key) {
			throw new Error('No OpenAI API key stored');
		}
		const body = {
			model: this.options.model,
			instructions: input.shared ? `${ROOM_INSTRUCTIONS}\n\n${input.shared.text}` : ROOM_INSTRUCTIONS,
			input: toInput(input.transcript, this.id),
			stream: true,
			store: false,
			...(this.options.reasoningEffort ? { reasoning: { effort: this.options.reasoningEffort } } : {}),
		};
		let res: Response;
		try {
			res = await this.http('/responses', key, { method: 'POST', body: JSON.stringify(body) }, signal);
		} catch (e) {
			if (signal.aborted) {
				return;
			}
			throw e;
		}
		if (!res.ok || !res.body) {
			throw new Error(await errorText(res));
		}

		const decoder = new TextDecoder();
		let buffer = '';
		let failure: string | undefined;
		let done = false;
		const handleBlock = (block: string) => {
			const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
			if (!data || data === '[DONE]') {
				return;
			}
			let parsed;
			try {
				parsed = parseEvent(JSON.parse(data));
			} catch {
				return;
			}
			if (parsed.text) {
				onEvent({ kind: 'text', text: parsed.text });
			}
			failure = parsed.error ?? failure;
			done ||= !!parsed.done;
		};
		try {
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
				let end: number;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					handleBlock(buffer.slice(0, end));
					buffer = buffer.slice(end + 2);
				}
			}
			if (buffer.trim()) {
				handleBlock(buffer);
			}
		} catch (e) {
			if (signal.aborted) {
				return;
			}
			throw e;
		}
		if (failure) {
			throw new Error(failure);
		}
		if (!done && !signal.aborted) {
			throw new Error('OpenAI stream ended early');
		}
	}

	private http(path: string, key: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
		return (this.options.fetch ?? fetch)(this.options.baseUrl.replace(/\/+$/, '') + path, {
			...init,
			signal,
			headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
		});
	}
}

async function errorText(res: Response): Promise<string> {
	const raw = await res.text().catch(() => '');
	try {
		const message = JSON.parse(raw)?.error?.message;
		if (typeof message === 'string' && message) {
			return message;
		}
	} catch { /* not JSON */ }
	return `OpenAI API ${res.status}${raw ? ': ' + raw.slice(0, 200) : ''}`;
}

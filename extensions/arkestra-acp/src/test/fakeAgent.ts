/*---------------------------------------------------------------------------------------------
 *  Arkestra. A small ACP agent for the tests. It logs every prompt to FAKE_LOG, and each
 *  prompt reads FAKE_FILE, runs a command in a terminal, asks for permission and answers
 *  with all three. FAKE_AUTH=1: sessions need `authenticate` first. "WAIT" in a prompt:
 *  the turn runs until cancelled.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync } from 'node:fs';
import * as readline from 'node:readline';

let nextId = 1000;
const pending = new Map<number, (result: any) => void>();
let authenticated = process.env.FAKE_AUTH !== '1';
let cancel: (() => void) | undefined;
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const call = (method: string, params: object) => new Promise<any>(resolve => {
	const id = nextId++;
	pending.set(id, resolve);
	send({ id, method, params });
});
const update = (sessionId: string, u: object) => send({ method: 'session/update', params: { sessionId, update: u } });
const log = (line: string) => { if (process.env.FAKE_LOG) { appendFileSync(process.env.FAKE_LOG, line + '\n'); } };

async function prompt(id: number, p: any) {
	const text: string = p.prompt.map((b: any) => b.text).join('');
	log(`prompt ${p.sessionId}: ${JSON.stringify(text)}`);
	if (text.includes('WAIT')) {
		await new Promise<void>(resolve => { cancel = resolve; });
		send({ id, result: { stopReason: 'cancelled' } });
		return;
	}
	update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hel' } });
	update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'lo' } });
	const file = await call('fs/read_text_file', { sessionId: p.sessionId, path: process.env.FAKE_FILE, line: 2, limit: 1 });
	update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run echo', kind: 'execute', status: 'pending' });
	const term = await call('terminal/create', { sessionId: p.sessionId, command: 'sh', args: ['-c', 'echo "out:$FAKE_VAR"'], env: [{ name: 'FAKE_VAR', value: 'v1' }] });
	const exit = await call('terminal/wait_for_exit', { sessionId: p.sessionId, terminalId: term.result.terminalId });
	const output = await call('terminal/output', { sessionId: p.sessionId, terminalId: term.result.terminalId });
	await call('terminal/release', { sessionId: p.sessionId, terminalId: term.result.terminalId });
	await call('fs/write_text_file', { sessionId: p.sessionId, path: `${process.env.FAKE_FILE}.out/new.txt`, content: 'written' });
	const permission = await call('session/request_permission', {
		sessionId: p.sessionId,
		toolCall: { toolCallId: 't2', title: 'Edit state.py' },
		options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }, { optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
	});
	update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Run echo', status: 'failed' });
	update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: `file=${file.result.content} exit=${exit.result.exitCode} ${output.result.output.trim()} permission=${permission.result.outcome.optionId ?? permission.result.outcome.outcome}` } });
	send({ id, result: { stopReason: 'end_turn' } });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
	const m = JSON.parse(line);
	if (m.id !== undefined && m.method === undefined) {
		pending.get(m.id)?.(m);
		pending.delete(m.id);
		return;
	}
	switch (m.method) {
		case 'initialize':
			send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'key', name: 'API key' }, { id: 'tui', name: 'Terminal', type: 'terminal' }], agentInfo: { name: 'fake' } } });
			break;
		case 'authenticate':
			authenticated = m.params.methodId === 'key';
			send(authenticated ? { id: m.id, result: {} } : { id: m.id, error: { code: -32602, message: 'bad method' } });
			break;
		case 'session/new':
			log(`new ${m.params.cwd}`);
			send(authenticated ? { id: m.id, result: { sessionId: `s${nextId++}` } } : { id: m.id, error: { code: -32000, message: 'Authentication required' } });
			break;
		case 'session/load':
			log(`load ${m.params.sessionId}`);
			update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } });
			send({ id: m.id, result: {} });
			break;
		case 'session/prompt':
			void prompt(m.id, m.params);
			break;
		case 'session/cancel':
			cancel?.();
			break;
		default:
			if (m.id !== undefined) {
				send({ id: m.id, error: { code: -32601, message: 'no' } });
			}
	}
});

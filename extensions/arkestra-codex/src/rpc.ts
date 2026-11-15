/*---------------------------------------------------------------------------------------------
 *  Arkestra. Line-delimited JSON-RPC to `codex app-server` over stdio.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';

export interface Notification {
	readonly method: string;
	readonly params: any;
}

export class RpcError extends Error {
	constructor(readonly code: number | undefined, message: string) {
		super(message);
	}
}

/** Requests, responses and notifications of one app-server process. */
export class RpcClient {
	private nextId = 0;
	private buffer = '';
	private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private readonly listeners = new Set<(n: Notification) => void>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private requestHandler?: (method: string, params: any) => Promise<unknown> | undefined;
	private closedWith: Error | undefined;
	stderr = '';

	constructor(private readonly child: ChildProcess) {
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			this.buffer += chunk;
			let nl: number;
			while ((nl = this.buffer.indexOf('\n')) >= 0) {
				this.handle(this.buffer.slice(0, nl));
				this.buffer = this.buffer.slice(nl + 1);
			}
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
		const close = (error: Error) => {
			this.closedWith ??= error;
			for (const p of this.pending.values()) {
				p.reject(this.closedWith);
			}
			this.pending.clear();
			for (const listener of [...this.closeListeners]) {
				listener(this.closedWith);
			}
			this.closeListeners.clear();
		};
		child.stdin?.on('error', () => { }); // EPIPE after the process died; 'close' reports it
		child.on('error', close);
		// The exit code goes with it: 127 from an SSH machine's shell means no Codex there.
		child.on('close', code => close(Object.assign(new Error(this.lastStderrLine() || `codex app-server exited with ${code}`), { exitCode: code })));
	}

	get closed(): boolean {
		return this.closedWith !== undefined;
	}

	request<T = any>(method: string, params: unknown): Promise<T> {
		if (this.closedWith) {
			return Promise.reject(this.closedWith);
		}
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		this.write(params === undefined ? { method } : { method, params });
	}

	onNotification(listener: (n: Notification) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Answers the server's requests (approvals); one that returns undefined is refused. */
	onRequest(handler: (method: string, params: any) => Promise<unknown> | undefined): void {
		this.requestHandler = handler;
	}

	/** Called once when the process ends, with its last stderr line or exit code. */
	onClose(listener: (error: Error) => void): { dispose(): void } {
		this.closeListeners.add(listener);
		return { dispose: () => this.closeListeners.delete(listener) };
	}

	dispose(): void {
		this.child.kill('SIGTERM');
	}

	private write(message: object): void {
		this.child.stdin?.write(JSON.stringify(message) + '\n');
	}

	private handle(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.id !== undefined && message.method === undefined) {
			const p = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) {
				p?.reject(new RpcError(message.error.code, message.error.message ?? 'app-server error'));
			} else {
				p?.resolve(message.result);
			}
		} else if (message.id !== undefined) {
			// A server request (approval, user input): answered by the handler, or refused, never left hanging.
			const answer = this.requestHandler?.(message.method, message.params);
			if (!answer) {
				this.write({ id: message.id, error: { code: -32601, message: 'Arkestra does not handle this request' } });
				return;
			}
			answer.then(
				result => this.write({ id: message.id, result }),
				error => this.write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
			);
		} else if (typeof message.method === 'string') {
			for (const listener of [...this.listeners]) {
				listener({ method: message.method, params: message.params });
			}
		}
	}

	private lastStderrLine(): string | undefined {
		// Drop ANSI colours; the last line is the useful one.
		return this.stderr.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').at(-1) || undefined;
	}
}

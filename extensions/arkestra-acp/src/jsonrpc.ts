/*---------------------------------------------------------------------------------------------
 *  Arkestra. Line-delimited JSON-RPC 2.0 over a child process's stdio, both ways: ACP agents
 *  call the client too (files, terminals, permission).
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';

export interface Notification {
	readonly method: string;
	readonly params: any;
}

export class RpcError extends Error {
	constructor(readonly code: number | undefined, message: string, readonly data?: unknown) {
		super(message);
	}
}

/** JSON-RPC error codes ACP uses. */
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
export const AUTH_REQUIRED = -32000;
export const RESOURCE_NOT_FOUND = -32002;

export type RequestHandler = (params: any) => Promise<unknown> | unknown;

export class JsonRpcPeer {
	private nextId = 0;
	private buffer = '';
	private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private readonly listeners = new Set<(n: Notification) => void>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private readonly handlers = new Map<string, RequestHandler>();
	private closedWith: Error | undefined;
	stderr = '';

	constructor(private readonly child: ChildProcess, private readonly label: string) {
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
		child.on('close', code => close(new Error(this.lastStderrLine() || `${label} exited with ${code}`)));
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
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
	}

	/** Serves one method the other side calls; unknown methods are answered "method not found". */
	serve(method: string, handler: RequestHandler): void {
		this.handlers.set(method, handler);
	}

	onNotification(listener: (n: Notification) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	onClose(listener: (error: Error) => void): { dispose(): void } {
		this.closeListeners.add(listener);
		return { dispose: () => this.closeListeners.delete(listener) };
	}

	dispose(): void {
		this.child.stdin?.end();
		this.child.kill('SIGTERM');
	}

	private write(message: object): void {
		if (!this.closedWith) {
			this.child.stdin?.write(JSON.stringify(message) + '\n');
		}
	}

	private handle(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return; // agents may print non-protocol lines; they are not ours
		}
		if (message.id !== undefined && message.method === undefined) {
			const p = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) {
				p?.reject(new RpcError(message.error.code, message.error.message ?? `${this.label} error`, message.error.data));
			} else {
				p?.resolve(message.result);
			}
		} else if (message.id !== undefined && typeof message.method === 'string') {
			const handler = this.handlers.get(message.method);
			if (!handler) {
				this.write({ jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${message.method}` } });
				return;
			}
			Promise.resolve()
				.then(() => handler(message.params))
				.then(
					result => this.write({ jsonrpc: '2.0', id: message.id, result: result ?? null }),
					error => this.write({ jsonrpc: '2.0', id: message.id, error: { code: error instanceof RpcError && error.code !== undefined ? error.code : INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } }),
				);
		} else if (typeof message.method === 'string') {
			for (const listener of [...this.listeners]) {
				listener({ method: message.method, params: message.params });
			}
		}
	}

	private lastStderrLine(): string | undefined {
		return this.stderr.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').at(-1) || undefined;
	}
}

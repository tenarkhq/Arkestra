/*---------------------------------------------------------------------------------------------
 *  Arkestra. Whether each Codex thread on a machine works now, live: its rollout file is written
 *  the moment its Codex does something, and it marks each turn's start (`task_started`) and end
 *  (`task_complete`, `turn_aborted`), wherever the thread runs (the Codex app, a terminal,
 *  Arkestra). The left bar's dots follow these.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface LiveState {
	/** The thread's id (the end of its rollout file's name). */
	readonly id: string;
	/** `run`: its Codex works on a turn; `idle`: the turn ended (or nothing was written for a long time). */
	readonly state: 'run' | 'idle';
	/** Epoch seconds of the file's last write. */
	readonly at: number;
	/** While it runs: its latest step (the command it ran, the files it edited); Codex writes the running one only when it ends. */
	readonly doing?: string;
}

/** A turn that wrote nothing for this long is taken for ended (stopped, the app closed); Codex's long commands write nothing meanwhile. */
export const STALE_S = 1800;
const TAIL = 262144;
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** The thread id in a rollout file's name; undefined for any other file. */
export function threadOfFile(name: string): string | undefined {
	return ROLLOUT.exec(path.basename(name))?.[1];
}

/** The state the end of a rollout file tells: the latest turn mark decides; a turn whose start fell off the read end still runs. */
export function stateOfTail(text: string): 'run' | 'idle' | undefined {
	const lines = text.split('\n');
	let any = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].includes('"event_msg"')) {
			any ||= lines[i].includes('"response_item"');
			continue;
		}
		let d: any;
		try {
			d = JSON.parse(lines[i]);
		} catch {
			continue; // the first, cut line, or one being written
		}
		const kind = d?.type === 'event_msg' ? d.payload?.type : undefined;
		if (kind === 'task_complete' || kind === 'turn_aborted') {
			return 'idle';
		}
		if (kind === 'task_started') {
			return 'run';
		}
		any = true;
	}
	return any ? 'run' : undefined;
}

/** A running turn's latest finished step: the command it ran, the files it edited; undefined: none yet in this turn. */
export function doingOfTail(text: string): string | undefined {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].includes('"item_completed"') && !lines[i].includes('"task_started"')) {
			continue;
		}
		let d: any;
		try {
			d = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const p = d?.type === 'event_msg' ? d.payload : undefined;
		if (p?.type === 'task_started') {
			return undefined;
		}
		const label = p?.type === 'item_completed' ? itemDoing(p.item) : undefined;
		if (label) {
			return label;
		}
	}
	return undefined;
}

function itemDoing(item: any): string | undefined {
	if (item?.type === 'CommandExecution') {
		const parts = Array.isArray(item.command) ? item.command.map(String) : [String(item.command ?? '')];
		const cmd = (parts.length >= 3 && /sh$/.test(parts[0]) && /^-l?c$/.test(parts[1]) ? parts.slice(2).join(' ') : parts.join(' ')).replace(/\s+/g, ' ').trim();
		return cmd ? `Ran ${cmd.length > 80 ? `${cmd.slice(0, 79)}…` : cmd}` : 'Ran a command';
	}
	if (item?.type === 'FileChange') {
		const files = Object.keys(item.changes ?? {}).map(f => f.split('/').pop());
		return files.length ? `Edited ${files.slice(0, 2).join(', ')}${files.length > 2 ? ` and ${files.length - 2} more` : ''}` : 'Edited files';
	}
	return undefined;
}

/** The state as shown: a run that wrote nothing for a long time ended. */
export function shownState(state: 'run' | 'idle', at: number, now: number): 'run' | 'idle' {
	return state === 'run' && now - at > STALE_S ? 'idle' : state;
}

/**
 * The watch on a POSIX machine, in Python (there on every Linux server): one JSON line for each
 * thread whose state changes. The files written in the last day are looked at every second, the
 * homes are searched again every 20 s for files that started to be written. Without Python it
 * ends at once and nothing is told.
 */
const PYTHON = String.raw`
import os,sys,json,time,glob
homes=[os.path.expanduser(h) for h in sys.argv[1:]]
STALE=${STALE_S}
shown={};seen={}
def item_doing(it):
  t=it.get('type')
  if t=='CommandExecution':
    c=it.get('command');parts=[str(x) for x in c] if isinstance(c,list) else [str(c or '')]
    cmd=' '.join(parts[2:] if len(parts)>=3 and parts[0].endswith('sh') and parts[1] in ('-c','-lc') else parts)
    cmd=' '.join(cmd.split())
    return ('Ran '+(cmd[:79]+'\u2026' if len(cmd)>80 else cmd)) if cmd else 'Ran a command'
  if t=='FileChange':
    fs=[k.split('/')[-1] for k in (it.get('changes') or {})]
    return ('Edited '+', '.join(fs[:2])+(' and %d more'%(len(fs)-2) if len(fs)>2 else '')) if fs else 'Edited files'
  return None
def state(p):
  try:
    with open(p,'rb') as f:
      f.seek(0,2);n=f.tell();f.seek(max(0,n-${TAIL}));lines=f.read().splitlines()
  except Exception:
    return None,None
  s=None;doing=None;anyl=False
  for raw in reversed(lines):
    if b'"event_msg"' not in raw:
      anyl=anyl or b'"response_item"' in raw
      continue
    try:d=json.loads(raw)
    except Exception:continue
    pl=d.get('payload') or {};k=pl.get('type')
    if s is None:
      if k in ('task_complete','turn_aborted'):return 'idle',None
      if k=='task_started':return 'run',doing
      anyl=True
    if k=='task_started':break
    if doing is None and k=='item_completed':
      doing=item_doing(pl.get('item') or {})
  return ('run',doing) if anyl else (None,None)
def tell(p,m):
  s,doing=state(p)
  if s is None:return
  if s=='run' and time.time()-m>STALE:s='idle'
  if s!='run':doing=None
  if shown.get(p)!=(s,doing):
    shown[p]=(s,doing)
    name=os.path.basename(p)[:-6]
    o={'id':name[-36:],'state':s,'at':m}
    if doing:o['doing']=doing
    print(json.dumps(o),flush=True)
def search(since):
  for h in homes:
    for p in glob.glob(h+'/sessions/*/*/*/rollout-*.jsonl'):
      if p in seen:continue
      try:m=os.stat(p).st_mtime
      except Exception:continue
      if m>=since:
        seen[p]=m;tell(p,m)
search(time.time()-86400)
print(json.dumps({'ready':True}),flush=True)
last=time.time()
while True:
  time.sleep(1)
  for p,old in list(seen.items()):
    try:m=os.stat(p).st_mtime
    except Exception:
      seen.pop(p,None);continue
    if m!=old:
      seen[p]=m;tell(p,m)
    elif (shown.get(p) or ('',))[0]=='run' and time.time()-m>STALE:tell(p,m)
  if time.time()-last>20:
    search(last-5);last=time.time()
`;

/** The watch's command line for an SSH machine; the homes as the CLI names them (`~/.codex`). */
export function watchScript(homes: readonly string[]): string {
	const args = homes.map(h => `'${h.replace(/'/g, `'"'"'`)}'`).join(' ');
	return `command -v python3 >/dev/null 2>&1 || exit 0\nexec python3 -u -c '${PYTHON.replace(/'/g, `'"'"'`)}' ${args}`;
}

/** One line of the watch's output; undefined for anything else. */
export function liveLine(line: string): LiveState | 'ready' | undefined {
	try {
		const d = JSON.parse(line);
		if (d?.ready === true) {
			return 'ready';
		}
		return typeof d?.id === 'string' && (d.state === 'run' || d.state === 'idle') && typeof d.at === 'number' ? { id: d.id, state: d.state, at: d.at, ...(typeof d.doing === 'string' && d.doing ? { doing: d.doing } : {}) } : undefined;
	} catch {
		return undefined;
	}
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** The watch on an SSH machine: started again a while after it ends (a dropped connection). */
export function watchRemote(spawn: Spawn, homes: readonly string[], onState: (s: LiveState) => void): { dispose(): void } {
	let child: ChildProcess | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const start = () => {
		if (disposed) {
			return;
		}
		let buffer = '';
		let ready = false;
		child = spawn('sh', ['-c', watchScript(homes)], { stdio: ['ignore', 'pipe', 'ignore'] });
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const got = liveLine(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				if (got === 'ready') {
					ready = true;
				} else if (got) {
					onState(got);
				}
			}
		});
		const again = () => {
			child = undefined;
			// No Python there (it ends before it is ready): not asked again for a long while.
			timer = disposed ? undefined : setTimeout(start, ready ? 15_000 : 600_000);
		};
		child.on('error', again);
		child.on('close', again);
	};
	start();
	return { dispose: () => { disposed = true; clearTimeout(timer); child?.kill(); } };
}

/** The watch on this computer: the files written in the last day looked at every second, the homes searched again every 20 s. */
export function watchLocal(homes: readonly string[], onState: (s: LiveState) => void, now: () => number = () => Date.now() / 1000): { dispose(): void } {
	const seen = new Map<string, number>();
	const shown = new Map<string, string>();
	const tell = async (file: string, at: number) => {
		const id = threadOfFile(file);
		if (!id) {
			return;
		}
		try {
			const handle = await fs.open(file, 'r');
			try {
				const size = (await handle.stat()).size;
				const length = Math.min(TAIL, size);
				const buf = Buffer.alloc(length);
				await handle.read(buf, 0, length, size - length);
				const state = stateOfTail(buf.toString('utf8'));
				if (!state) {
					return;
				}
				const s = shownState(state, at, now());
				const doing = s === 'run' ? doingOfTail(buf.toString('utf8')) : undefined;
				if (shown.get(file) !== `${s}\n${doing ?? ''}`) {
					shown.set(file, `${s}\n${doing ?? ''}`);
					onState({ id, state: s, at, ...(doing ? { doing } : {}) });
				}
			} finally {
				await handle.close();
			}
		} catch {
			// gone, or not readable: nothing to tell
		}
	};
	const search = async (since: number) => {
		for (const home of homes) {
			const sessions = path.join(home, 'sessions');
			for (const y of await fs.readdir(sessions).catch(() => [] as string[])) {
				for (const m of await fs.readdir(path.join(sessions, y)).catch(() => [] as string[])) {
					for (const d of await fs.readdir(path.join(sessions, y, m)).catch(() => [] as string[])) {
						const dir = path.join(sessions, y, m, d);
						for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
							const file = path.join(dir, f);
							if (seen.has(file) || !threadOfFile(f)) {
								continue;
							}
							const at = await fs.stat(file).then(s => s.mtimeMs / 1000, () => 0);
							if (at >= since) {
								seen.set(file, at);
								await tell(file, at);
							}
						}
					}
				}
			}
		}
	};
	let busy = false;
	let last = now();
	void search(last - 86400);
	const tick = setInterval(() => {
		if (busy) {
			return;
		}
		busy = true;
		void (async () => {
			for (const [file, old] of seen) {
				const at = await fs.stat(file).then(s => s.mtimeMs / 1000, () => undefined);
				if (at === undefined) {
					seen.delete(file);
				} else if (at !== old) {
					seen.set(file, at);
					await tell(file, at);
				} else if (shown.get(file)?.startsWith('run') && now() - at > STALE_S) {
					await tell(file, at);
				}
			}
			if (now() - last > 20) {
				const from = last - 5;
				last = now();
				await search(from);
			}
		})().finally(() => { busy = false; });
	}, 1000);
	return { dispose: () => clearInterval(tick) };
}

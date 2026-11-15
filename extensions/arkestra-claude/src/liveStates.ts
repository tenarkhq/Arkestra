/*---------------------------------------------------------------------------------------------
 *  Arkestra. Whether each Claude session on a machine works now, live: its session file is
 *  written the moment its Claude does something, so a watch on the files (inotify on a Linux
 *  machine, the system's own watch here) tells it at once, wherever the session runs (the
 *  Claude app, a terminal, Arkestra). The left bar's dots follow these.
 *--------------------------------------------------------------------------------------------*/

import { watch, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface LiveState {
	/** The session's id (its file's name). */
	readonly id: string;
	/** `run`: its Claude works on a turn; `idle`: the turn ended (or nothing was written for a long time). */
	readonly state: 'run' | 'idle';
	/** Epoch seconds of the file's last write. */
	readonly at: number;
}

/** A turn that wrote nothing for this long is taken for ended (stopped, the app closed). */
export const STALE_S = 600;
const TAIL = 65536;

/** The state the end of a session file tells: the latest user or assistant line decides. */
export function stateOfTail(text: string): 'run' | 'idle' | undefined {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		let d: any;
		try {
			d = JSON.parse(lines[i]);
		} catch {
			continue; // the first, cut line, or one being written
		}
		if (d?.type === 'assistant') {
			const stop = d.message?.stop_reason;
			return stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens' || stop === 'refusal' ? 'idle' : 'run';
		}
		if (d?.type === 'user' && !d.isMeta && !d.isCompactSummary && !d.isSidechain) {
			return 'run';
		}
	}
	return undefined;
}

/** The state as shown: a run that wrote nothing for a long time ended. */
export function shownState(state: 'run' | 'idle', at: number, now: number): 'run' | 'idle' {
	return state === 'run' && now - at > STALE_S ? 'idle' : state;
}

/**
 * The watch on a POSIX machine, in Python (there on every Linux server): one JSON line for each
 * session whose state changes, the recent ones first. Linux's inotify where it can, else a look
 * every 2 s. Without Python it ends at once and the account's list stays the source.
 */
const PYTHON = String.raw`
import os,sys,json,time,glob,struct,select
root=os.path.expanduser('~/.claude/projects')
STALE=${STALE_S}
shown={}
def state(p):
  try:
    with open(p,'rb') as f:
      f.seek(0,2);n=f.tell();f.seek(max(0,n-${TAIL}));lines=f.read().splitlines()
  except Exception:
    return None
  for raw in reversed(lines):
    try:d=json.loads(raw)
    except Exception:continue
    t=d.get('type')
    if t=='assistant':
      return 'idle' if (d.get('message') or {}).get('stop_reason') in ('end_turn','stop_sequence','max_tokens','refusal') else 'run'
    if t=='user' and not d.get('isMeta') and not d.get('isCompactSummary') and not d.get('isSidechain'):
      return 'run'
  return None
def tell(p,first=False):
  if not p.endswith('.jsonl'):return
  try:m=os.stat(p).st_mtime
  except Exception:return
  now=time.time()
  if first and now-m>86400:return
  s=state(p)
  if s is None:return
  if s=='run' and now-m>STALE:s='idle'
  if shown.get(p)!=s:
    shown[p]=s
    print(json.dumps({'id':os.path.basename(p)[:-6],'state':s,'at':m}),flush=True)
def sweep(first=False):
  for p in glob.glob(root+'/*/*.jsonl'):tell(p,first)
sweep(True)
print(json.dumps({'ready':True}),flush=True)
try:
  import ctypes,ctypes.util
  libc=ctypes.CDLL(ctypes.util.find_library('c'),use_errno=True)
  fd=libc.inotify_init()
  if fd<0:raise OSError()
  wds={}
  def add(d):
    wd=libc.inotify_add_watch(fd,d.encode(),0x2|0x8|0x80|0x100)
    if wd>=0:wds[wd]=d
  add(root)
  for d in glob.glob(root+'/*/'):add(d.rstrip('/'))
  last=time.time()
  while True:
    r,_,_=select.select([fd],[],[],30)
    if r:
      buf=os.read(fd,65536);i=0;hit=set()
      while i<len(buf):
        wd,mask,cookie,ln=struct.unpack_from('iIII',buf,i);name=buf[i+16:i+16+ln].rstrip(b'\0').decode(errors='replace');i+=16+ln
        base=wds.get(wd)
        if base is None:continue
        if base==root:
          if mask&0x40000000:add(root+'/'+name)
        else:hit.add(base+'/'+name)
      for p in hit:tell(p)
    if time.time()-last>30:
      last=time.time()
      for p,s in list(shown.items()):
        if s=='run':tell(p)
except Exception:
  while True:
    time.sleep(2)
    sweep()
`;

export const WATCH_SCRIPT = `command -v python3 >/dev/null 2>&1 || exit 0\nexec python3 -u -c '${PYTHON.replace(/'/g, `'"'"'`)}'`;

/** One line of the watch's output; undefined for anything else. */
export function liveLine(line: string): LiveState | 'ready' | undefined {
	try {
		const d = JSON.parse(line);
		if (d?.ready === true) {
			return 'ready';
		}
		return typeof d?.id === 'string' && (d.state === 'run' || d.state === 'idle') && typeof d.at === 'number' ? { id: d.id, state: d.state, at: d.at } : undefined;
	} catch {
		return undefined;
	}
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** The watch on an SSH machine: started again a while after it ends (a dropped connection). */
export function watchRemote(spawn: Spawn, onState: (s: LiveState) => void): { dispose(): void } {
	let child: ChildProcess | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const start = () => {
		if (disposed) {
			return;
		}
		let buffer = '';
		let ready = false;
		child = spawn('sh', ['-c', WATCH_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] });
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

/** The watch on this computer, with the system's own file watch. */
export function watchLocal(home: string, onState: (s: LiveState) => void, now: () => number = () => Date.now() / 1000): { dispose(): void } {
	const root = path.join(home, '.claude', 'projects');
	const shown = new Map<string, 'run' | 'idle'>();
	const tell = async (file: string, first = false) => {
		if (!file.endsWith('.jsonl')) {
			return;
		}
		try {
			const stat = await fs.stat(file);
			const at = stat.mtimeMs / 1000;
			if (first && now() - at > 86400) {
				return;
			}
			const handle = await fs.open(file, 'r');
			try {
				const length = Math.min(TAIL, stat.size);
				const buf = Buffer.alloc(length);
				await handle.read(buf, 0, length, stat.size - length);
				const state = stateOfTail(buf.toString('utf8'));
				if (!state) {
					return;
				}
				const s = shownState(state, at, now());
				if (shown.get(file) !== s) {
					shown.set(file, s);
					onState({ id: path.basename(file, '.jsonl'), state: s, at });
				}
			} finally {
				await handle.close();
			}
		} catch {
			// gone, or not readable: nothing to tell
		}
	};
	let watcher: ReturnType<typeof watch> | undefined;
	void (async () => {
		try {
			for (const dir of await fs.readdir(root)) {
				for (const f of await fs.readdir(path.join(root, dir)).catch(() => [] as string[])) {
					await tell(path.join(root, dir, f), true);
				}
			}
			watcher = watch(root, { recursive: true }, (_event, name) => { if (name) { void tell(path.join(root, name.toString())); } });
			watcher.on('error', () => undefined);
		} catch {
			// no sessions on this computer
		}
	})();
	// A run that stopped writing ends after a while.
	const sweep = setInterval(() => { for (const [file, s] of shown) { if (s === 'run') { void tell(file); } } }, 30_000);
	return { dispose: () => { clearInterval(sweep); watcher?.close(); } };
}

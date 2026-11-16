/*---------------------------------------------------------------------------------------------
 *  Arkestra. Whether each Claude session on a machine works now, live: its session file is
 *  written the moment its Claude does something, so a watch on the files (inotify on a Linux
 *  machine, the system's own watch here) tells it at once, wherever the session runs (the
 *  Claude app, a terminal, Arkestra). The left bar's dots follow these.
 *--------------------------------------------------------------------------------------------*/

import { watch, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface LiveState {
	/** The session's id (its file's name). */
	readonly id: string;
	/** `run`: its Claude works on a turn; `idle`: the turn ended (or nothing was written for a long time). */
	readonly state: 'run' | 'idle';
	/** Epoch seconds of the file's last write. */
	readonly at: number;
	/** While it runs: what it does now (the running command's description, the tool), as the Claude app's status line. */
	readonly doing?: string;
	/** Its background tasks that still run (commands, agents, watches), oldest first; `since`: when each started (ISO). */
	readonly bg?: readonly BackgroundTask[];
	/** How many of its background tasks finished (in the part of the file read). */
	readonly done?: number;
}

export interface BackgroundTask { readonly id: string; readonly name: string; readonly since: string }

const STARTED = /^\s*Command (?:running in background with ID: |did not complete within its \d+s timeout and was moved to the background \(ID: )([A-Za-z0-9_-]{5,})/;
const STOPPED = /^\s*\{?"?(?:message"?:\s*")?Successfully stopped task: ([A-Za-z0-9_-]{5,})/;
const NOTIFIED = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g;

/** A session's background tasks, followed line by line from the file (the same rules as the machine watch). */
export class BackgroundTracker {
	private readonly uses = new Map<string, string>();
	private readonly running = new Map<string, BackgroundTask>();
	done = 0;

	line(raw: string): void {
		if (!/run_in_background|background|task-notification|stopped task/.test(raw)) {
			return;
		}
		let d: any;
		try {
			d = JSON.parse(raw);
		} catch {
			return;
		}
		if (d?.isSidechain) {
			return;
		}
		const since = typeof d.timestamp === 'string' ? d.timestamp : '';
		const c = d.message?.content;
		const texts: string[] = [];
		if (typeof c === 'string') {
			texts.push(c);
		}
		if (typeof d.attachment?.prompt === 'string') {
			texts.push(d.attachment.prompt);
		}
		for (const x of Array.isArray(c) ? c : []) {
			if (x?.type === 'tool_use') {
				const i = x.input && typeof x.input === 'object' ? x.input : {};
				this.uses.set(x.id, String(i.description || i.command || x.name || 'Task').slice(0, 120));
			} else if (x?.type === 'tool_result') {
				const r = typeof x.content === 'string' ? x.content : JSON.stringify(x.content);
				const started = STARTED.exec(r);
				if (started && this.uses.has(x.tool_use_id)) {
					this.running.set(started[1], { id: started[1], name: this.uses.get(x.tool_use_id)!, since });
				}
				const stopped = STOPPED.exec(r);
				if (stopped && this.running.delete(stopped[1])) {
					this.done++;
				}
			} else if (x?.type === 'text' && typeof x.text === 'string') {
				texts.push(x.text);
			}
		}
		for (const t of texts) {
			for (const m of t.matchAll(NOTIFIED)) {
				if (m[2] !== 'running' && this.running.delete(m[1].trim())) {
					this.done++;
				}
			}
		}
	}

	get tasks(): BackgroundTask[] {
		return [...this.running.values()].sort((a, b) => a.since.localeCompare(b.since));
	}
}

/** A turn that wrote nothing for this long is taken for ended (stopped, the app closed). */
export const STALE_S = 600;
const TAIL = 65536;
/** How much of a session file the background tasks are first read from. */
const SCAN = 16 << 20;

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

/** What a running turn does now: its latest tool use (a command by its description); undefined: thinking or writing. */
export function doingOfTail(text: string): string | undefined {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		let d: any;
		try {
			d = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		if (d?.type === 'user' && !d.isMeta && !d.isSidechain && !(Array.isArray(d.message?.content) && d.message.content.some((b: any) => b?.type === 'tool_result'))) {
			return undefined; // the user's message: nothing done yet in this turn
		}
		if (d?.type === 'assistant' && !d.isSidechain && Array.isArray(d.message?.content)) {
			const use = [...d.message.content].reverse().find((b: any) => b?.type === 'tool_use');
			if (use) {
				return toolDoing(use);
			}
		}
	}
	return undefined;
}

function toolDoing(use: { name?: unknown; input?: any }): string {
	const input = use.input && typeof use.input === 'object' ? use.input : {};
	const desc = typeof input.description === 'string' ? input.description.trim() : '';
	const file = typeof input.file_path === 'string' ? input.file_path.split('/').pop() : '';
	switch (use.name) {
		case 'Bash': case 'Monitor': return desc || 'Running a command';
		case 'Read': return file ? `Reading ${file}` : 'Reading';
		case 'Edit': case 'MultiEdit': case 'Write': return file ? `Editing ${file}` : 'Editing';
		case 'Grep': case 'Glob': return 'Searching';
		case 'WebSearch': case 'WebFetch': return 'Looking it up';
		case 'Agent': case 'Task': return desc ? `Agent: ${desc}` : 'Running an agent';
		default: return 'Working';
	}
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
import os,sys,json,time,glob,struct,select,re
root=os.path.expanduser('~/.claude/projects')
STALE=${STALE_S}
shown={}
def doing_of(use):
  i=use.get('input') or {}
  n=use.get('name');desc=(i.get('description') or '').strip() if isinstance(i.get('description'),str) else ''
  f=(i.get('file_path') or '').split('/')[-1] if isinstance(i.get('file_path'),str) else ''
  if n in ('Bash','Monitor'):return desc or 'Running a command'
  if n=='Read':return 'Reading '+f if f else 'Reading'
  if n in ('Edit','MultiEdit','Write'):return 'Editing '+f if f else 'Editing'
  if n in ('Grep','Glob'):return 'Searching'
  if n in ('WebSearch','WebFetch'):return 'Looking it up'
  if n in ('Agent','Task'):return 'Agent: '+desc if desc else 'Running an agent'
  return 'Working'
def state(p):
  try:
    with open(p,'rb') as f:
      f.seek(0,2);n=f.tell();f.seek(max(0,n-${TAIL}));lines=f.read().splitlines()
  except Exception:
    return None,None
  s=None
  for raw in reversed(lines):
    try:d=json.loads(raw)
    except Exception:continue
    t=d.get('type')
    if s is None:
      if t=='assistant':
        s='idle' if (d.get('message') or {}).get('stop_reason') in ('end_turn','stop_sequence','max_tokens','refusal') else 'run'
        if s=='idle':return s,None
      elif t=='user' and not d.get('isMeta') and not d.get('isCompactSummary') and not d.get('isSidechain'):
        s='run'
      else:continue
    c=(d.get('message') or {}).get('content')
    if t=='user' and not d.get('isMeta') and not d.get('isSidechain') and not (isinstance(c,list) and any(isinstance(b,dict) and b.get('type')=='tool_result' for b in c)):
      return s,None
    if t=='assistant' and not d.get('isSidechain') and isinstance(c,list):
      uses=[b for b in c if isinstance(b,dict) and b.get('type')=='tool_use']
      if uses:return s,doing_of(uses[-1])
  return s,None
SCAN=16777216
bgs={}
def bg_lines(p,b,data):
  for raw in data.splitlines():
    if b'run_in_background' not in raw and b'background' not in raw and b'task-notification' not in raw and b'stopped task' not in raw:continue
    try:d=json.loads(raw)
    except Exception:continue
    if d.get('isSidechain'):continue
    ts=d.get('timestamp') or ''
    c=(d.get('message') or {}).get('content')
    texts=[]
    if isinstance(c,str):texts.append(c)
    a=d.get('attachment') or {}
    if isinstance(a.get('prompt'),str):texts.append(a['prompt'])
    if isinstance(c,list):
      for x in c:
        if not isinstance(x,dict):continue
        if x.get('type')=='tool_use':
          i=x.get('input') or {}
          b['uses'][x.get('id')]=(i.get('description') or i.get('command') or x.get('name') or 'Task')[:120] if isinstance(i,dict) else 'Task'
        elif x.get('type')=='tool_result':
          r=x.get('content');r=r if isinstance(r,str) else json.dumps(r)
          m=re.match(r'\s*Command (?:running in background with ID: |did not complete within its \d+s timeout and was moved to the background \(ID: )([A-Za-z0-9_-]{5,})',r)
          if m and x.get('tool_use_id') in b['uses']:
            b['run'][m.group(1)]={'id':m.group(1),'name':b['uses'][x.get('tool_use_id')],'since':ts}
          m=re.match(r'\s*\{?"?(?:message"?:\s*")?Successfully stopped task: ([A-Za-z0-9_-]{5,})',r)
          if m and b['run'].pop(m.group(1),None) is not None:b['done']+=1
        elif x.get('type')=='text' and isinstance(x.get('text'),str):texts.append(x['text'])
    for t in texts:
      for m in re.finditer(r'<task-id>([^<]+)</task-id>[\s\S]*?<status>(\w+)</status>',t):
        if m.group(2)!='running' and b['run'].pop(m.group(1).strip(),None) is not None:b['done']+=1
def background(p):
  b=bgs.get(p)
  try:n=os.path.getsize(p)
  except Exception:return [],0
  if b is None or n<b['off']:
    b={'off':max(0,n-SCAN),'uses':{},'run':{},'done':0,'cut':n>SCAN};bgs[p]=b
  if n>b['off']:
    with open(p,'rb') as f:
      f.seek(b['off']);data=f.read(n-b['off'])
    if b.pop('cut',False):
      i=data.find(b'\n');data=data[i+1:] if i>=0 else b'';b['off']=n-len(data)
    j=data.rfind(b'\n')
    if j>=0:
      bg_lines(p,b,data[:j]);b['off']+=j+1
  return sorted(b['run'].values(),key=lambda x:x['since']),b['done']
def tell(p,first=False):
  if not p.endswith('.jsonl'):return
  try:m=os.stat(p).st_mtime
  except Exception:return
  now=time.time()
  if first and now-m>86400:return
  s,doing=state(p)
  if s is None:return
  if s=='run' and now-m>STALE:s='idle'
  if s!='run':doing=None
  bg,done=background(p)
  key=(s,doing,tuple(x['id'] for x in bg),done)
  if shown.get(p)!=key:
    shown[p]=key
    o={'id':os.path.basename(p)[:-6],'state':s,'at':m}
    if doing:o['doing']=doing
    if bg:o['bg']=bg
    if done:o['done']=done
    print(json.dumps(o),flush=True)
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
        if s[0]=='run' or s[2]:tell(p)
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
		if (typeof d?.id !== 'string' || (d.state !== 'run' && d.state !== 'idle') || typeof d.at !== 'number') {
			return undefined;
		}
		const bg = Array.isArray(d.bg) ? d.bg.filter((b: any) => typeof b?.id === 'string' && typeof b.name === 'string').map((b: any) => ({ id: b.id, name: b.name, since: typeof b.since === 'string' ? b.since : '' })) : [];
		return { id: d.id, state: d.state, at: d.at, ...(typeof d.doing === 'string' && d.doing ? { doing: d.doing } : {}), ...(bg.length ? { bg } : {}), ...(typeof d.done === 'number' && d.done > 0 ? { done: d.done } : {}) };
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
	const shown = new Map<string, string>();
	const tracked = new Map<string, { tracker: BackgroundTracker; offset: number }>();
	/** The file's lines since the last look into its tracker (from its last 16 MB the first time). */
	const background = async (file: string, size: number, handle: FileHandle): Promise<BackgroundTracker> => {
		let t = tracked.get(file);
		if (!t || size < t.offset) {
			t = { tracker: new BackgroundTracker(), offset: Math.max(0, size - SCAN) };
			tracked.set(file, t);
			if (t.offset > 0) {
				const probe = Buffer.alloc(Math.min(65536, size - t.offset));
				await handle.read(probe, 0, probe.length, t.offset);
				const nl = probe.indexOf(10);
				t.offset += nl >= 0 ? nl + 1 : probe.length;
			}
		}
		while (t.offset < size) {
			const buf = Buffer.alloc(Math.min(4 << 20, size - t.offset));
			await handle.read(buf, 0, buf.length, t.offset);
			const last = buf.lastIndexOf(10);
			if (last < 0) {
				break;
			}
			for (const line of buf.subarray(0, last).toString('utf8').split('\n')) {
				t.tracker.line(line);
			}
			t.offset += last + 1;
		}
		return t.tracker;
	};
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
				const doing = s === 'run' ? doingOfTail(buf.toString('utf8')) : undefined;
				const tracker = await background(file, stat.size, handle);
				const bg = tracker.tasks;
				const key = `${s}\n${doing ?? ''}\n${bg.map(b => b.id).join(',')}\n${tracker.done}`;
				if (shown.get(file) !== key) {
					shown.set(file, key);
					onState({ id: path.basename(file, '.jsonl'), state: s, at, ...(doing ? { doing } : {}), ...(bg.length ? { bg } : {}), ...(tracker.done ? { done: tracker.done } : {}) });
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
	const sweep = setInterval(() => { for (const [file, s] of shown) { if (s.startsWith('run') || s.split('\n')[2]) { void tell(file); } } }, 30_000);
	return { dispose: () => { clearInterval(sweep); watcher?.close(); } };
}

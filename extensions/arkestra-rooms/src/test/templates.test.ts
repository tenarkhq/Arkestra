/*---------------------------------------------------------------------------------------------
 *  Arkestra. 2ARK templates: signals, the engine with a fake IO for every room type, the run
 *  in a real room with scripted agents, and the git IO in a real temporary repository.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentRegistry, type Agent, type AgentEvent, type TurnInput } from '../agent';
import { Room, newRoomState } from '../room';
import { TemplateEngine, type TemplateIO, type TemplateOutput } from '../templates/engine';
import { GitTemplateIO, createWorkTrees } from '../templates/gitio';
import { TemplateRun } from '../templates/run';
import { auditFindings, codeSignal, pickFindings, questionOf, terminalLine, verdictOf, type Role } from '../templates/signals';
import type { TemplateState } from '../templates/types';

test('signals: the last line outside code blocks, verdicts, findings and picks', () => {
	assert.equal(codeSignal('Kész a szelet.\n\n[SZELET KÉSZ]\n'), 'SZELET KÉSZ');
	assert.equal(codeSignal('Példa:\n```\n[KÉSZ]\n```'), null, 'a signal inside a code block is not one');
	assert.equal(terminalLine('a\n```\nb\n```\n'), '', 'the last line is fenced');
	assert.equal(codeSignal('mondat [KÉSZ]'), null);
	assert.equal(verdictOf('3 hiba.\nVERDIKT: fail'), 'FAIL');
	assert.equal(questionOf('Elemzés.\n\nMelyik ágra menjen? Pl. main.\n\n[DÖNTÉS KELL]'), 'Melyik ágra menjen? Pl. main.');
	const findings = auditFindings('# Audit\n### F1 · P0 · Adatvesztés\n### F2 · P2 · Lassú\n## F3 · P1 · Jog\n### F1 · P0 · dup');
	assert.deepEqual(findings.map(f => f.id), ['F1', 'F2', 'F3']);
	assert.deepEqual(pickFindings('P0 és P1', findings), ['F1', 'F3']);
	assert.deepEqual(pickFindings('F2, F5', findings), ['F2']);
	assert.deepEqual(pickFindings('P0–P2', findings), ['F1', 'F2', 'F3']);
	assert.deepEqual(pickFindings('mind', findings), ['F1', 'F2', 'F3']);
});

function fakeIO(files: Set<string>, overrides: Partial<TemplateIO> = {}): TemplateIO & { calls: string[] } {
	const calls: string[] = [];
	let n = 0;
	return {
		calls,
		fileExists: async f => files.has(path.basename(f)),
		readFile: async () => '### F1 · P0 · Elveszik az adat\n### F2 · P2 · Lassú lekérdezés\n### F3 · P1 · Hiányzó jogosultság',
		commitAll: async (role, title) => { calls.push(`commit ${role} ${title}`); return { sha: `c${++n}`, files: 2 }; },
		workTree: async role => ({ head: `h-${role}-${n}`, dirty: false }),
		integrate: async () => { calls.push('integrate'); return { merged: `m${++n}`, synced: true }; },
		runTests: async cmd => { calls.push(`test ${cmd}`); return { ok: true }; },
		unmerged: async () => 0,
		land: async title => { calls.push(`land ${title}`); return { ok: true, how: 'merge', head: 'L1', where: '/repo' }; },
		...overrides,
	};
}

function recorder() {
	const log: string[] = [];
	const out: TemplateOutput = {
		deliver: (role, text) => log.push(`→${role} ${text.split('\n---\n').at(-1)!.trim().split('\n')[0]}`),
		notice: text => log.push(`notice ${text}`),
		wait: (role, q) => log.push(`wait ${role} ${q.split('\n')[0]}`),
		end: reason => log.push(`end ${reason}`),
		changed: () => { },
	};
	return { log, out, clear: () => { log.length = 0; } };
}

const members = { A: { id: 'claude', name: 'Claude' }, B: { id: 'codex', name: 'Codex' } };
const base = (extra: Partial<TemplateState>): TemplateState => ({ type: 'coding', members, folder: '/room', rounds: 0, max: 60, briefed: {}, waiting: {}, ...extra } as TemplateState);
const code = (extra = {}) => ({ repo: '/repo', base: 'main', coordinator: 'A' as Role, prompt: 'Új funkció', branches: { A: 'arkestra/x-claude', B: 'arkestra/x-codex' }, dirs: { A: '/w/claude', B: '/w/codex' }, plan: 'none' as const, verify: true, test: 'npm test', ...extra });

test('brief check: the fixer writes v1, FAIL goes back with the next version, PASS ends with the final version', async () => {
	const files = new Set<string>();
	const { log, out } = recorder();
	const state = base({ type: 'review', max: 25, review: { reviewer: 'B', prompt: 'Nézd át a briefet', version: 0, strict: 'major' } });
	const engine = new TemplateEngine(state, fakeIO(files), out);
	engine.start();
	assert.match(log[0], /^→A Írd meg a teljes dokumentumot.*v1\.md$/);
	files.add('v1.md');
	await engine.answer('A', 'Megírtam.');
	assert.match(log.at(-1)!, /^→B Új verzió: \/room\/v1\.md$/);
	await engine.answer('B', '1. (P1) Hiányzik a határidő.\nVERDIKT: FAIL');
	assert.match(log.at(-1)!, /^→A A reviewer megállapításai a v1\.md-hez:$/);
	await engine.answer('A', 'Nem írtam újat.');
	assert.ok(log.some(l => l.startsWith('notice A javító nem írt új verziót (v2.md)')));
	files.add('v2.md');
	await engine.answer('B', 'VERDIKT: FAIL');
	await engine.answer('A', 'Javítva.');
	assert.equal(state.review!.version, 2);
	await engine.answer('B', 'Minden lezárva.\nVERDIKT: PASS');
	assert.equal(log.at(-1), 'end PASS · végleges: v2.md');
	assert.equal(state.ended, 'PASS · végleges: v2.md');
	// The briefing goes with the first message only.
	assert.equal(Object.keys(state.briefed).length, 2);
});

test('coding: assignment, slice, merge, done, tests and verification, as in 2ARK', async () => {
	const { log, out, clear } = recorder();
	const io = fakeIO(new Set());
	const state = base({ code: code() });
	const engine = new TemplateEngine(state, io, out);
	engine.start();
	assert.equal(log[0], '→A Kezdd: bontsd szeletekre a feladatot, és oszd ki.');
	clear();
	await engine.answer('A', '1. szelet: Codex, api.ts\n2. szelet: én, ui.ts\n[KIOSZTÁS]');
	assert.deepEqual(log, ['→B A koordinátor (Claude) kiosztása:', '→A Kiosztva Codex-nak, már dolgozik. Most a saját szeleteiden dolgozz; ha egy kész, az utolsó sor: [SZELET KÉSZ].']);
	clear();
	await engine.answer('A', 'ui.ts kész\n[SZELET KÉSZ]');
	assert.deepEqual(log, ['notice Claude: szelet kész, commit c1 a arkestra/x-claude ágon (2 fájl).'], 'the coordinator\'s own slice does not interrupt the peer');
	clear();
	await engine.answer('B', 'api.ts kész\n[KÉSZ]');
	assert.equal(log[0], '→A api.ts kész', 'the executor cannot close the room: its [KÉSZ] is a plain relay');
	clear();
	await engine.answer('B', 'api.ts kész\n[SZELET KÉSZ]');
	assert.ok(io.calls.includes('commit B Codex: api.ts kész'));
	assert.match(log.at(-1)!, /^→A Codex jelzi: szelet kész, commit c2/);
	clear();
	await engine.answer('A', 'Rendben.\n[ÁTEMELÉS]');
	assert.match(log[0], /^notice Átemelve: arkestra\/x-codex → arkestra\/x-claude, m3\. Codex ága is erre állt\.$/);
	assert.match(log[1], /^→B A koordinátor \(Claude\) átemelte a munkádat/);
	clear();
	await engine.answer('A', 'Minden kész.\n[KÉSZ]');
	assert.ok(io.calls.includes('test npm test'));
	assert.deepEqual(log.slice(0, 2), ['notice Tesztek futnak: npm test', 'notice Tesztek: zöld.']);
	assert.match(log.at(-1)!, /^→B Claude szerint a munka kész: arkestra\/x-claude @ h-A-/);
	clear();
	await engine.answer('B', '1. Hiányzik egy teszt.');
	assert.match(log.at(-1)!, /^→A Codex ellenőrzése hibákat talált:/);
	await engine.answer('A', 'Pótoltam.\n[KÉSZ]');
	clear();
	await engine.answer('B', 'Rendben.\n[EGYETÉRTEK]');
	assert.ok(io.calls.includes('land Claude: Rendben.'), 'the checked work goes into the base branch');
	assert.deepEqual(log.slice(-2), ['notice Bevezetve: arkestra/x-claude → main (összefésülve), main most L1.', 'end kész · main @ L1 · /repo']);
});

test('coding: the room ends only when the work is in the base branch; unmerged peer work and a failed landing go back to the coordinator', async () => {
	const { log, out, clear } = recorder();
	let behind = 2;
	let landing: Awaited<ReturnType<TemplateIO['land']>> = { ok: false, reason: 'conflict', files: ['a.ts'], where: '/repo' };
	const io = fakeIO(new Set(), { unmerged: async () => behind, land: async () => landing });
	const engine = new TemplateEngine(base({ code: code({ verify: false, test: undefined }) }), io, out);
	engine.start();
	clear();
	await engine.answer('A', 'Kész.\n[KÉSZ]');
	assert.match(log.at(-1)!, /^→A Codex ágán \(arkestra\/x-codex\) 2 commit van/);
	behind = 0;
	clear();
	await engine.answer('A', 'Kész.\n[KÉSZ]');
	assert.ok(!log.some(l => l.startsWith('end')), 'a conflict with the base branch does not end the room');
	assert.match(log.at(-1)!, /^→A A munka kész, de még nincs a main ágban/);
	landing = { ok: false, reason: 'dirty', files: ['a.ts'], detail: 'a.ts', where: '/repo' };
	clear();
	await engine.answer('A', 'Kész.\n[KÉSZ]');
	assert.ok(log.some(l => l.startsWith('wait A A kész munka')), 'uncommitted changes in the base checkout wait for the user');
	assert.equal(engine.state.ended, undefined);
	landing = { ok: true, how: 'fast-forward', head: 'L2', where: '/repo' };
	clear();
	await engine.answer('A', 'Kész.\n[KÉSZ]');
	assert.equal(log.at(-1), 'end kész · main @ L2 · /repo');
});

test('coding: the slice plan waits for the user, the limit holds the relay back until Continue, decisions wait', async () => {
	const { log, out, clear } = recorder();
	const state = base({ max: 1, code: code({ plan: 'approve', test: undefined, verify: false }) });
	const engine = new TemplateEngine(state, fakeIO(new Set()), out);
	engine.start();
	clear();
	await engine.answer('A', 'Terv: két szelet.\n[KIOSZTÁS]');
	assert.deepEqual(log, ['wait A Claude szeletterve kész (haladas.md), a jóváhagyásodra vár.', 'notice A szeletterv kész (haladas.md); a jóváhagyásodra vár. Hagyd jóvá, vagy írd meg, mit változtasson Claude.']);
	clear();
	await engine.user('Mehet, jóváhagyom.');
	assert.match(log[0], /^→A A felhasználó jóváhagyta a szelettervet\./);
	clear();
	await engine.answer('A', 'Kiosztás.\n[KIOSZTÁS]');
	await engine.answer('B', 'Kérdés a koordinátornak.');
	assert.equal(log.at(-1), 'end elérte a 1 átadást, folytatható');
	assert.deepEqual(state.pending, { to: 'A', text: 'Kérdés a koordinátornak.' });
	clear();
	engine.resume();
	assert.deepEqual(log, ['→A Kérdés a koordinátornak.']);
	clear();
	await engine.answer('B', 'Melyik adatbázis? Pl. Postgres.\n\n[DÖNTÉS KELL]');
	assert.deepEqual(log, ['wait B Melyik adatbázis? Pl. Postgres.', 'notice Codex: a felhasználó döntése kell. Codex a válaszodra vár.']);
	clear();
	await engine.user('Postgres.');
	assert.deepEqual(log, ['→B A felhasználó üzenete:'], 'the answer goes to the one who waits');
});

test('audit by both: independent audits, the lead merges, the other agrees, the user picks the fixes', async () => {
	const files = new Set<string>();
	const { log, out, clear } = recorder();
	const state = base({ type: 'audit', code: code({ test: undefined }), audit: { auditors: 'both', lead: 'B', goal: 'fix', fix: 'approve', phase: 'audit', done: {} } });
	const engine = new TemplateEngine(state, fakeIO(files), out);
	engine.start();
	assert.deepEqual(log.map(l => l.split(' ')[0]), ['→A', '→B']);
	clear();
	await engine.answer('A', 'Még dolgozom.');
	assert.equal(log.length, 0, 'without the signal the answer goes nowhere');
	await engine.answer('A', '[AUDIT KÉSZ]');
	assert.match(log[0], /^→A Nem találom az audit dokumentumot: \/room\/audit-claude\.md/);
	files.add('audit-claude.md').add('audit-codex.md');
	clear();
	await engine.answer('A', '[AUDIT KÉSZ]');
	assert.deepEqual(log, ['notice Claude auditja kész; Codex még dolgozik.']);
	clear();
	await engine.answer('B', '[AUDIT KÉSZ]');
	assert.equal(state.audit!.phase, 'merge');
	assert.match(log.at(-1)!, /^→B Mindkét audit kész/);
	files.add('audit.md');
	clear();
	await engine.answer('B', '[ÖSSZEVETÉS KÉSZ]');
	assert.match(log.at(-1)!, /^→A Codex elkészítette a közös audit dokumentumot/);
	await engine.answer('A', '1. Az F2 inkább P1.');
	assert.match(log.at(-1)!, /^→B Claude ellenvetései/);
	await engine.answer('B', 'Javítottam.\n[ÖSSZEVETÉS KÉSZ]');
	clear();
	await engine.answer('A', '[EGYETÉRTEK]');
	assert.equal(state.audit!.phase, 'approval');
	assert.match(log[0], /^wait B Az audit kész \(3 megállapítás\)/);
	clear();
	await engine.user('P0 és F3');
	assert.equal(state.audit!.phase, 'fix');
	assert.equal(state.code!.coordinator, 'B');
	assert.equal(log.length, 2);
	assert.ok(log[0].startsWith('notice Javítás indul (a jóváhagyásod szerint)'));
	assert.ok(log[1].startsWith('→B Az audit (/room/audit.md) alapján javítsátok'));
	assert.ok(log[0].includes('F1, F3'));
});

test('a one-auditor audit that only documents ends with the document', async () => {
	const files = new Set(['audit.md']);
	const { log, out } = recorder();
	const state = base({ type: 'audit', code: code(), audit: { auditors: 'A', lead: 'A', goal: 'doc', phase: 'audit', done: {} } });
	const engine = new TemplateEngine(state, fakeIO(files), out);
	engine.start();
	assert.equal(log.length, 1);
	await engine.answer('A', '[AUDIT KÉSZ]');
	assert.equal(log.at(-1), 'end audit kész · 3 megállapítás · audit.md');
});

// ---- the run in a real room ----------------------------------------------------------------

class Scripted implements Agent {
	readonly detail = 'test';
	readonly seen: string[][] = [];
	active = 0;
	maxActive = 0;
	constructor(readonly id: string, readonly name: string, private readonly script: (input: TurnInput) => string, private readonly shared: { active: number; max: number }) { }
	async readiness() { return { ready: true }; }
	async turn(input: TurnInput, onEvent: (e: AgentEvent) => void): Promise<void> {
		this.shared.active++;
		this.shared.max = Math.max(this.shared.max, this.shared.active);
		this.seen.push(input.transcript.filter(m => !m.to || m.to.includes(this.id)).map(m => m.text.split('\n---\n').at(-1)!.split('\n')[0]));
		await new Promise(r => setTimeout(r, 30));
		this.shared.active--;
		onEvent({ kind: 'text', text: this.script(input) });
	}
}

test('a coding room runs: instructions only for their agent, both agents work in parallel, the room ends', async () => {
	const shared = { active: 0, max: 0 };
	const lastFor = (input: TurnInput, id: string) => input.transcript.filter(m => m.to?.includes(id)).at(-1)?.text ?? '';
	let claudeTurns = 0;
	const claude = new Scripted('claude', 'Claude', input => {
		const last = lastFor(input, 'claude');
		claudeTurns++;
		if (last.includes('Kezdd')) { return 'Codex: api.ts\n[KIOSZTÁS]'; }
		if (last.includes('Kiosztva')) { return 'ui.ts kész\n[SZELET KÉSZ]'; }
		if (last.includes('szelet kész')) { return 'Átnéztem.\n[ÁTEMELÉS]'; }
		if (last.includes('átemelte') || last.includes('Átemelve')) { return 'Kész.\n[KÉSZ]'; }
		return claudeTurns > 6 ? 'Kész.\n[KÉSZ]' : 'Várok.';
	}, shared);
	const codex = new Scripted('codex', 'Codex', input => {
		const last = lastFor(input, 'codex');
		if (last.includes('kiosztása')) { return 'api.ts kész\n[SZELET KÉSZ]'; }
		if (last.includes('szerint a munka kész')) { return 'Rendben.\n[EGYETÉRTEK]'; }
		return 'Ok.';
	}, shared);
	const registry = new AgentRegistry();
	registry.register(claude);
	registry.register(codex);
	const room = new Room(newRoomState('t'), registry);
	await room.invite('claude');
	await room.invite('codex');
	const io = fakeIO(new Set());
	const state = base({ code: code({ test: undefined }) });
	const run = new TemplateRun(room, state, io);
	const ended = new Promise<string>(resolve => run.on(e => { if (e.kind === 'end') { resolve(e.reason); } }));
	run.engine.start();
	assert.match(await ended, /^kész · main @ L1/);
	assert.equal(await run.settled(), 'ended');
	assert.equal(shared.max, 2, 'the coordinator worked on its own slice while the executor worked on its one');
	assert.ok(codex.seen.every(t => !t.some(line => line.startsWith('Kezdd'))), 'the coordinator\'s instructions never reach the executor');
	assert.ok(room.messages.some(m => m.author.id === 'codex' && m.text.includes('[EGYETÉRTEK]')));
	assert.deepEqual(run.addressed('@codex nézd meg, @Claude te is'), ['A', 'B']);
});

test('a failing agent pauses the room; the user\'s word resumes it', async () => {
	const shared = { active: 0, max: 0 };
	let fail = true;
	const a = new Scripted('a', 'A', () => { if (fail) { throw new Error('quota'); } return 'Rendben.'; }, shared);
	const b = new Scripted('b', 'B', () => 'x', shared);
	const registry = new AgentRegistry();
	registry.register(a);
	registry.register(b);
	const room = new Room(newRoomState('t'), registry);
	const state = base({ members: { A: { id: 'a', name: 'A' }, B: { id: 'b', name: 'B' } }, code: code() });
	const run = new TemplateRun(room, state, fakeIO(new Set()));
	run.engine.start();
	assert.equal(await run.settled(), 'paused');
	assert.match(run.paused!, /^A: quota$/);
	fail = false;
	run.unpause();
	await run.engine.user('Próbáld újra.', ['A']);
	await run.settled();
	assert.equal(run.paused, undefined);
	assert.ok(room.messages.some(m => m.author.id === 'a' && m.text === 'Rendben.'));
});

// ---- git -----------------------------------------------------------------------------------

test('git: work trees on their own branches, commits, a clean merge, a conflict, tests', async () => {
	const repo = await mkdtemp(path.join(tmpdir(), 'arkestra-tpl-'));
	const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
	sh(repo, 'init', '-q', '-b', 'main');
	await writeFile(path.join(repo, 'a.txt'), 'one\n');
	sh(repo, 'add', '.');
	sh(repo, 'commit', '-q', '-m', 'init');
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
	const trees = await createWorkTrees(repo, 'main', 'room-1abc', { A: 'Claude', B: 'Codex' });
	assert.equal(trees.branches.A, 'arkestra/room1abc-claude');
	assert.ok(trees.dirs.B.endsWith(path.join('.arkestra', 'rooms', 'room1abc', 'codex')));
	assert.ok((await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).includes('/.arkestra/'));
	assert.equal(sh(repo, 'status', '--porcelain'), '', 'the work trees do not show up in the project');
	const io = new GitTemplateIO(() => ({ ...trees, repo, base: 'main', coordinator: 'A' as Role }));
	assert.equal(await io.commitAll('B', 'nothing'), null);
	await writeFile(path.join(trees.dirs.B, 'b.txt'), 'codex\n');
	const commit = await io.commitAll('B', 'Codex: b.txt');
	assert.equal(commit?.files, 1);
	const merged = await io.integrate();
	assert.equal(merged.conflicts, undefined);
	assert.equal(merged.synced, true);
	assert.equal((await io.workTree('B')).head, merged.merged);
	await writeFile(path.join(trees.dirs.A, 'a.txt'), 'claude\n');
	await io.commitAll('A', 'Claude: a');
	await writeFile(path.join(trees.dirs.B, 'a.txt'), 'codex\n');
	await io.commitAll('B', 'Codex: a');
	const conflict = await io.integrate();
	assert.deepEqual(conflict.conflicts, ['a.txt']);
	assert.equal((await io.runTests('test -f a.txt')).ok, true);
	const red = await io.runTests('echo nope; exit 3');
	assert.equal(red.ok, false);
	assert.equal(red.why, 'kilépési kód 3');
	assert.match(red.tail!, /nope/);
});

test('git: landing brings the coordinator\'s branch into the checked-out base, refuses conflicts and dirty files, never leaves a half merge', async () => {
	const repo = await mkdtemp(path.join(tmpdir(), 'arkestra-land-'));
	const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
	sh(repo, 'init', '-q', '-b', 'main');
	await writeFile(path.join(repo, 'a.txt'), 'one\n');
	sh(repo, 'add', '.');
	sh(repo, 'commit', '-q', '-m', 'init');
	const trees = await createWorkTrees(repo, 'main', 'room-land', { A: 'Claude', B: 'Codex' });
	const io = new GitTemplateIO(() => ({ ...trees, repo, base: 'main', coordinator: 'A' as Role }));
	await writeFile(path.join(trees.dirs.A, 'b.txt'), 'claude\n');
	await io.commitAll('A', 'Claude: b');
	await writeFile(path.join(trees.dirs.B, 'c.txt'), 'codex\n');
	await io.commitAll('B', 'Codex: c');
	assert.equal(await io.unmerged('B'), 1, 'the peer\'s commit is not in the coordinator\'s branch yet');
	await io.integrate();
	assert.equal(await io.unmerged('B'), 0);
	const ff = await io.land('Claude: kész');
	assert.equal(ff.ok && ff.how, 'fast-forward');
	assert.equal(await readFile(path.join(repo, 'b.txt'), 'utf8'), 'claude\n', 'the work is in the user\'s checkout');
	assert.equal(sh(repo, 'status', '--porcelain'), '');
	assert.equal((await io.land('again')).ok && 'already', 'already');
	// The base moved on and touches the same file: a conflict, and main is left as it was.
	await writeFile(path.join(repo, 'a.txt'), 'user\n');
	sh(repo, 'commit', '-qam', 'user edit');
	await writeFile(path.join(trees.dirs.A, 'a.txt'), 'claude\n');
	await io.commitAll('A', 'Claude: a');
	const conflict = await io.land('Claude: a');
	assert.equal(!conflict.ok && conflict.reason, 'conflict');
	assert.deepEqual(!conflict.ok && conflict.files, ['a.txt']);
	assert.equal(sh(repo, 'status', '--porcelain'), '', 'the failed merge was aborted');
	// The coordinator merges main in, then landing is a real merge.
	sh(trees.dirs.A, 'merge', '-q', '-X', 'ours', '--no-edit', 'main');
	await writeFile(path.join(repo, 'x.txt'), 'side\n');
	sh(repo, 'add', 'x.txt');
	sh(repo, 'commit', '-qm', 'side');
	await writeFile(path.join(repo, 'a.txt'), 'dirty\n');
	const dirty = await io.land('Claude: a');
	assert.equal(!dirty.ok && dirty.reason, 'dirty');
	sh(repo, 'checkout', '--', 'a.txt');
	const merged = await io.land('Claude: a');
	assert.equal(merged.ok && merged.how, 'merge');
	assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'claude\n');
	// Base not checked out anywhere and behind: a fast-forward of the ref only.
	sh(repo, 'checkout', '-q', '-b', 'other');
	await writeFile(path.join(trees.dirs.A, 'd.txt'), 'd\n');
	await io.commitAll('A', 'Claude: d');
	const refOnly = await io.land('Claude: d');
	assert.equal(refOnly.ok && refOnly.how, 'fast-forward');
	assert.equal(sh(repo, 'rev-parse', 'main'), sh(trees.dirs.A, 'rev-parse', 'HEAD'));
	assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'other', 'the user\'s checkout is not switched');
});

/*---------------------------------------------------------------------------------------------
 *  Arkestra. The 2ARK room templates as a state machine: review (brief check), coding and
 *  code audit. After every answer the engine reads the signal line and decides who gets
 *  what next, as 2ARK's daemon does (2ark ark/server.mjs). Git, files and tests go through
 *  the TemplateIO the room gives it; deliveries, notices and the end go to the TemplateOutput.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { AUDIT_FILE, AUDIT_LEVELS, USER, auditBriefing, auditBystanderBriefing, auditFile, codingBriefing, reviewBriefing, versionPath } from './briefings';
import { auditFindings, auditSignal, codeSignal, commitTitle, other, pickFindings, questionOf, verdictOf, type Role } from './signals';
import type { TemplateState } from './types';

export interface WorkTreeState {
	readonly head: string;
	readonly dirty: boolean;
}

export interface TemplateIO {
	fileExists(file: string): Promise<boolean>;
	readFile(file: string): Promise<string | undefined>;
	/** Commits everything in the role's work tree; null when there was nothing to commit. */
	commitAll(role: Role, title: string): Promise<{ sha: string; files: number } | null>;
	workTree(role: Role): Promise<WorkTreeState>;
	/** Merges the other branch into the coordinator's, and brings the other work tree up to it. */
	integrate(): Promise<{ merged: string; conflicts?: string[]; synced?: boolean; syncReason?: 'dirty' | 'diverged' | 'error' }>;
	runTests(command: string): Promise<{ ok: boolean; why?: string; tail?: string }>;
}

export interface TemplateOutput {
	/** One message for one agent; the room runs that agent's turn with it. */
	deliver(role: Role, text: string): void;
	/** A line in the room, for the user. */
	notice(text: string): void;
	/** An agent waits for the user's decision. */
	wait(role: Role, question: string): void;
	/** The room stops: done, or the round limit (then Continue resumes). */
	end(reason: string, result?: { branch?: string; head?: string; final?: string }): void;
	/** The state changed; the room saves it. */
	changed(): void;
}

export class TemplateEngine {
	constructor(readonly state: TemplateState, private readonly io: TemplateIO, private readonly out: TemplateOutput) { }

	private name(role: Role): string { return this.state.members[role].name; }

	/** The first message to an agent carries its briefing. */
	private deliver(role: Role, text: string): void {
		const s = this.state;
		if (!s.briefed[role]) {
			s.briefed[role] = true;
			text = `${this.briefing(role)}\n\n---\n\n${text}`;
		}
		delete s.waiting[role];
		this.out.changed();
		this.out.deliver(role, text);
	}

	private briefing(role: Role): string {
		const s = this.state;
		if (s.type === 'review') {
			return reviewBriefing(s, role);
		}
		if (s.type === 'coding' || (s.audit && ['fix', 'verify'].includes(s.audit.phase))) {
			return codingBriefing(s, role);
		}
		return s.audit!.auditors === 'both' || s.audit!.auditors === role ? auditBriefing(s, role) : auditBystanderBriefing(s, role);
	}

	/** A relay to the other agent, unless the room reached its limit (then Continue sends it). */
	private relay(to: Role, text: string): void {
		const s = this.state;
		if (s.rounds >= s.max) {
			s.pending = { to, text };
			this.end(`elérte a ${s.max} átadást, folytatható`);
			return;
		}
		s.rounds += 1;
		this.deliver(to, text);
	}

	private end(reason: string, result?: { branch?: string; head?: string; final?: string }): void {
		this.state.ended = reason;
		this.out.changed();
		this.out.end(reason, result);
	}

	private decision(role: Role, answer: string): void {
		const question = questionOf(answer) || `${USER} döntése kell.`;
		this.state.waiting[role] = question;
		this.out.changed();
		this.out.wait(role, question);
		this.out.notice(`${this.name(role)}: ${USER.toLowerCase()} döntése kell. ${this.name(role)} a válaszodra vár.`);
	}

	// ---- start ------------------------------------------------------------------------

	start(): void {
		const s = this.state;
		if (s.type === 'review') {
			const r = s.review!;
			if (r.version) {
				this.deliver(r.reviewer, `Ellenőrizd a dokumentumot: ${versionPath(s, r.version)}`);
			} else {
				this.deliver(other(r.reviewer), `Írd meg a teljes dokumentumot a feladat szerint: ${versionPath(s, 1)}`);
			}
		} else if (s.type === 'coding') {
			this.deliver(s.code!.coordinator, 'Kezdd: bontsd szeletekre a feladatot, és oszd ki.');
		} else {
			const a = s.audit!;
			for (const role of a.auditors === 'both' ? ['A', 'B'] as Role[] : [a.auditors]) {
				this.deliver(role, `Kezdd az auditot. A dokumentumod: ${auditFile(s, role)}`);
			}
		}
	}

	// ---- answers ----------------------------------------------------------------------

	async answer(role: Role, text: string): Promise<void> {
		const s = this.state;
		if (s.ended) {
			return;
		}
		if (s.type === 'review') {
			return this.reviewAnswer(role, text);
		}
		if (s.audit && ['audit', 'merge'].includes(s.audit.phase)) {
			return this.auditAnswer(role, text);
		}
		if (s.audit?.phase === 'approval') {
			return; // the user picks what to fix
		}
		if (s.audit?.phase === 'verify' || s.code?.verifying) {
			return this.verifyAnswer(role, text);
		}
		return this.codeAnswer(role, text);
	}

	private async reviewAnswer(role: Role, answer: string): Promise<void> {
		const s = this.state;
		const r = s.review!;
		const fixer = other(r.reviewer);
		if (role === r.reviewer) {
			if (verdictOf(answer) === 'PASS') {
				if (!r.version || !(await this.io.fileExists(versionPath(s, r.version)))) {
					this.out.notice('PASS jelzés érkezett, de nincs végleges dokumentum. A javító készítse el a v1.md-t.');
					this.deliver(fixer, `Írd meg a teljes dokumentumot: ${versionPath(s, 1)}.`);
					return;
				}
				this.end(`PASS · végleges: v${r.version}.md`, { final: versionPath(s, r.version) });
				return;
			}
			this.relay(fixer, `A reviewer megállapításai ${r.version ? `a v${r.version}.md-hez` : 'a feladatban megnevezett anyaghoz'}:\n\n${answer}\n\nA javított teljes dokumentumot ide írd: ${versionPath(s, r.version + 1)}`);
			return;
		}
		const written = await this.io.fileExists(versionPath(s, r.version + 1));
		if (written) {
			r.version += 1;
			this.out.changed();
		} else {
			this.out.notice(`A javító nem írt új verziót (v${r.version + 1}.md); a reviewer ${r.version ? `a v${r.version}.md-t` : 'az eredeti anyagot'} nézi újra.`);
		}
		const current = r.version ? versionPath(s, r.version) : 'a feladatban megnevezett eredeti anyag';
		this.relay(r.reviewer, `${written ? 'Új verzió' : 'Nincs új verzió, az aktuális'}: ${current}\n\nA javító válasza:\n\n${answer}\n\nEllenőrizd a verziót.`);
	}

	private planPending(): boolean {
		const c = this.state.code!;
		return c.plan === 'approve' && c.planState !== 'approved';
	}

	private async codeAnswer(role: Role, answer: string): Promise<void> {
		const s = this.state;
		const c = s.code!;
		const peerRole = other(role);
		const me = this.name(role);
		const peer = this.name(peerRole);
		const isCoordinator = role === c.coordinator;
		let signal = codeSignal(answer);
		if (!isCoordinator && (signal === 'KIOSZTÁS' || signal === 'TERV KÉSZ' || signal === 'ÁTEMELÉS' || signal === 'KÉSZ')) {
			signal = null; // the coordinator's signals
		}
		if (signal === 'KIOSZTÁS' && this.planPending()) {
			signal = 'TERV KÉSZ'; // nothing is handed out before the user approves
		}
		switch (signal) {
			case 'DÖNTÉS KELL':
				return this.decision(role, answer);
			case 'SZELET KÉSZ': {
				const done = await this.io.commitAll(role, commitTitle(me, answer));
				const what = done ? `commit ${done.sha} a ${c.branches[role]} ágon (${done.files} fájl)` : `a ${c.branches[role]} ág most ${(await this.io.workTree(role)).head}`;
				this.out.notice(`${me}: szelet kész, ${what}.`);
				if (isCoordinator) {
					return; // its own slice: the peer is not interrupted
				}
				return this.relay(peerRole, `${me} jelzi: szelet kész, ${what}.\n\nÁtnézés a munkafádból: git diff ${c.branches[peerRole]}...${c.branches[role]}\n\n${me} válasza:\n\n${answer}`);
			}
			case 'TERV KÉSZ':
				if (!this.planPending()) {
					return this.deliver(role, 'A szeletterv már jóvá van hagyva: oszd ki a szeleteket, az utolsó sor: [KIOSZTÁS].');
				}
				c.planState = 'waiting';
				s.waiting[role] = 'szeletterv';
				this.out.changed();
				this.out.wait(role, `${me} szeletterve kész (haladas.md), a jóváhagyásodra vár.`);
				return this.out.notice(`A szeletterv kész (haladas.md); a jóváhagyásodra vár. Hagyd jóvá, vagy írd meg, mit változtasson ${me}.`);
			case 'KIOSZTÁS':
				this.relay(peerRole, `A koordinátor (${me}) kiosztása:\n\n${answer}`);
				if (!s.ended) {
					this.deliver(role, `Kiosztva ${peer}-nak, már dolgozik. Most a saját szeleteiden dolgozz; ha egy kész, az utolsó sor: [SZELET KÉSZ].`);
				}
				return;
			case 'ÁTEMELÉS': {
				const result = await this.io.integrate();
				if (result.conflicts?.length) {
					this.out.notice(`Átemelés: ütközés ${result.conflicts.length} fájlban.`);
					return this.deliver(role, `Az átemelés ütközött ezekben a fájlokban:\n${result.conflicts.map(f => `- ${f}`).join('\n')}\n\nOldd fel őket a munkafádban (${c.dirs[role]}), a <<<<<<< jelöléseket töröld, majd az utolsó sor: [ÁTEMELÉS].`);
				}
				this.out.notice(`Átemelve: ${c.branches[peerRole]} → ${c.branches[role]}, ${result.merged}.${result.synced ? ` ${peer} ága is erre állt.` : ''}`);
				const sync = result.synced ? ' A te ágad is erre állt.' : result.syncReason === 'dirty' ? ' A munkafádban nem commitolt változás van.' : result.syncReason === 'diverged' ? ' Az ágad közben előrement; az ágakat külön egyeztetni kell.' : ' A munkafa szinkronizálása git-hibával leállt.';
				return this.relay(peerRole, `A koordinátor (${me}) átemelte a munkádat: ${c.branches[role]} most ${result.merged}.${sync}\n\n${me} válasza:\n\n${answer}`);
			}
			case 'KÉSZ':
				return this.codeDone(role, answer);
			default:
				return this.relay(peerRole, answer);
		}
	}

	private async codeDone(role: Role, answer: string): Promise<void> {
		const s = this.state;
		const c = s.code!;
		const me = this.name(role);
		await this.io.commitAll(role, commitTitle(me, answer));
		const before = { A: await this.io.workTree('A'), B: await this.io.workTree('B') };
		if (before.A.dirty || before.B.dirty) {
			return this.deliver(role, 'A lezárás előtt valamelyik munkafában még nem commitolt változás van. Rendezd a szeleteket, majd jelezz újra: [KÉSZ].');
		}
		if (c.test) {
			this.out.notice(`Tesztek futnak: ${c.test}`);
			const result = await this.io.runTests(c.test);
			if (!result.ok) {
				this.out.notice(`A tesztek nem zöldek (${result.why ?? 'hiba'}).`);
				return this.deliver(role, `A tesztparancs (${c.test}) nem zöld: ${result.why ?? 'hiba'}. Kimenet:\n\n${result.tail ?? ''}\n\nJavítsd, majd jelezz: [KÉSZ].`);
			}
			const after = { A: await this.io.workTree('A'), B: await this.io.workTree('B') };
			if (after.A.head !== before.A.head || after.B.head !== before.B.head || after.A.dirty || after.B.dirty) {
				return this.deliver(role, 'A tesztek alatt megváltozott egy HEAD vagy munkafa. Az eredmény érvénytelen; rendezd, majd jelezz újra: [KÉSZ].');
			}
			this.out.notice('Tesztek: zöld.');
		}
		const head = before[role].head;
		if (s.audit?.phase === 'fix' || c.verify) {
			return this.startVerify(role, head, answer, before);
		}
		this.end(`kész · ${c.branches[role]} @ ${head} · ${c.dirs[role]}`, { branch: c.branches[role], head });
	}

	private startVerify(lead: Role, head: string, answer: string, state: Record<Role, WorkTreeState>): void {
		const s = this.state;
		const c = s.code!;
		const a = s.audit;
		const peer = other(lead);
		const leadName = this.name(lead);
		c.verification = { A: { ...state.A }, B: { ...state.B } };
		if (a) {
			a.phase = 'verify';
			a.head = head;
		} else {
			c.verifying = head;
		}
		this.out.notice(`${a ? 'A javítás' : 'A munka'} kész (${c.branches[lead]} @ ${head}); ${this.name(peer)} ellenőrzi.`);
		s.rounds += 1;
		const runHint = `Ahol lehet, futtatással is (a koordinátor ágát egy ideiglenes worktree-ben futtathatod: git worktree add "$TMPDIR/<név>" ${c.branches[lead]}, utána töröld).`;
		const what = a
			? `Ellenőrizd függetlenül, pontonként: az audit dokumentumban (${path.join(s.folder, AUDIT_FILE)}) minden „Állapot: javítva” megállapításnál nézd meg a változást (a munkafádból: git diff ${c.base}...${c.branches[lead]}), és győződj meg róla, hogy a hiba tényleg megszűnt, és a javítás nem okozott újat. ${runHint} A „nem javítva” indoklásokat is nézd át.`
			: `Ellenőrizd függetlenül a teljes változást a briefhez képest (a munkafádból: git diff ${c.base}...${c.branches[lead]}): teljesül-e a brief minden pontja, helyes-e a kód, nincs-e regresszió vagy hiányzó teszt. ${runHint}`;
		this.deliver(peer, `${leadName} szerint ${a ? 'a javítás' : 'a munka'} kész: ${c.branches[lead]} @ ${head}.\n\n${what}\n\nHa minden rendben, a válaszod utolsó sora: [EGYETÉRTEK]. Ha nem, írd le számozva a hibákat, jelzés nélkül; azok ${leadName}-hoz kerülnek javításra.\n\n${leadName} válasza:\n\n${answer}`);
	}

	private async verifyAnswer(role: Role, answer: string): Promise<void> {
		const s = this.state;
		const c = s.code!;
		const a = s.audit;
		const lead = c.coordinator;
		const peer = other(lead);
		const signal = auditSignal(answer);
		if (signal === 'DÖNTÉS KELL') {
			return this.decision(role, answer);
		}
		if (role === peer && signal === 'EGYETÉRTEK') {
			const head = a ? a.head! : c.verifying!;
			const now = { A: await this.io.workTree('A'), B: await this.io.workTree('B') };
			const same = c.verification && (['A', 'B'] as Role[]).every(r => c.verification![r].head === now[r].head && !now[r].dirty);
			c.verification = undefined;
			c.verifying = undefined;
			if (!same) {
				if (a) {
					a.phase = 'fix';
				}
				return this.deliver(lead, 'Az ellenőrzés óta megváltozott a HEAD vagy a munkafa. Az egyetértés nem zárja le a szobát. Rendezd, majd új teszttel és ellenőrzéssel jelezz: [KÉSZ].');
			}
			if (a) {
				a.phase = 'fixed';
			}
			return this.end(`kész · ${c.branches[lead]} @ ${head} · ${c.dirs[lead]}`, { branch: c.branches[lead], head, ...(a ? { final: path.join(s.folder, AUDIT_FILE) } : {}) });
		}
		if (role === peer) {
			// Back to work: the coordinator's next [KÉSZ] sends it to the check again.
			if (a) {
				a.phase = 'fix';
			} else {
				c.verifying = undefined;
			}
			c.verification = undefined;
			const status = a ? ', frissítsd az audit dokumentumban az állapotukat' : '';
			return this.relay(lead, `${this.name(peer)} ellenőrzése hibákat talált:\n\n${answer}\n\nJavítsd őket (vagy indokold, miért nem hiba)${status}, és ha kész, az utolsó sor: [KÉSZ].`);
		}
		return this.relay(peer, answer);
	}

	private async auditAnswer(role: Role, answer: string): Promise<void> {
		const s = this.state;
		const a = s.audit!;
		const peerRole = other(role);
		const me = this.name(role);
		const peer = this.name(peerRole);
		const lead = this.name(a.lead);
		const signal = auditSignal(answer);
		if (signal === 'DÖNTÉS KELL') {
			return this.decision(role, answer);
		}
		if (a.phase === 'audit') {
			if (signal !== 'AUDIT KÉSZ') {
				// The audits are independent: an answer without the signal goes nowhere.
				if (await this.io.fileExists(auditFile(s, role))) {
					this.out.notice(`${me}: az audit fájl megvan, de nem jelezte, hogy kész. Ha kész, írd meg neki.`);
				}
				return;
			}
			if (!(await this.io.fileExists(auditFile(s, role)))) {
				return this.deliver(role, `Nem találom az audit dokumentumot: ${auditFile(s, role)}. Írd oda, és utána jelezz újra: [AUDIT KÉSZ].`);
			}
			a.done[role] = true;
			this.out.changed();
			if (a.auditors === 'both' && !a.done[peerRole]) {
				return this.out.notice(`${me} auditja kész; ${peer} még dolgozik.`);
			}
			if (a.auditors !== 'both') {
				return this.finishAudit();
			}
			a.phase = 'merge';
			this.out.notice(`Mindkét audit kész. ${lead} összeveti őket: ${AUDIT_FILE}.`);
			s.rounds += 1;
			return this.deliver(a.lead, `Mindkét audit kész: ${auditFile(s, 'A')} és ${auditFile(s, 'B')}. Most már olvashatod a másikat is.\n\nVesd össze őket egy közös dokumentumba: ${path.join(s.folder, AUDIT_FILE)}, ugyanabban a felépítésben. Ugyanaz a hiba egyszer szerepeljen, és jelöld, ki találta (${this.name('A')}, ${this.name('B')} vagy mindkettő). Amit csak az egyik talált, azt ellenőrizd a kódban: ha igaz, vedd fel; ha nem, a dokumentum végén az „Elvetett megállapítások” részben indokold. Eltérő súlyosságnál dönts, és indokold. A megállapításokat számozd újra F1-től.\n\nHa kész, az utolsó sor: [ÖSSZEVETÉS KÉSZ]. Az Arkestra ekkor elküldi ${this.name(other(a.lead))}-nak ellenőrzésre.`);
		}
		// merge
		if (role === a.lead && signal === 'ÖSSZEVETÉS KÉSZ') {
			if (!(await this.io.fileExists(path.join(s.folder, AUDIT_FILE)))) {
				return this.deliver(role, `Nem találom a közös dokumentumot: ${path.join(s.folder, AUDIT_FILE)}. Írd oda, és utána jelezz újra: [ÖSSZEVETÉS KÉSZ].`);
			}
			return this.relay(peerRole, `${lead} elkészítette a közös audit dokumentumot: ${path.join(s.folder, AUDIT_FILE)}.\n\nVesd össze a saját auditoddal (${auditFile(s, peerRole)}): minden megállapításod szerepel-e, vagy indokoltan vetették el; egyetértesz-e a súlyosságokkal és a javítási javaslatokkal. Amit vitatsz, ellenőrizd a kódban.\n\nHa rendben van, a válaszod utolsó sora: [EGYETÉRTEK]. Ha nem, írd le számozva az ellenvetéseidet, jelzés nélkül; azok ${lead}-hoz kerülnek.\n\n${lead} válasza:\n\n${answer}`);
		}
		if (role !== a.lead && signal === 'EGYETÉRTEK') {
			return this.finishAudit();
		}
		if (role !== a.lead) {
			return this.relay(a.lead, `${me} ellenvetései a közös dokumentumhoz:\n\n${answer}\n\nJavítsd az audit dokumentumot, vagy indokold, miért marad; utána az utolsó sor: [ÖSSZEVETÉS KÉSZ].`);
		}
		return this.relay(peerRole, answer);
	}

	/** The audit document is final: close, wait for the user's pick, or start fixing. */
	private async finishAudit(): Promise<void> {
		const s = this.state;
		const a = s.audit!;
		const findings = auditFindings(await this.io.readFile(path.join(s.folder, AUDIT_FILE)) ?? '');
		if (a.goal !== 'fix') {
			a.phase = 'closed';
			return this.end(`audit kész · ${findings.length} megállapítás · ${AUDIT_FILE}`, { final: path.join(s.folder, AUDIT_FILE) });
		}
		if (a.fix === 'auto') {
			const level = Number((a.levels ?? 'P1').slice(1));
			const picked = findings.filter(f => Number(f.level.slice(1)) <= level).map(f => f.id);
			if (!picked.length) {
				a.phase = 'closed';
				return this.end(`audit kész · nincs javítandó (${AUDIT_LEVELS[a.levels ?? 'P1']}) · ${AUDIT_FILE}`, { final: path.join(s.folder, AUDIT_FILE) });
			}
			return this.startFix(picked, AUDIT_LEVELS[a.levels ?? 'P1']);
		}
		a.phase = 'approval';
		this.out.changed();
		const list = findings.map(f => `${f.id} · ${f.level} · ${f.title}`).join('\n');
		this.out.wait(a.lead, `Az audit kész (${findings.length} megállapítás). Mit javítsanak? Pl. „P0 és P1”, „F2, F5”, „mind”, vagy „nincs javítás”.\n\n${list}`);
		this.out.notice(`Az audit kész: ${AUDIT_FILE}. Írd meg, mit javítsanak (pl. „P0 és P1”, „F2, F5”, „mind”), vagy „nincs javítás”.`);
	}

	private startFix(ids: readonly string[], what: string): void {
		const s = this.state;
		const a = s.audit!;
		a.phase = 'fix';
		s.code!.coordinator = a.lead;
		s.briefed = {}; // the fix is a coding room: both get the coding briefing
		s.rounds = 0;
		this.out.notice(`Javítás indul (${what}): ${ids.join(', ')}. ${this.name(a.lead)} vezeti.`);
		this.deliver(a.lead, `Az audit (${path.join(s.folder, AUDIT_FILE)}) alapján javítsátok ezeket a megállapításokat: ${ids.join(', ')}. Bontsd szeletekre, oszd ki, és minden megállapításnál az audit dokumentumban írd be: „Állapot: javítva (commit)” vagy „Állapot: nem javítva – indoklás”.`);
	}

	// ---- the user ---------------------------------------------------------------------

	/**
	 * The user wrote into the room: their word resets the round count; it goes to the
	 * agents named (@Name), else to the waiting ones, else to both.
	 */
	async user(text: string, to?: readonly Role[]): Promise<void> {
		const s = this.state;
		s.rounds = 0;
		const a = s.audit;
		if (a?.phase === 'approval') {
			if (/\bnincs\s+javítás|\bno\s+fix/i.test(text)) {
				a.phase = 'closed';
				return this.end(`audit kész · javítás nélkül · ${AUDIT_FILE}`, { final: path.join(s.folder, AUDIT_FILE) });
			}
			const findings = auditFindings(await this.io.readFile(path.join(s.folder, AUDIT_FILE)) ?? '');
			const picked = pickFindings(text, findings);
			if (picked.length) {
				s.ended = undefined;
				return this.startFix(picked, 'a jóváhagyásod szerint');
			}
		}
		if (s.code?.planState === 'waiting' && /\b(jóváhagy|mehet|rendben|approve|ok\b)/i.test(text) && (!to || to.includes(s.code.coordinator))) {
			return this.approvePlan(text);
		}
		s.ended = undefined;
		const targets = to?.length ? to : (Object.keys(s.waiting) as Role[]).length ? Object.keys(s.waiting) as Role[] : ['A', 'B'] as Role[];
		for (const role of targets) {
			this.deliver(role, `${USER} üzenete:\n\n${text}`);
		}
	}

	approvePlan(note = ''): void {
		const c = this.state.code!;
		if (c.planState !== 'waiting') {
			return;
		}
		c.planState = 'approved';
		this.state.ended = undefined;
		this.deliver(c.coordinator, `${USER} jóváhagyta a szelettervet.${note ? `\n\n${note}` : ''}\n\nOszd ki a szeleteket; a kiosztó üzenet utolsó sora: [KIOSZTÁS].`);
	}

	/** Continue after the round limit: the held-back relay goes out. */
	resume(): void {
		const s = this.state;
		const pending = s.pending;
		s.pending = undefined;
		s.ended = undefined;
		s.rounds = 0;
		if (pending) {
			this.deliver(pending.to, pending.text);
		}
		this.out.changed();
	}
}

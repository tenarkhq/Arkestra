/*---------------------------------------------------------------------------------------------
 *  Arkestra. The briefings of the 2ARK room templates, as 2ARK gives them to its agents
 *  (2ark ark/server.mjs). Agent-facing and in Hungarian, like 2ARK's protocol.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { other, type Role } from './signals';
import type { TemplateState } from './types';

export const USER = 'A felhasználó';
export const PROGRESS_RULE = 'Ha egy munkád 5 percnél tovább tart, kb. 5 percenként írj egy külön rövid üzenetet: „Haladás: N% – mi kész, mi van hátra”. Az időt a date paranccsal nézd.';

const REVIEW_LEVELS = 'Minden megállapítást sorolj be: P0 kritikus (hibás döntéshez vagy kárhoz vezet), P1 súlyos (érdemi hiba vagy hiány), P2 közepes, P3 apróság. A szám mellé írd a szintet, pl. „3. (P1)”.';
const REVIEW_STRICT = {
	all: `${REVIEW_LEVELS} PASS csak akkor, ha egyetlen nyitott megállapítás sincs.`,
	major: `${REVIEW_LEVELS} PASS, ha nincs nyitott P0 vagy P1 megállapítás; a P2 és P3 megállapításokat leírod, de nem blokkolnak.`,
	critical: `${REVIEW_LEVELS} PASS, ha nincs nyitott P0 megállapítás; a többit leírod, de nem blokkolnak.`,
};
export const AUDIT_LEVELS = { P0: 'minden P0 megállapítás', P1: 'a P0 és P1 megállapítások', P2: 'a P0, P1 és P2 megállapítások', P3: 'minden megállapítás (P0–P3)' } as const;
export const AUDIT_FILE = 'audit.md';

export const versionPath = (s: TemplateState, n: number) => path.join(s.folder, `v${n}.md`);
export const progressFile = (s: TemplateState, role: Role) => path.join(s.folder, `haladas-${slug(s.members[role].name)}.md`);
export const auditFile = (s: TemplateState, role: Role) => path.join(s.folder, s.audit!.auditors === 'both' ? `audit-${slug(s.members[role].name)}.md` : AUDIT_FILE);
function slug(name: string): string {
	return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

export function reviewBriefing(s: TemplateState, role: Role): string {
	const r = s.review!;
	const peer = s.members[other(role)].name;
	const common = [
		`Dokumentum-review szobában dolgozol egy másik AI-agenttel (${peer}). ${USER} (ember) bármikor beleszólhat. Magyarul válaszolj. ${PROGRESS_RULE}`,
		r.version
			? `A dokumentum verziói ebben a mappában vannak: ${s.folder} (v1.md, v2.md, …).`
			: `Nincs feltöltött dokumentum: a vizsgálandó anyagot a feladat nevezi meg (fájl a repóban, PR, issue vagy beillesztett szöveg). A javított teljes változatok ebbe a mappába kerülnek: ${s.folder} (v1.md, v2.md, …).`,
		`${USER} feladata:\n${r.prompt}`,
	].join('\n\n');
	if (role === r.reviewer) {
		return `${common}\n\nHaladási lista: te vezeted ezt a fájlt: ${path.join(s.folder, 'haladas.md')}. Egy táblázat: megállapítás | melyik körben | állapot (nyitott, javítva, lezárt) | megjegyzés. Minden kör végén frissítsd.\n\nA te szereped: REVIEWER. A dokumentumot nem írod át. Minden körben a legfrissebb verziót ellenőrzöd a feladat szerint, és azt is, hogy az előző megállapításaid lezárultak-e. Hibánál számozott, konkrét, javítható megállapítást adj: hol, mi a hiba, mi a helyes. ${REVIEW_STRICT[r.strict]} A válaszod utolsó sora pontosan ez legyen: VERDIKT: PASS vagy VERDIKT: FAIL.`;
	}
	return `${common}\n\nA te szereped: JAVÍTÓ. A reviewer megállapításai alapján javítod a dokumentumot. Minden körben a teljes új verziót abba a fájlba írd, amelyet az üzenet megad; a korábbi verziókat ne módosítsd. Válaszként rövid változástáblát adj: megállapítás → mit változtattál, vagy indoklással miért nem.`;
}

function briefOf(s: TemplateState): string {
	const c = s.code!;
	if (!c.issue) {
		return `${USER} feladata (brief):\n${c.prompt}`;
	}
	const view = /\/pull\/\d+/.test(c.issue) ? 'gh pr view' : 'gh issue view';
	const note = c.prompt ? `\n\n${USER} kiegészítése:\n${c.prompt}` : '';
	return `A brief itt van, a kommentekkel együtt: ${c.issue}\nOlvasd el most: ${view} ${c.issue} --comments\nOlvasd el újra minden új szelet előtt, és akkor is, ha a kontextusod összefoglalódott. Ami ott áll, az a mérvadó.${note}`;
}

export function codingBriefing(s: TemplateState, role: Role): string {
	const c = s.code!;
	const peerRole = other(role);
	const peer = s.members[peerRole].name;
	const coordinator = s.members[c.coordinator].name;
	const parts = [
		`Kódoló szobában dolgozol egy másik AI-agenttel (${peer}). ${USER} (ember) bármikor beleszólhat, és a döntéseket ő hozza. Magyarul válaszolj. ${PROGRESS_RULE}`,
		`Repó: ${c.repo}, alap ág: ${c.base}. A te munkafád: ${c.dirs[role]} (ág: ${c.branches[role]}); csak ebben a mappában írsz. ${peer} munkafája: ${c.dirs[peerRole]} (ág: ${c.branches[peerRole]}); azt olvashatod, de nem írod.`,
		`A munkafádban maradj, és ne válts ágat, mert az átemelés az ágad nevére épül. Commitolhatsz magad is; a [SZELET KÉSZ] jelzés a maradékot commitolja. Pusht, PR-t vagy bármit, ami a gépen kívül látszik, csak akkor csinálj, ha ${USER.toLowerCase()} kéri. Hogy ki mit csinál, azt ${USER.toLowerCase()} dönti el; ha ő mást mond, mint a kiosztás, az ő szava érvényes.`,
		`Jelzés mindig a válasz utolsó sora, pontosan így:\n- [SZELET KÉSZ]: befejeztél egy szeletet; az Arkestra commitolja a munkafádat${role === c.coordinator ? '' : `, és szól ${coordinator}-nak`}.\n- [DÖNTÉS KELL]: ${USER.toLowerCase()} döntése kell. Előtte írd le a kérdést röviden, egy példával. A szoba megvárja a válaszát.\nA jelzés nélküli válaszod a másik agenthez kerül: kérdés, egyeztetés.`,
		briefOf(s),
	];
	if (role === c.coordinator) {
		parts.push(`Haladási lista: te vezeted ezt a fájlt: ${path.join(s.folder, 'haladas.md')}. Egy táblázat: szelet | ki csinálja | fájlok | állapot (vár, folyamatban, kész, átemelve) | commit. A kiosztáskor hozd létre, és minden szelet-jelzés és átemelés után frissítsd.`);
		if (c.plan === 'approve' && c.planState !== 'approved') {
			parts.push(`Szeletterv jóváhagyásra: mielőtt bármit kiosztanál, írd meg a szelettervet a haladási listába (szeletek, ki csinálja, fájlok), és a válaszodban röviden foglald össze. Az utolsó sor: [TERV KÉSZ]. A szoba ekkor ${USER.toLowerCase()} jóváhagyására vár; ha változtatást kér, igazítsd a tervet, és újra [TERV KÉSZ]. Csak a jóváhagyás után oszd ki a szeleteket.`);
		}
		const end = [c.test && `A [KÉSZ] után az Arkestra lefuttatja a tesztparancsot a munkafádban (${c.test}); ha nem zöld, a kimenetet visszakapod javításra.`, c.verify && `Utána ${peer} függetlenül ellenőrzi a teljes változást a briefhez képest; ha hibát talál, visszakapod.`].filter(Boolean);
		if (end.length) {
			parts.push(`A munka vége: ${end.join(' ')}`);
		}
		parts.push(`A te szereped: KOORDINÁTOR. Bontsd a feladatot szeletekre úgy, hogy a te szeleteid és ${peer} szeletei ne nyúljanak ugyanazokhoz a fájlokhoz. A szeletek egy részét te csinálod, a másikat ${peer}. A kiosztó üzenet utolsó sora: [KIOSZTÁS]. Ez megy ${peer}-nak, és utána a saját szeleteiden dolgozol.\nHa ${peer} jelzi, hogy kész, nézd át a kódját a munkafádból: git diff ${c.branches[role]}...${c.branches[peerRole]}. Nagyobb hibát küldj vissza neki jelzés nélkül. Ha rendben van, az utolsó sor: [ÁTEMELÉS]. Az Arkestra ekkor beolvasztja a ${c.branches[peerRole]} ágat a ${c.branches[role]} ágba. Apróbb hibát ezután a saját munkafádban javíts. Ütközésnél az Arkestra megírja a fájlokat: oldd fel őket a munkafádban, és újra [ÁTEMELÉS].\nHa minden szelet kész és át van emelve, a záró válaszod utolsó sora: [KÉSZ].`);
	} else {
		parts.push(`A te szereped: VÉGREHAJTÓ. A koordinátor (${coordinator}) osztja ki a szeleteidet. Csak a kiosztott szeleteken dolgozz, csak a saját munkafádban. Ha valami nem világos vagy ütközne, kérdezz jelzés nélkül.`);
	}
	return parts.join('\n\n');
}

export const AUDIT_METHOD = `Ez mélyreható, teljes kód audit. A cél: a repó minden valódi hibája és kockázata előkerüljön, bizonyítékkal, mindenre kiterjedően.

Módszer:
1. Térkép. Először olvasd el a repó saját szabályait és leírásait (AGENTS.md, CLAUDE.md, README, PROJECT_STATE vagy hasonló, docs/). Térképezd fel a szerkezetet: modulok, belépési pontok, adatfolyamok, külső kapcsolatok (API-k, adatbázis, fájlrendszer, hálózat, más szolgáltatások), konfiguráció, build, CI és deploy.
2. Teljes lefedés. Minden forrásfájlt nézz át, ne mintát. A kockázatos részeket soronként: pénz és számítás, jogosultság és belépés, adatírás és törlés, állapotgépek, párhuzamosság, külső bemenet.
3. Területek; mindegyiket külön vizsgáld:
   - Helyesség és logika: hibás feltételek, határesetek, üres és hiányzó értékek, idő és időzóna, kerekítés, hibás állapotátmenetek, elérhetetlen vagy holt ágak.
   - Hibakezelés: elnyelt vagy félrevezető hibák, részleges írás, újrapróbálás és idempotencia, időtúllépés, visszaállás.
   - Biztonság: bemenet-ellenőrzés, injection (SQL, shell, útvonal, template), hitelesítés és jogosultság, titkok a kódban, logban vagy a repóban, fájl- és folyamatjogok, CSRF, XSS, SSRF ahol számít, a függőségek ismert sérülékenységei.
   - Párhuzamosság és állapot: versenyhelyzet, zárak, újraindítás utáni állapot, tartósság, egyszerre futó példányok.
   - Adat: séma és migrációk, adatvesztés, konzisztencia, megőrzés és törlés.
   - Teljesítmény és erőforrás: felesleges vagy ismételt munka, N+1, szivárgás (fájl, socket, memória, folyamat), korlátlan növekedés.
   - Interfészek és szerződések: a hívók és a hívottak egyezése, típusok, verziók, a dokumentált és a valódi működés eltérése.
   - Konfiguráció és üzemeltetés: alapértékek, környezeti változók, build, CI, deploy, logolás, megfigyelhetőség, visszaállíthatóság.
   - Tesztek: mely kockázatos részek nincsenek lefedve, mely tesztek hibásak, vagy nem ellenőriznek semmit.
   - Karbantarthatóság: duplikáció, holt kód, félrevezető név vagy komment, de csak ha valódi hibát vagy kockázatot okoz.
4. Bizonyítás. Minden megállapítást ellenőrizz a kódban, és ahol lehet, futtatással is: tesztek, a program, egy kis próba a munkafádban, amit utána törölsz. Ellenőrizetlen állítást ne írj le. Ami csak gyanú, azt jelöld „feltételezés”-ként, és írd mellé, mi döntené el.
5. Ne állj meg az első találatnál. Ha hibát találsz, keresd ugyanazt a mintát a repó többi részén is.

Súlyosság:
- P0 kritikus: adatvesztés, biztonsági rés, pénzügyi kár, éles leállás vagy összeomlás.
- P1 súlyos: a fő működés hibás, vagy rendszeresen elromlik.
- P2 közepes: határeset, ritka hiba, komoly karbantartási kockázat.
- P3 kisebb: apró hiba, következetlenség, olvashatóság.

Az audit dokumentum Markdown, ebben a felépítésben:
1. Összefoglaló: a repó állapota néhány mondatban, és a megállapítások száma súlyosság szerint (P0, P1, P2, P3).
2. Lefedettség: mely területeket és fájlokat vizsgáltad, mit futtattál, és mit nem tudtál ellenőrizni, miért.
3. Megállapítások súlyosság szerint, mindegyik így:
   ### F<sorszám> · P<0–3> · <rövid cím>
   - Hely: fájl:sor (több is lehet)
   - Hiba: mi a rossz
   - Bizonyíték: a kódrészlet vagy a futtatás eredménye
   - Hatás: konkrét forgatókönyv, mikor és mi romlik el
   - Javítás: mit és hol kell változtatni
   - Ráfordítás: kicsi, közepes vagy nagy
4. Ami rendben van: röviden, mely kockázatos részek bizonyultak jónak.

Légy tárgyilagos és pontos: valódi hibák kellenek, nem ízlésvita. Egy megállapítás egy hiba; ugyanaz a hiba több helyen egy megállapítás, több hellyel.`;

export function auditBriefing(s: TemplateState, role: Role): string {
	const a = s.audit!;
	const c = s.code!;
	const peerRole = other(role);
	const peer = s.members[peerRole].name;
	const lead = s.members[a.lead].name;
	const parts = [
		`Kód audit szobában dolgozol egy másik AI-agenttel (${peer}). ${USER} (ember) bármikor beleszólhat, és a döntéseket ő hozza. Magyarul válaszolj. ${PROGRESS_RULE}`,
		`Repó: ${c.repo}, alap ág: ${c.base}. A te munkafád: ${c.dirs[role]}; ebben olvasol és futtatsz. Az audit alatt a kódot nem módosítod, nem commitolsz és nem pusholsz. Egyetlen fájlt írsz: az audit dokumentumot.`,
		AUDIT_METHOD,
		a.since
			? `Hatókör: csak a ${c.base} ág változásai a(z) ${a.since} óta. A változásokat így látod a munkafádban: git diff ${a.since}...HEAD (és git log ${a.since}..HEAD). Ez felülírja a „teljes lefedés” pontot: minden megváltozott fájlt teljesen nézz át, és azt is, mire hatnak a változások a repó többi részén (hívók, adatok, konfiguráció); a változatlan és nem érintett részeket nem kell átnézned.`
			: 'Hatókör: a teljes repó.',
		a.focus ? `${USER} külön kérése (az audit mellett erre is figyelj):\n${a.focus}` : 'Nincs külön fókusz: a hatókörön belül minden területet vizsgálj.',
		`Haladási lista: az audit elején hozd létre ezt a fájlt: ${progressFile(s, role)}. Egy táblázat: terület | állapot (vár, folyamatban, kész) | megjegyzés; a sorok a térkép és a fenti tíz terület. Minden terület után frissítsd.`,
	];
	if (a.auditors === 'both') {
		parts.push(`Két független audit készül: te és ${peer} külön, egymástól függetlenül. A te dokumentumod: ${auditFile(s, role)}. ${peer} dokumentumát (${auditFile(s, peerRole)}) az összevetésig ne olvasd, és vele se egyeztess.`);
		parts.push(role === a.lead
			? `Te vagy a VEZETŐ AUDITOR. Ha mindkét audit kész, az Arkestra szól, és te veted össze a kettőt egy közös dokumentumba; ${peer} azt ellenőrzi.`
			: `A vezető auditor ${lead}. Ha mindkét audit kész, ő veti össze a kettőt egy közös dokumentumba, és te ellenőrzöd.`);
	} else {
		parts.push(`Te auditálsz, egyedül; te vagy a VEZETŐ AUDITOR. A dokumentum: ${auditFile(s, role)}.`);
	}
	if (a.goal === 'fix') {
		const how = a.fix === 'auto' ? `utána rögtön javítás jön: ${AUDIT_LEVELS[a.levels ?? 'P1']}` : `utána ${USER.toLowerCase()} jóváhagyja, mit kell javítani, és csak azt javítjátok`;
		parts.push(`Az audit után ${how}. A javítást a vezető auditor (${lead}) irányítja: a megállapításokat szeletekre bontja, és a szeletek egy részét a másik agent kapja.`);
	}
	parts.push(`Jelzés mindig a válasz utolsó sora, pontosan így:\n- [AUDIT KÉSZ]: az audit dokumentumod kész és a helyén van.\n- [DÖNTÉS KELL]: ${USER.toLowerCase()} döntése kell. Előtte írd le a kérdést röviden, egy példával.`);
	return parts.join('\n\n');
}

/** The other agent of a one-auditor audit gets this until the fix starts. */
export function auditBystanderBriefing(s: TemplateState, role: Role): string {
	const lead = s.members[s.audit!.lead].name;
	return `Kód audit szobában vagy egy másik AI-agenttel (${lead}). Az auditot ${lead} egyedül készíti; te a javításnál kapsz feladatot, ha lesz javítás. Addig nincs teendőd. Magyarul válaszolj.\n\nRepó: ${s.code!.repo}, a te munkafád: ${s.code!.dirs[role]}.`;
}

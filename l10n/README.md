# Arkestra nyelvek

A felület angolul és magyarul érhető el. A magyar szövegek a beépített `extensions/arkestra-language-pack-hu` nyelvi csomagban vannak: a VS Code-mag, a beépített bővítmények és az Arkestra saját bővítményei egy helyen. A felület nyelve az operációs rendszer nyelvét követi, és a **Configure Display Language** paranccsal bármikor váltható (újraindítás után érvényes).

## Hol mi van

- `l10n/hu/core.json`: a mag fordítása, modulonként és kulcsonként.
- `l10n/hu/extensions.json`: a bővítmények fordítása (`package`: a package.nls.json kulcsai, `bundle`: a `vscode.l10n.t` szövegei).
- `l10n/hu/GLOSSARY.md`: szójegyzék és stílus.
- `l10n/hu/LICENSE-vscode-loc.txt`: a régi közösségi magyar csomag (microsoft/vscode-loc-deprecated, MIT) licence; a fordítások egy része onnan származik.

## Frissítés

```bash
node scripts/l10n/extract.cjs build/work/vscode build/l10n/en.json
node scripts/l10n/pack.mjs build/l10n/en.json --check
```

Az `extract.cjs` a felkészített forrásfából kigyűjti az összes angol szöveget. A `pack.mjs` ebből és a katalógusból megírja a nyelvi csomagot. Csak a forrásban még meglévő kulcsok kerülnek bele, és az a fordítás, amelynek helyőrzői eltérnek az angoltól, kimarad. A lefordítatlan szöveg futás közben angolul jelenik meg. A `--check` hibával lép ki, ha valami kimaradt, vagy az Arkestra saját szövegeiből hiányzik fordítás.

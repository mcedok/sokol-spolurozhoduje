# AGENTS.md — Sokol spolurozhoduje

Tento soubor je hlavní vstupní kontext pro další práci v repozitáři. Platí pro
celý strom, pokud podadresář neobsahuje vlastní přesnější `AGENTS.md`.

## Jazyk a způsob spolupráce

- S uživatelem komunikuj česky, stručně a rozhodovacím způsobem.
- Nezačínej návrh od nuly. Nejdřív prohlédni existující kód, specifikace,
  implementační plány, provozní návody a aktuální `git status`.
- Zachovávej již schválená produktová rozhodnutí. Při rozporu má přednost
  pozdější explicitní rozhodnutí uživatele, potom schválená specifikace a až
  potom starší prototyp.
- Rozlišuj browserovou demoverzi od produkční serverové aplikace. Úspěch jedné
  varianty není důkazem funkčnosti druhé.
- Nevydávej etapu za dokončenou pouze podle existence kódu, starého reportu,
  lokálního buildu nebo dílčích testů. Dokončení vyžaduje čerstvé odpovídající
  testy, buildy, smoke scénáře a kontrolu pracovního stromu.
- Když uživatel stanoví limit tokenů nebo požádá o pozastavení, ukonči práci na
  bezpečné hranici, odstraň jen vlastní dočasné prostředky a přesně zaznamenej,
  co zbývá ověřit.

## Cíl produktu

Vyvíjíme open-source platformu „Sokol spolurozhoduje“ pro transparentní
připomínkování interních norem a dokumentů České obce sokolské.

Základní tok:

1. Administrátor založí číslovaný dokument, uvede předkladatele, odpovědnou
   osobu a důvodovou zprávu.
2. Nahraje DOCX; originál se neměnně archivuje.
3. Worker dokument bezpečně zkontroluje, převede do strukturované webové podoby
   a rozdělí jej na stabilně identifikované komentovatelné bloky.
4. Administrátor zkontroluje náhled a dokument zveřejní.
5. Ověření členové komentují konkrétní bloky, odpovídají ve vláknech, podávají
   návrhy a hlasují.
6. Administrátor připomínky vypořádá a proces uzavře.
7. Zůstanou zachované verze, auditní stopa a veřejné či interní exporty.

Kapacitní předpoklad pro první tři roky je řádově do 10 000 uživatelů. Návrh má
být produkčně použitelný, ale nemá předčasně zavádět distribuovanou složitost.
Veřejné integrační API není v první produkční fázi potřeba; interní aplikační
rozhraní může zůstat součástí jednoho modulárního systému, dokud nevznikne
konkrétní externí napojení.

## Závazná produktová rozhodnutí

### Transparentnost a soukromí

- Seznam norem a jejich veřejný obsah jsou standardně dostupné bez přihlášení.
- Aktivní účast je vždy svázána s ověřenou e-mailovou adresou.
- Architektura má umožnit budoucí volitelný režim „veřejný jen název, detail až
  po přihlášení“, ale tento režim nyní není výchozí.
- Důvěrné připomínky se nepodporují. Připomínky jsou transparentní.
- E-mail, členské ID a ostatní interní identifikátory nejsou veřejné a nesmějí
  se objevit ve veřejném API, veřejném PDF, pracovním XLSX ani veřejném auditu.
- Veřejný export může používat zobrazované jméno a organizaci podle schváleného
  publikačního modelu, nikdy však interní technické identifikátory.

### Role a oprávnění

Používají se pouze role bez individuálních výjimek:

- `member`: registruje se sám; po ověření e-mailu může komentovat, odpovídat,
  navrhovat změny a hlasovat.
- `admin`: vytváří dokumenty a soubory, spravuje pouze dokumenty, které vlastní,
  řídí připomínkování, vypořádává připomínky a dokument uzavírá.
- `superadmin`: vytváří administrátory, spravuje role a stavy uživatelů, může
  převádět vlastnictví a spravuje všechny dokumenty.

Ve workflow není samostatná role garanta ani moderátora. Za dokument, jeho
vypořádání a uzavření odpovídá administrátor. Server musí oprávnění, aktivní
stav účtu, relaci a vlastnictví kontrolovat při každé změnové operaci; skryté
tlačítko nebo údaj zaslaný klientem nikdy není autoritou.

### Přihlášení

- Člen nemá heslo. Při registraci i každém dalším přihlášení dostane nový
  šestimístný jednorázový kód na e-mail.
- Členské ID se může evidovat, ale není nyní automaticky ověřováno proti
  `sokol.cz` a registraci neschvaluje superadministrátor.
- Administrátor a superadministrátor používají nastavitelné heslo; pozvaný
  správce má bezpečný tok prvního nastavení a obnovy hesla.
- Produkční správci používají Argon2id, TOTP MFA, rotované serverové relace a
  bezpečné `HttpOnly` cookies. Browserové PBKDF2 a simulovaná schránka jsou jen
  demoverze.
- Demo přístupové údaje smějí být veřejné pouze v jasně označené demoverzi.
  Nikdy je nepřenášej do produkční konfigurace nebo tajemství.

### Dokumenty a připomínky

- Číslo dokumentu má formát `SOKOL-RRRR-NNN` a v produkci se přiděluje
  transakčně.
- Dokument obsahuje název, důvodovou zprávu, předkladatele, odpovědnou osobu,
  termíny a stav.
- Komentář se váže ke stabilnímu bloku, ne ke stránce dokumentu.
- Komentáře podporují vlákna, odpovědi, zmínky, přílohy, historii úprav,
  administrátorský zásah a úplnou auditní stopu.
- Připomínka eviduje minimálně ID, autora, organizaci, datum, text, typ,
  prioritu, stav, stanovisko administrátora, odpovědnou osobu, datum
  vypořádání a verzi zapracování.
- Hlasování a nové komentáře jsou povoleny jen v odpovídající otevřené fázi.
  Uzavřený nebo archivovaný dokument nesmí přijímat nové hlasy ani připomínky.
- Vypořádání zachovává historii; starý záznam se zneaktivní, nepřepisuje ani
  nemaže.

## Dvě provozní varianty

### Browserová demoverze

Slouží k ověření informační architektury a uživatelských scénářů. Používá
`localStorage`, `sessionStorage` a IndexedDB. Není víceuživatelská, není
bezpečnostní hranicí a nesmí být označena za produkční systém.

### Produkční serverová varianta

Modulární Next.js aplikace používá PostgreSQL, objektové úložiště, samostatný
Java worker, ClamAV, transakční outbox a neměnný hashovaný audit. Server určuje
identitu a oprávnění. Soubory se nejprve ukládají do karantény a asynchronní
operace používají odolné fronty, lease, fencing tokeny, idempotenci, retry s
backoffem a terminální stav po vyčerpání pokusů.

Výchozí stack:

- Next.js 16, React 19, TypeScript a Vitest;
- PostgreSQL;
- Java 21 worker a Apache POI pro DOCX/XLSX;
- objektové úložiště kompatibilní s Azure Blob Storage, lokálně Azurite;
- ClamAV;
- Docker Compose lokálně, produkční Docker image jako neprivilegovaný uživatel.

## DOCX převod a stabilní bloky

- Originální DOCX se vždy archivuje a nikdy se při retry nemaže ani nepřepisuje.
- Zachovat nadpisy, odstavce, číslované seznamy, odrážky, tabulky, zvýraznění a
  odkazy.
- Komplikovanou tabulku lze převést do HTML, ponechat jako samostatnou přílohu
  nebo vyrenderovat jako obrázek; zvolená reprezentace musí mít existující a
  připravené aktivum před zveřejněním.
- Převod vytváří interní strukturované AST a bloky se stabilním identifikátorem,
  pořadím a hranicemi.
- Administrátor před zveřejněním kontroluje náhled, opravuje strukturální
  hranice a explicitně potvrzuje připravenost.
- Nová verze dokumentu vytváří nové bloky a explicitní mapování na předchozí
  verzi. Starší pomalejší worker nesmí regresovat stav novější verze.

Podrobný návrh a plán jsou v:

- `docs/superpowers/specs/2026-08-17-docx-ingestion-conversion-preview-design.md`
- `docs/superpowers/plans/2026-08-17-docx-ingestion-conversion-preview.md`

## Verze a PDF exporty — Etapa C

- Historie všech verzí a mapování bloků zůstává zachována.
- Připomínky se do nové verze projektují pouze přes explicitní mapování.
- Export vzniká z neměnného snapshotu, ne z průběžně měněných řádků.
- Veřejné PDF je dostupné oprávněným uživatelům, obsahuje titulní stranu,
  statistiku, připomínky, stanoviska a stav vypořádání, ale žádné interní údaje.
- Interní PDF smí vytvořit administrátor a může obsahovat explicitně povolené
  interní údaje.
- PDF musí projít PDF/A validací, kontrolou textové vrstvy a vizuální kontrolou
  vyrenderovaných stran.

Etapa C byla čerstvě ověřena v samostatném checkpointu popsaném v
`docs/verification/2026-08-19-stage-c-verification.md`. Při dalších zásazích do
jejího kódu je nutné její brány zopakovat.

## Pracovní XLSX — Etapa D

XLSX je neveřejný pracovní vypořádací formulář pro administrátora. Zachovává se
i běžný export připomínek; zpětný import je bezpečné rozšíření, ne náhrada PDF.

### Export

- Maximálně 1 000 pracovních řádků a 25 MiB.
- Sešit obsahuje systémová uzamčená pole, editovatelná pole, číselníky,
  validace, filtry, statistiky a podmíněné formátování.
- Manifest je podepsaný, váže export na dokument, verzi, snapshot, stabilní
  mapování řádků, čas vytvoření, verzi číselníků a key ID.
- Podpisový secret se vybírá podle key ID; rotace musí podporovat retenční
  ověřovací klíče.
- E-mail ani členské ID se do pracovního sešitu nevkládají.

### Import a třícestné porovnání

- Celý multipart request se musí bezpečně dokončit před přijetím souboru do
  doménového workflow; chyba další části nesmí vytvořit „ghost import“.
- Upload jde do karantény, prochází ClamAV, kontrolou MIME, ZIP/OOXML limitů,
  externích vztahů, maker, custom XML, manifestu, podpisu a vzorců v
  editovatelných buňkách.
- Třícestné porovnání používá exportní snapshot, hodnotu z XLSX a aktuální
  databázi. Rozlišuje beze změny, bezpečnou změnu, již aktuální hodnotu,
  konflikt a neplatný řádek.
- Konflikt se řeší po celém řádku volbou `keep_system` nebo `use_xlsx`.
  Klasifikace konfliktu se při rozhodnutí nepřepisuje.
- Bezpečné změny se po validaci aplikují automaticky serverovou atomickou fází;
  UI pouze sleduje průběh a nabídne bezpečný retry.
- Aplikace kontroluje databázové `row_version` komentáře i vypořádání. Jediný
  zastaralý nebo konfliktní řádek vrací celou dávku zpět.
- Rozhodnutí, safe apply i retry jsou idempotentní, transakční a auditované.

### Odolnost workeru

- Stav automatického safe callbacku musí být uložen v DB, reclaimovatelný po
  pádu a chráněný vlastním fencing tokenem.
- Callback nesmí používat časově zastaralou uživatelskou relaci jako trvalou
  interní autoritu. Oprávnění a vlastnictví se přesto znovu ověřují.
- Selhání používá exponenciální backoff, omezený počet pokusů a terminální stav;
  trvale chybující dávka nesmí vytvořit hot loop ani vyhladovět další importy.
- Normální importní job má stejnou zásadu omezených pokusů a terminálního
  auditu.
- Safe fáze smí běžet jen ve správném stavu a nesmí se znovu spustit po přechodu
  do `awaiting_resolution`.

Podrobnosti:

- `docs/superpowers/specs/2026-08-19-working-xlsx-import-design.md`
- `docs/superpowers/plans/2026-08-19-working-xlsx-import.md`
- `docs/operations/working-xlsx.md`

## Audit, souběh a mazání

- Doménová změna a audit/outbox se zapisují v jedné databázové transakci.
- Audit je append-only, lineárně řazený a hashovaný. Databáze musí odmítnout
  změnu nebo smazání historické události.
- Auditní metadata nesmějí obsahovat hesla, hashe hesel, soli, jednorázové kódy,
  tokeny, celé session bearery ani neveřejné osobní údaje.
- Každá změna oprávnění, odmítnutá privilegovaná operace, workerová fáze,
  rozhodnutí konfliktu a aplikace řádku má dohledatelnou auditní událost.
- Pro souběžné operace používej databázové zámky, verze řádků, unikátní
  constrainty, idempotency keys a fencing tokeny. Široké `ON CONFLICT DO
  NOTHING` nesmí potichu zahodit doménový blok nebo změnu.
- Materiální soubor nemaž před commitnutím autoritativní změny. Úklid derivátů
  je best-effort; archivovaný originál je neměnný.

## Etapy projektu

- **Etapa A — serverový základ:** PostgreSQL, identity, role, relace, Argon2id,
  TOTP MFA, audit, outbox, Docker a health endpointy.
- **Etapa B — DOCX a blokové připomínkování:** bezpečný upload, archivace,
  převod, stabilní bloky, náhled a zveřejnění.
- **Etapa C — verze a exporty:** mapování bloků, projekce vláken, neměnné
  snapshoty, veřejné a interní PDF/A.
- **Etapa D — pracovní XLSX:** chráněný export, bezpečný upload a třícestné
  porovnání, konflikty, transakční aplikace a audit.
- **Etapa E — produkční připravenost:** CI/CD, správa tajemství, staging,
  monitoring, zálohy, obnova, zátěžové a bezpečnostní testy a řízený pilot.

Úplný produkční návrh, ER model a pořadí balíčků jsou v
`docs/superpowers/specs/2026-08-16-production-document-consultation-architecture-design.md`.

## Aktuální checkpoint — 24. 8. 2026

- Aktivní pracovní větev: `codex/xlsx-working-import` v linked worktree
  `.worktrees/user-access-administration`.
- Poslední commit před rozpracovanou opravnou vlnou je `3be7114`.
- Pracovní strom obsahuje rozsáhlé necommitnuté opravy Etapy D. Nezahazuj je,
  neobnovuj soubory z HEAD a nepoužívej `git reset --hard` ani `git checkout --`.
- Opravy pokrývají mimo jiné bezpečný multipart upload, row-version kontrolu,
  keyring podpisů, worker lease/fencing/heartbeat, stránkování UI, auditní
  integritu a odolný safe callback s backoffem a omezením pokusů.
- Lokální `sokol_test` byl 24. 8. 2026 výslovně ověřen, vyprázdněn a nově
  migrován. Migrace `0001` až `0012` prošly a tabulka `xlsx_import_batches`
  obsahuje nové sloupce lease, safe callback tokenu, backoffu a počtu pokusů.
- Cílená XLSX sada prošla: 5 Vitest souborů / 27 testů a 4 Java testovací třídy
  / 8 testů bez selhání.
- Čerstvá kompletní sada po poslední opravné vlně prošla 24. 8. 2026: 53 Vitest souborů /
  322 testů a 63 Java testů bez selhání. Prošly také `pnpm typecheck`,
  browserový `pnpm build` a serverový `pnpm build:server`.
- Čerstvý browserový smoke prošel 39 kontrolami bez browser/resource chyb a s
  úplným cleanupem. Serverový produkční Docker smoke prošel 70
  kontrolami včetně reálného XLSX exportu, stažení, editace, uploadu,
  automatického safe apply, auditu, RBAC a uvolnění portu.
- `docs/verification/2026-08-19-stage-d-verification.md` obsahuje aktuální
  finální výsledky současného pracovního stromu.
- Poslední review doplnilo terminální stav i pro opakované pády workeru během
  durable safe callbacku a oddělilo interní callback od stáří původní webové
  relace při zachování živé kontroly role, účtu, vlastnictví a stavu dokumentu.
- Pracovní XLSX používá pojmenované rozsahy číselníků a obsahuje výslovnou
  legendu uzamčených/editovatelných polí i zalamování dlouhého textu.
- Dočasná databáze `sokol_stage_d_migration_test` byla po práci odstraněna.
  Lokální kontejnery PostgreSQL, Azurite a ClamAV zůstaly zdravé a spuštěné.
- Nebyl vytvořen nový commit, push ani pull request pro poslední opravnou vlnu.

### Bezprostřední další kroky

1. Zaznamenej `git status` a ověř přesný diff; zachovej všechny existující
   změny.
2. Ověř `git diff --check`, přesný rozsah změn a že v diffu nejsou tajemství ani
   generované artefakty.
3. Připrav commit a následně autorizovaný push a pull request se shrnutím
   migrací, bezpečnostních invariantů a čerstvých ověřovacích výsledků.

## Povinné ověřovací brány

Po změně produkčního kódu spusť přiměřeně nejprve cílené testy a před tvrzením
o dokončení celý relevantní gate:

```powershell
pnpm test
pnpm typecheck
$env:NEXT_PUBLIC_DATA_BACKEND='browser'; pnpm build
pnpm build:server
pnpm smoke:access
$env:SMOKE_ALLOW_DATABASE_RESET='RESET_LOCAL_SOKOL_TEST'; pnpm smoke:server
git diff --check
```

Worker ověř kompletními Maven testy v podporovaném Java 21 prostředí; pokud na
hostiteli není Maven, použij zamčený Maven Docker image. Migrace ověř na nové
prázdné jednorázové PostgreSQL databázi, ne pouze na již migrovaném schématu.

Smoke server smí resetovat pouze lokální databázi přesně pojmenovanou
`sokol_test` a jen s explicitní ochrannou hodnotou
`SMOKE_ALLOW_DATABASE_RESET=RESET_LOCAL_SOKOL_TEST`. Nikdy ji nepřenášej na
produkční nebo nejasnou databázi.

Pro PDF navíc vyžaduj PDF/A validaci, kontrolu úniku interních údajů v textové
vrstvě a vizuální kontrolu všech vyrenderovaných stran. Pro XLSX vyžaduj reálný
end-to-end průchod export → stažení → editace → multipart upload → kontrola →
automatický safe apply → konflikty → audit, včetně restart/reclaim a stale-row
scénářů.

## Lokální prostředí

- Produkční serverový návod: `docs/operations/local-server.md`.
- Docker Compose: `infra/local/compose.yaml`.
- Výchozí testovací PostgreSQL běží lokálně na portu `55432`.
- Health endpointy: `/api/health/live` a `/api/health/ready`.
- Tajemství patří do `.env.local` nebo produkčního správce tajemství. Nikdy je
  necommituj ani nevypisuj do logu.
- Bootstrap prvního superadministrátora používej jen na čisté instalaci; token
  se zapisuje do chráněného souboru a po bezpečném předání se odstraní.
- Na Windows může Git hlásit `dubious ownership`. Pro read-only kontrolu použij
  per-command `git -c safe.directory='<přesná cesta>' ...`; neměň kvůli tomu
  globální konfiguraci uživatele.

## Práce se soubory a Gitem

- Existující změny patří uživateli. Neupravuj nesouvisející soubory a nikdy je
  bez výslovného pokynu nemaž.
- Pro ruční změny používej `apply_patch`; mechanické formátování může použít
  projektový formátovací nástroj.
- Nevkládej do commitu generované artefakty, dočasné databáze, profily Chrome,
  lokální `.env` ani tajemství.
- Stage, commit, push, vytvoření PR, merge a nasazení jsou oddělené kroky.
  Prováděj je jen v rozsahu výslovně schváleném uživatelem.
- Před commitem ukaž rozsah změn, spusť čerstvé brány a ověř, že worktree
  neobsahuje cizí nebo dočasné soubory.
- PR musí uvést produktový rozsah, migrace, bezpečnostní invarianty, testovací
  důkazy, známá omezení a rollback/migrační postup. Neuváděj staré výsledky jako
  čerstvé.
- Automaticky nemerguj ani nenasazuj.

## Zdroj pravdy

Při práci používej tento pořádek:

1. pozdější explicitní rozhodnutí uživatele;
2. tento `AGENTS.md` pro trvalá pravidla a aktuální checkpoint;
3. schválené návrhy v `docs/superpowers/specs/`;
4. implementační plány v `docs/superpowers/plans/`;
5. provozní návody v `docs/operations/`;
6. čerstvě ověřený kód, migrace a testy;
7. verification reporty pouze jako historický důkaz konkrétního commitu nebo
   pracovního stromu, nikoli jako automaticky aktuální pravdu.

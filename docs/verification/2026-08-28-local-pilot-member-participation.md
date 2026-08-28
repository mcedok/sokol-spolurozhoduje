# Ověření lokálního pilotu — členský detail a blokové připomínkování

Datum: 28. 8. 2026
Větev: `codex/local-pilot`
Pracovní strom: necommitnutý, se zachovanými dřívějšími změnami lokálního pilotu

## Ověřený rozsah

- přihlašovací rozcestník pro registrovaného a nového člena;
- člen bez hesla s novým šestimístným e-mailovým kódem;
- administrátor pouze s heslem, superadministrátor s heslem a TOTP;
- veřejný detail zveřejněné normy s převedenými a stabilně označenými bloky;
- komentář a návrh změny navázaný na konkrétní blok;
- odpovědi ve vlákně, hlasování o podnětu a hlasování o potřebnosti normy;
- bezpečné obnovení CSRF po reloadu platné relace;
- autentizované stažení archivovaného originálního DOCX;
- audit, idempotence a optimistické řízení souběhu participačních změn;
- nasazení migrace `0013_comment_participation.sql` do zachovaného pilotního volume.

## Čerstvé výsledky

- `pnpm test`: 58 souborů, 368 testů, 0 selhání;
- `pnpm typecheck`: bez chyb;
- browserový produkční build: dokončen;
- serverový produkční build: dokončen;
- Java/Maven worker: 28 sad, 63 testů, 0 selhání;
- migrace na nové prázdné jednorázové databázi: 13 migrací, dokončeno; databáze poté odstraněna;
- `pnpm smoke:access`: 39 kontrol, bez chyb prohlížeče a zdrojů;
- serverový Docker smoke: 76 kontrol včetně `login → reload → obnova CSRF → bloková připomínka → hlasování`, XLSX a PDF;
- `pnpm pilot:status`: `ready`;
- `pnpm pilot:smoke-ui`: bootstrap 200, přihlašovací dialog dostupný, žádné chyby prohlížeče ani zdrojů;
- `git diff --check`: bez chyb (pouze informativní upozornění Windows na budoucí převod LF/CRLF).

## Stav pilotu

Pilot běží na `http://127.0.0.1:3000`. Databázový a souborový volume nebyl při
restartu odstraněn. Nebyl vytvořen commit, push ani pull request.

## Mimo tento balíček

Uživatelské přílohy komentářů, zmínky, historie editací komentářů a plné
administrační vypořádání zůstávají samostatným navazujícím rozsahem. Datový
základ pro audit a vypořádání tímto balíčkem nebyl odstraněn.

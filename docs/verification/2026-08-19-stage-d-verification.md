# Ověření etapy D – pracovní XLSX

Aktualizováno: 2026-08-24

## Výsledek

Balíčky 14–16 jsou propojené od vytvoření pracovního exportu přes bezpečný import až po transakční použití změn a rozhodnutí konfliktů. Původní kontrola checkpointu odhalila integrační a bezpečnostní mezery; tyto mezery jsou v aktuální větvi opravené a níže uvedené kontroly jsou čerstvě zelené.

## Čerstvé ověření

- `pnpm test`: **53 souborů / 322 testů PASS**;
- kompletní Maven testy workeru v `maven:3.9.11-eclipse-temurin-21`: **63 testů PASS**, 0 failures/errors/skipped;
- `pnpm typecheck`: **PASS**;
- `NEXT_PUBLIC_DATA_BACKEND=browser pnpm build`: **PASS**;
- `pnpm build:server`: **PASS**;
- migrace `0001`–`0012` na nové prázdné PostgreSQL databázi: **PASS**, včetně lineárního pořadí a append-only triggeru auditu;
- `pnpm smoke:access`: **39 kontrol PASS**, žádné chyby prohlížeče ani zdrojů, cleanup portů, procesů a profilu PASS;
- `SMOKE_ALLOW_DATABASE_RESET=RESET_LOCAL_SOKOL_TEST pnpm smoke:server`: **70 kontrol PASS** proti produkčním app/operations/worker Docker image; zahrnuje migrace, autorizaci, audit, reálný XLSX export → stažení → změnu → plně ověřený multipart upload → automatickou aplikaci a cleanup;
- `git diff --check`: **PASS**.

## Ověřený rozsah

- export vytváří neměnný snapshot bez e-mailu a členského ID;
- worker generuje chráněný `.xlsx` s podepsaným manifestem včetně času a verze číselníků, pojmenovanými číselníky, validacemi, legendou uzamčených/editovatelných polí, zalamováním textu, podmíněným formátováním a statistikami podle stavu, výsledku, typu i priority;
- hotový pracovní export lze stáhnout oprávněným administrátorem;
- upload je streamovaný s tvrdým limitem velikosti a maximálně 1 000 pracovními řádky, ukládá se do karantény a prochází ClamAV, limity ZIP/OOXML a kontrolou externích vztahů;
- worker import na pozadí ověří podpis a vazbu manifestu, archivuje originál a naplní staging i historii jednotlivých fází;
- OOXML parser čte listy eventově, odmítá vzorce v editovatelných buňkách a omezuje délku buňky i souhrnný text napříč sešitem;
- manifest podepisuje key ID a stabilní mapování řádků; worker přijímá aktuální i retenční ověřovací klíče;
- třícestné porovnání rozlišuje bezpečné změny, konflikty a neplatné řádky;
- bezpečné změny a rozhodnutí konfliktů používají kontrolu verzí komentáře i vypořádání, idempotenci, zámky a jedinou transakci; při zastaralém řádku se celá dávka vrátí zpět;
- automatický callback bezpečné fáze je uložený v databázi, reclaimovatelný po pádu a chráněný stabilním idempotency klíčem; worker používá fencing token, exponenciální backoff, konečný počet pokusů a heartbeat lease;
- důvěryhodný callback workeru není závislý na stáří původní interaktivní relace, ale při aplikaci vždy znovu ověří aktuální roli, aktivní účet, vlastnictví a stav dokumentu;
- klasifikace konfliktu zůstává neměnná, rozhodnutí `keep_system` a `use_xlsx` jsou auditovatelná;
- historie změn stavu, typu, priority a vypořádání je neměnná a vazby na revize se ukládají k aplikovanému řádku; workerové fáze i jednotlivé aplikace jsou součástí lineárního, databázově append-only hashovaného auditu;
- administrátorské UI podporuje export, stažení, upload, průběh dávky, automatické použití bezpečných změn, stránkování všech konfliktů, zobrazení neplatných řádků, třícestné rozhodnutí konfliktů, zrušení čekající dávky i bezpečný retry selhané dávky;
- veřejný PDF export vybírá pouze aktivní vypořádání.

## Provozní poznámka

Pro reálné prostředí musí být `XLSX_MANIFEST_KEY_ID` a `XLSX_MANIFEST_SECRET` načtené ze správce tajemství a pravidelně rotované. Hodnoty v lokálním Docker Compose jsou výhradně vývojové. Před ostrým nasazením se stejné brány zopakují v CI a stagingu s produkčně ekvivalentním object storage, ClamAV a PostgreSQL.

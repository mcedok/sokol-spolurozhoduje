# Ověření Etapy C — 19. 8. 2026

## Rozsah

Etapa C zahrnuje nové verze dokumentu, mapování stabilních bloků, projekci vláken
připomínek, neměnné exportní snapshoty a auditované veřejné i interní PDF/A exporty.

## Automatické testy

- Vitest: všech 46 testovacích souborů, 289 testů, vše PASS.
  - 28 nedatabázových souborů: 184 testů.
  - 18 databázových souborů spuštěných sekvenčně: 105 testů.
- Java worker: Docker target `test`, 45 JUnit testů, vše PASS.
- TypeScript: `next typegen && tsc --noEmit`, PASS.
- Statický browser build: `NEXT_PUBLIC_DATA_BACKEND=browser pnpm build`, PASS.
- Produkční server build: `pnpm build:server`, PASS.
- Produkční aplikační a operační Docker image: PASS.

Databázové testy byly na Docker Desktop spuštěny po souborech, protože všechny
záměrně resetují stejné lokální schéma. Pouze v lokálním testovacím PostgreSQL
kontejneru bylo během QA vypnuto `fsync`; produkční konfigurace ani zdrojový kód
se tím nezměnily.

## Smoke testy

- Reálný Chrome: 39 kontrol, bez runtime/console chyb a bez HTTP chyb zdrojů.
  Ověřeny byly desktop a mobil 390 × 844 px, role, registrace, hlasování,
  správa dokumentu a responzivní stav PDF exportního panelu.
- Produkční server v Dockeru: 55 kontrol. Ověřeny migrace, autentizace, RBAC,
  stavový workflow dokumentu, veřejný a interní filtrovaný PDF export, skrytí
  interního `file ID`, stav úlohy a krátkodobý podepsaný odkaz.

## PDF/A a vizuální QA

- `sokol-pripominky-verejne.pdf`: PDF/A-2u PASS, 11 stran.
- `sokol-pripominky-interni.pdf`: PDF/A-2u PASS, 2 strany.
- Nezávislá validace proběhla pomocí veraPDF 1.31.156 z produkčního worker image
  s vypnutou sítí.
- Textová vrstva veřejného PDF obsahuje 0 výskytů e-mailového, členského a
  interního canary údaje. Interní PDF obsahuje po jednom výskytu explicitně
  povolených canary údajů.
- Všech 13 stran bylo vyrenderováno do PNG a vizuálně zkontrolováno: české
  znaky, záhlaví, stránkování, karty připomínek, interní údaje a přetečení jsou
  v pořádku.

## Kontrolní součty výstupů

- Veřejné PDF: `C9B39FD3A7065B9A043CA7FE1B6EAFA78A45F0713FB6D9CF2025A505259A49EB`
- Interní PDF: `93F04A64AA50771240128013CABE628C5F577E766A541553FF9D727F9AEC7BCA`

Větev nebyla automaticky mergována, pushnuta ani nasazena.

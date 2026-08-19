# Ověření etapy D – pracovní XLSX

Datum: 2026-08-19

## Výsledek

Implementace balíčků 14–16 je v checkpoint commitech `53c693d`, `8fa9e4b`, `d24ec20` a `5c304c8`.

## Ověřené příkazy

- cílené Vitest testy XLSX: **5 souborů / 9 testů PASS**;
- kompletní Maven testy workeru v `maven:3.9.11-eclipse-temurin-21`: **PASS**;
- `git diff --check`: **PASS**;
- worktree: čistý na větvi `codex/xlsx-working-import`.

## Známé lokální blokace

- `pnpm exec tsc --noEmit` narazí pouze na již generované `.next/types/validator.ts` (`ParamMap`, `AppRouteHandlerRoutes`), nikoli na zdrojové XLSX soubory;
- `pnpm build` je v tomto Windows checkoutu blokován nečitelným nativním bindingem `@node-rs/argon2-win32-x64-msvc/argon2.win32-x64-msvc.node`; jde o problém lokální instalace závislostí, nikoli o chybu etapy D.

## Pokrytí

Export ukládá neměnný snapshot bez e-mailu a členského ID. Worker generuje chráněný `.xlsx` s manifestem, číselníky, validacemi a statistikou. Upload je omezen na `.xlsx`, 25 MiB a 1 000 řádků, ukládá se do karantény a kontroluje se ZIP/OOXML struktura. Třícestný náhled rozlišuje bezpečné změny a konflikty; konflikty se rozhodují po celých řádcích. Aplikace je transakční, zachovává settlement historii, zapisuje outbox a hashovaný audit. Administrátorské UI je napojené na export, upload, stav dávky a souhrn výsledků.

Před produkčním nasazením je nutné v čistém CI/containeru zopakovat `pnpm typecheck`, `pnpm build`, databázovou migraci a browser smoke s reálným object storage/ClamAV.

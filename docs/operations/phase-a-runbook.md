# Provozní runbook — etapa A

## Rozsah

Etapa A zajišťuje PostgreSQL, přihlášení, serverové relace, role, správu
uživatelů, správu metadat dokumentů, audit a transakční outbox. **Nahrávání,
archivace a převod DOCX zatím nejsou produkčně povoleny.** Produkčně nejsou
povoleny ani blokové komentáře a hlasování.

## Nasazení a start

1. Z konkrétního Git commitu sestavte neměnný aplikační a operační image:
   `docker build -t sokol-spolurozhoduje:phase-a .` a
   `docker build --target operations -t sokol-spolurozhoduje:phase-a-operations .`.
2. Zajistěte PostgreSQL 16+, TLS připojení a samostatného aplikačního uživatele.
3. Migrace spouštějte z operačního image, například
   `docker run --rm -e DATABASE_URL sokol-spolurozhoduje:phase-a-operations pnpm db:migrate`.
4. U nové instalace nastavte proměnné `FIRST_ADMIN_*` a v zabezpečeném terminálu
   spusťte z operačního image `pnpm bootstrap:superadmin` s připojeným chráněným
   adresářem pro `FIRST_ADMIN_TOKEN_FILE`. Token se nezapisuje na stdout; soubor
   předejte určenému správci mimo běžné logy a po nastavení hesla a MFA jej
   zlikvidujte. Příkaz odmítne založit dalšího prvního superadministrátora.
5. Spusťte image s `DATABASE_URL`, `SESSION_HMAC_KEY`, `OTP_HMAC_KEY`,
   `CSRF_HMAC_KEY`, přesně 32bajtovým `TOTP_ENCRYPTION_KEY` a `APP_ORIGIN`.
6. Publikujte aplikaci pouze za HTTPS reverzní proxy. Aplikace v kontejneru běží
   jako neprivilegovaný uživatel na portu 3000.
7. Orchestrátor má používat `/api/health/live` pro restart procesu a
   `/api/health/ready` pro zařazení instance do provozu. Readiness provádí
   databázový dotaz s dvousekundovým limitem a nevrací detaily konfigurace.

## Migrace a návrat zpět

Databázové migrace se spouštějí právě jednou před novou verzí aplikace. Etapa A
nemá automatický down-migrate. Hranicí rollbacku je proto poslední kompatibilní
image; destruktivní změna databáze vyžaduje předem ověřenou obnovu ze zálohy.
Nikdy nevracejte databázi naslepo pouze výměnou image.

## Relace, incident a obnova MFA

- Zablokování účtu nebo snížení role revokuje jeho relace a aktivní výzvy.
- Při úniku klíče změňte příslušný klíč v úložišti tajemství a revokujte všechny
  relace. Změna session klíče sama zneplatní existující cookie tokeny.
- Ztracené MFA správce obnovuje pouze ověřený superadministrátor po nezávislém
  ověření identity. Událost musí být zaznamenána v incidentním protokolu a
  auditu; nesdělujte původní TOTP tajemství.
- Musí vždy zůstat nejméně jeden aktivní superadministrátor. Aplikace blokuje
  degradaci nebo zablokování posledního.

## Audit a outbox

Pravidelně kontrolujte posloupnost `audit_events`, návaznost `previous_hash` a
`event_hash`, výsledek `allowed/denied` a correlation ID. Citlivé hodnoty jako
hesla, kódy, tokeny, cookies a autorizační hlavičky nesmějí být v metadatech ani
provozních logách. Sledujte neodeslané nebo opakovaně chybující `outbox_events`;
opakování stejného idempotency klíče nesmí vytvořit druhou doménovou událost.

## Záloha a nácvik obnovy

1. Provozujte šifrované automatické databázové zálohy mimo primární uzel.
2. Nejméně čtvrtletně obnovte poslední zálohu do izolované databáze.
3. Na obnovené kopii spusťte migrace, readiness a serverové testy.
4. Ověřte počty uživatelů, dokumentů, auditních a outbox událostí a hash-chain.
5. Zapište čas obnovy, stáří obnovených dat a výsledek do provozního protokolu.

## Kontrola před vydáním

```powershell
pnpm install --frozen-lockfile
pnpm db:up
$env:DATABASE_URL='postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test'
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm build
pnpm build:server
docker build -t sokol-spolurozhoduje:phase-a .
$env:SMOKE_ALLOW_DATABASE_RESET='RESET_LOCAL_SOKOL_TEST'
pnpm smoke:server
git diff --check
```

Vydání je přijatelné jen při nulovém počtu neúspěšných testů, úspěšném obou
sestavení, zeleném Docker smoke testu a uvolnění jeho portu po skončení.

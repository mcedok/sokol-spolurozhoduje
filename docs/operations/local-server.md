# Lokální serverová verze

## Požadavky

- Docker Desktop se spuštěným linuxovým enginem,
- Node.js 22 a pnpm,
- volné porty 3000 a 55432.

## První spuštění

V kořeni repozitáře spusťte:

```powershell
Copy-Item .env.example .env.local
pnpm install --frozen-lockfile
pnpm db:up
$env:DATABASE_URL='postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test'
pnpm db:migrate
pnpm bootstrap:superadmin
pnpm dev:server
```

V `.env.local` nahraďte všechny ukázkové klíče nezávislými náhodnými hodnotami.
`TOTP_ENCRYPTION_KEY` musí mít přesně 32 bajtů, ostatní kryptografické klíče
nejméně 32 bajtů. Tajné hodnoty se necommitují.
Příkaz automaticky načte `.env.local`. `bootstrap:superadmin` použijte pouze na
čisté instalaci. Vytvoří pozvaného prvního superadministrátora a krátce platný
token zapíše výhradně do nového souboru `FIRST_ADMIN_TOKEN_FILE`; token se
nevypisuje do logu. Soubor bezpečně předejte správci a následně odstraňte. Druhý
pokus po založení superadministrátora je odmítnut.

Ověření živosti a připravenosti:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health/live
Invoke-RestMethod http://127.0.0.1:3000/api/health/ready
```

## Produkční image a automatický průchod

```powershell
docker build -t sokol-spolurozhoduje:phase-a .
$env:SMOKE_ALLOW_DATABASE_RESET='RESET_LOCAL_SOKOL_TEST'
pnpm smoke:server
```

Smoke test používá lokální PostgreSQL na portu 55432, spustí image na portu
33117, projde autentizaci a oprávnění přes HTTP a kontejner vždy ukončí. Port po
sobě zkontroluje. Před vyprázdněním dat vyžaduje uvedené výslovné potvrzení a
navíc odmítne každou databázi kromě lokální `sokol_test`. Cestu k Dockeru lze na
Windows předat proměnnou `DOCKER_BIN`.

Browserovou ukázku lze stále sestavit příkazem `pnpm build`; serverovou variantu
příkazem `pnpm build:server`.

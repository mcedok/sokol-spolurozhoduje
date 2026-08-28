# Lokální akceptační pilot

Lokální pilot je serverová varianta aplikace pro jedno PC. Používá samostatnou
databázi `sokol_pilot` na portu `55433` a samostatné Docker volumes. Automatické
testy nad databází `sokol_test` na portu `55432` proto pilotní data nemažou.

Pilot není určen ke zpřístupnění přes internet. Jednorázové kódy se zatím
čtou z lokální testovací schránky, nikoli ze skutečného e-mailového účtu.

## Požadavky

- Docker Desktop se spuštěným linuxovým enginem;
- Node.js 22 a `pnpm`;
- volné porty `3000`, `55433`, `10001` a `3311`.

## Spuštění a stav

V kořeni repozitáře spusťte:

```powershell
.\scripts\pilot\pilot-start.ps1
.\scripts\pilot\pilot-status.ps1
```

První start vytvoří ignorovaný `.env.local`, samostatné Docker volumes,
databázové schéma a pozvaného prvního superadministrátora. Jeho jednorázový
token je pouze v `.pilot/first-admin-token.txt`. Token po nastavení hesla a MFA
odstraňte. Aplikace běží na `http://127.0.0.1:3000`.

Zastavení zachová databázi i nahrané soubory:

```powershell
.\scripts\pilot\pilot-stop.ps1
```

## Lokální testovací schránka

Po požadavku na členský kód, pozvánku administrátora nebo obnovu hesla spusťte:

```powershell
.\scripts\pilot\pilot-mailbox.ps1
```

Výstup obsahuje jednorázové tajné údaje. Nikomu jej nepřeposílejte a nepřidávejte
do dokumentace, issue ani commitu. Nástroj odmítne jinou databázi než lokální
`sokol_pilot` na portu `55433`.

## Akceptační scénář

1. Otevřete aplikaci bez přihlášení a ověřte veřejný seznam norem.
2. Tokenem z `.pilot/first-admin-token.txt` nastavte heslo a MFA prvního
   superadministrátora.
3. Superadministrátor založí administrátora. Pozvánku převezměte přes pilotní
   schránku a dokončete heslo a MFA.
4. Zaregistrujte člena pod jinou adresou. Šestimístný kód převezměte přes
   pilotní schránku.
5. Administrátor založí normu, doplní předkladatele, odpovědnou osobu a
   důvodovou zprávu.
6. Nahrajte `test/fixtures/docx/supported-elements.docx`, zkontrolujte převod a
   dokument zveřejněte.
7. Člen přidá blokovou připomínku, odpověď a hlas.
8. Administrátor připomínku okomentuje, vypořádá a dokument uzavře.
9. Ověřte veřejné PDF a administrátorský pracovní XLSX včetně bezpečného
   zpětného importu jedné změny.
10. Ověřte, že jiný administrátor nemůže spravovat cizí dokument a že
    superadministrátor jej spravovat může.

## Datová bezpečnost

- `.env.local`, `.pilot/` a jednorázové tokeny jsou ignorované Gitem.
- `pilot-stop` nikdy nepoužívá `docker compose down -v`.
- Pilotní volumes mají prefix `sokol-spolurozhoduje-pilot_`.
- Automatizovaná záloha a potvrzovaná obnova databáze i blobů budou doplněny
  v následujícím balíčku; do té doby pilot nepoužívejte pro nenahraditelná data.

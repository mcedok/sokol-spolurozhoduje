# Sokol spolurozhoduje

Open-source prototyp platformy pro participativní připomínkování a rozhodování členů Sokola.

## Co pilot umí

- veřejný seznam číslovaných norem a jejich stavů,
- detail normy s důvodovou zprávou, předkladatelem a odpovědnou osobou,
- komentáře, návrhy konkrétních úprav a hlasování o jejich důležitosti,
- orientační hlasování o potřebnosti normy,
- zveřejnění výsledku vypořádání a odůvodnění,
- administraci předkladatele: vytvoření a smazání normy, změnu statusu, otevření či uzavření připomínek, nahrání dokumentu a vypořádání podnětů,
- adaptivní zobrazení pro počítač i mobil.

## Spuštění

Požadavky: Node.js 20+ a pnpm.

```bash
pnpm install
pnpm dev
```

Produkční sestavení:

```bash
pnpm build
```

## Důležité omezení pilotu

Pilot ukládá normy, komentáře a hlasování do `localStorage` konkrétního prohlížeče. Nahrané soubory ukládá do IndexedDB. Data tedy nejsou sdílena mezi uživateli ani zařízeními. Před ostrým provozem je nutné doplnit serverovou databázi, objektové úložiště, autentizaci, role, auditní stopu, antivirovou kontrolu souborů, zálohování a ochranu proti opakovanému hlasování.

Podrobnosti jsou v [architektonické dokumentaci](docs/ARCHITECTURE.md).

## Licence a značka

Zdrojový kód je dostupný pod licencí MIT. Logo Sokol, názvy, ochranné známky a přiložené značkové fonty nejsou součástí licence MIT a smějí být používány pouze se souhlasem jejich vlastníků.

## Zapojení

Postup pro hlášení chyb a návrhy změn je v [CONTRIBUTING.md](CONTRIBUTING.md). Bezpečnostní problémy prosím řešte podle [SECURITY.md](SECURITY.md).

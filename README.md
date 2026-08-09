# Sokol spolurozhoduje

Open-source prototyp platformy pro participativní připomínkování a rozhodování členů Sokola.

## Co pilot umí

- veřejný seznam číslovaných norem a jejich stavů,
- detail normy s důvodovou zprávou, předkladatelem a odpovědnou osobou,
- komentáře, návrhy konkrétních úprav a hlasování o jejich důležitosti,
- orientační hlasování o potřebnosti normy,
- zveřejnění výsledku vypořádání a odůvodnění,
- registraci a přihlášení členů jednorázovým e-mailovým kódem,
- přihlášení správců heslem včetně prvního nastavení, změny a obnovy hesla,
- správu rolí a stavů uživatelů superadministrátorem,
- administraci předkladatele: vytvoření a smazání normy, změnu statusu, otevření či uzavření připomínek, nahrání dokumentu a vypořádání podnětů,
- adaptivní zobrazení pro počítač i mobil.

> [!WARNING]
> Toto je veřejná browser-local demoverze, nikoli produkčně bezpečný systém. Modelová hesla a kód jsou záměrně zveřejněné, data i odvozené hashe může návštěvník ve svém prohlížeči změnit a simulovaná schránka neposílá skutečný e-mail.

## Modelové účty

| Role | E-mail | Přístupový údaj |
|---|---|---|
| Superadministrátor | `superadmin@sokol.demo` | heslo `SuperSokol!2026` |
| Administrátor | `administrator@sokol.demo` | heslo `AdminSokol!2026` |
| Člen | `clen@sokol.demo` | jednorázový kód `260814` |

Členové nemají heslo: po zadání e-mailu používají šestimístný jednorázový kód. Administrátor a superadministrátor používají heslo; pozvaný správce nastaví první heslo jednorázovým odkazem ze simulované schránky.

## Lokální spuštění a ověření

Požadavky: Node.js 20+ a pnpm.

```bash
pnpm install
pnpm dev
```

Automatické testy a produkční Sites sestavení:

```bash
pnpm test
pnpm build
```

Vývojový server vypíše lokální adresu. Data zůstávají v profilu konkrétního prohlížeče; pro čistý začátek je nutné odstranit lokální data webu nebo v aplikaci potvrdit reset ukázkových dat.

## Důležité omezení pilotu

Pilot ukládá uživatele, výzvy, relace, normy, komentáře, hlasování a audit do `localStorage` konkrétního prohlížeče. Nahrané soubory ukládá do IndexedDB a relaci aplikace obnovuje přes `sessionStorage`. Data tedy nejsou sdílena mezi uživateli, profily ani zařízeními. Web Crypto v demu pouze realisticky odvozuje hash hesla; bez důvěryhodného serveru neposkytuje produkční ochranu.

Před ostrým provozem je nutné nahradit klientské úložiště serverovou databází a objektovým úložištěm, přesunout autentizaci i autorizaci na server a doplnit skutečné doručování e-mailů, omezení frekvence pokusů, CSRF/XSS ochranu, centrální audit, antivirovou kontrolu souborů a zálohování.

Podrobnosti jsou v [architektonické dokumentaci](docs/ARCHITECTURE.md).

## Licence a značka

Zdrojový kód je dostupný pod licencí MIT. Logo Sokol, názvy, ochranné známky a přiložené značkové fonty nejsou součástí licence MIT a smějí být používány pouze se souhlasem jejich vlastníků.

## Zapojení

Postup pro hlášení chyb a návrhy změn je v [CONTRIBUTING.md](CONTRIBUTING.md). Bezpečnostní problémy prosím řešte podle [SECURITY.md](SECURITY.md).

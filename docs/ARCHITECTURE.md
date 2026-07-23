# Architektura platformy

## Současný pilot

Rozhraní je postavené jako aplikace React/Next kompatibilní s vinext a Cloudflare Workers. Veškeré změny uživatele se v pilotu ukládají lokálně:

- metadata norem, komentáře, vypořádání a hlasy: `localStorage`,
- nahrané dokumenty: IndexedDB,
- výchozí ukázková data: zdrojový kód klienta.

Tento režim umožňuje bezpečně ověřit informační architekturu a uživatelské scénáře bez zřízení databáze. Není to sdílený víceuživatelský provoz.

## Doporučená produkční architektura

```text
Prohlížeč
  |
  v
Webová aplikace + API
  |-- identita a role člena
  |-- validace a autorizace
  |-- audit administrativních akcí
  |
  +--> relační databáze
  |      normy, verze, podněty, hlasy, vypořádání
  |
  +--> objektové úložiště
         původní dokumenty, přílohy a finální znění
```

## Základní entity

- `Norm`: číslo, název, verze, status, termíny, předkladatel, odpovědná osoba a důvodová zpráva.
- `DocumentVersion`: soubor, kontrolní součet, pořadí verze a datum zveřejnění.
- `Submission`: komentář nebo návrh změny navázaný na konkrétní část normy.
- `Vote`: jeden hlas člena pro konkrétní podnět nebo orientační potřebnost normy.
- `Resolution`: výsledek zapracováno/nezapracováno, odůvodnění a vazba na výslednou verzi.
- `AuditEvent`: kdo, kdy a jak změnil stav normy nebo vypořádání.

## Role

- člen: čte, komentuje, navrhuje a hlasuje,
- předkladatel: spravuje vlastní normy a vypořádává podněty,
- administrátor: spravuje uživatele, role, číselné řady a provozní nastavení,
- veřejnost: podle rozhodnutí provozovatele může vidět publikované výsledky bez možnosti změn.

## Číslování

Pilot používá formát `SOKOL-RRRR-NNN`, například `SOKOL-2026-004`. V produkci musí pořadové číslo přidělovat server v transakci, aby dva souběžně vložené dokumenty nedostaly stejné číslo.

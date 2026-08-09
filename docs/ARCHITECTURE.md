# Architektura platformy

## Současný pilot

Rozhraní je postavené jako aplikace React/Next kompatibilní s vinext a Cloudflare Workers. Veškeré změny uživatele se v pilotu ukládají lokálně:

- uživatelé, přístupové výzvy, relace, audit, metadata norem, komentáře, vypořádání a hlasy: `localStorage`,
- nahrané dokumenty: IndexedDB,
- výchozí ukázková data: zdrojový kód klienta.

Tento režim umožňuje ověřit informační architekturu a uživatelské scénáře bez zřízení databáze. Není to sdílený víceuživatelský provoz ani bezpečnostní model pro produkci: návštěvník ovládá JavaScript i lokální data svého prohlížeče.

## Klientská hranice a služby

Prezentační komponenty volají akce z `useAppController()` a nerozhodují samy o oprávnění. Controller skládá následující veřejné služby:

- `AuthService`: adaptivní identifikace účtu, registrace člena, jednorázové kódy, správcovská hesla, první nastavení a obnova hesla, relace a jejich revokace,
- `UserService`: seznam a detail uživatelů, založení privilegovaného účtu, stav, role a atomický převod vlastnictví norem,
- `NormService`: veřejné čtení, role-aware seznam spravovatelných norem, správcovské změny, příspěvky, hlasy a vypořádání,
- `AuditService`: append-only události s odstraněním hesel, hashů, solí, kódů a tokenů z metadat,
- `AccessControl`: jednotná pravidla aktivního účtu, ověřeného e-mailu, role a vlastnictví normy,
- `BrowserRepository`: migrace a kopírované změny stavu nad `localStorage`,
- `FileRepository`: dokumenty v IndexedDB.

Každá změnová metoda znovu načte relaci a ověří oprávnění. Neplatná relace se při správě normy odmítne a audituje před vyhledáním cílové normy, aby se neprozrazovala její existence. Po commitnutí smazání nebo výměny dokumentu je repository stav a audit autoritativní; úklid starého souboru v IndexedDB je best-effort a jeho selhání nevrací zavádějící neúspěch již provedené operace.

Hesla správců se v pilotu neukládají čitelně. Kryptografický adaptér používá PBKDF2 se SHA-256, 210 000 iteracemi a samostatnou 16bajtovou solí. Protože výpočet i ověření probíhá v nedůvěryhodném klientu, jde pouze o simulaci produkčního toku.

## Doporučená produkční architektura

```text
Prohlížeč
  |
  v
Webová aplikace + API
  |-- serverová autentizace, bezpečné cookies a správa relací
  |-- serverová autorizace rolí a vlastnictví u každé změny
  |-- validace, rate limiting a centrální audit
  |-- e-mailové kódy a odkazy s krátkou platností
  |
  +--> relační databáze
  |      normy, verze, podněty, hlasy, vypořádání
  |
  +--> objektové úložiště
  |      původní dokumenty, přílohy a finální znění
  |
  +--> e-mailová služba a fronta úloh
```

Produkční API musí od klienta přijímat pouze záměr operace. Identitu aktéra, platnost relace, roli, stav účtu a vlastnictví normy určí server z vlastní databáze; klientské `localStorage`, skryté tlačítko ani předané `ownerAdminId` nejsou autoritou. Hesla musí hashovat server vhodným password-hashing algoritmem, tajné výzvy ukládat pouze v odvozené podobě a relace chránit bezpečnými `HttpOnly` cookies. Součástí nasazení jsou CSRF/XSS ochrana, omezení pokusů, rotace relací, zálohy a sledovatelný audit.

## Základní entity

- `Norm`: číslo, název, verze, status, termíny, předkladatel, odpovědná osoba a důvodová zpráva.
- `DocumentVersion`: soubor, kontrolní součet, pořadí verze a datum zveřejnění.
- `Submission`: komentář nebo návrh změny navázaný na konkrétní část normy.
- `Vote`: jeden hlas člena pro konkrétní podnět nebo orientační potřebnost normy.
- `Resolution`: výsledek zapracováno/nezapracováno, odůvodnění a vazba na výslednou verzi.
- `AuditEvent`: kdo, kdy a jak změnil stav normy nebo vypořádání.
- `User`: profil, role `member | admin | superadmin`, stav, ověření e-mailu a odvozené přihlašovací údaje správce.
- `LoginChallenge`: jednorázový členský kód nebo odkaz pro první či obnovené heslo.
- `Session`: osmihodinová relace s možností okamžité revokace.

## Role

- veřejnost: čte seznam a veřejný detail publikovaných norem bez možnosti změn,
- člen: po ověření e-mailu komentuje, navrhuje a hlasuje,
- administrátor: má členská oprávnění a spravuje pouze normy, které vlastní,
- superadministrátor: spravuje všechny normy, uživatele, role, stavy a převody vlastnictví.

## Číslování

Pilot používá formát `SOKOL-RRRR-NNN`, například `SOKOL-2026-004`. V produkci musí pořadové číslo přidělovat server v transakci, aby dva souběžně vložené dokumenty nedostaly stejné číslo.

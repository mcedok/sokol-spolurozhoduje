# Členské zobrazení dokumentu a blokové připomínkování

## Schválený rozsah

Lokální serverový pilot zpřístupní převedenou webovou podobu publikované normy,
originální DOCX ke stažení přihlášenému uživateli a základní blokové
připomínkování. Přihlašovací dialog nejprve oddělí existujícího a nového
uživatele.

## Přístup a přihlášení

- Nový člen přejde přímo do registračního formuláře a e-mail ověří novým
  šestimístným kódem.
- Existující člen zadá e-mail a pokaždé obdrží nový šestimístný kód.
- Běžný administrátor se přihlašuje e-mailem a heslem bez TOTP.
- Superadministrátor se přihlašuje heslem a následně TOTP.
- Pozvaný běžný administrátor po nastavení hesla aktivuje účet bez enrollování
  TOTP; pozvaný superadministrátor musí TOTP dokončit.
- Server nadále vrací neutrální chyby, aby přihlašovací rozhraní neprozrazovalo
  existenci účtu.

## Veřejný detail dokumentu

Čtecí endpoint podle veřejného čísla normy vrátí pouze veřejně bezpečná data:
metadata dokumentu, poslední zveřejněnou připravenou verzi, stabilní bloky,
veřejné komentáře, odpovědi, výsledky hlasování a vypořádání. Nevrací e-mail,
členské ID, interní uživatelské ID ani interní identifikátor souboru.

Webové bloky zachovají nadpisy, odstavce, seznamy, tabulky, zvýraznění a odkazy.
Blokový UUID slouží jako veřejný stabilní kotvící identifikátor. Pokud je
detail nastavený jen pro přihlášené, anonymní čtenář uvidí pouze název.

Originální DOCX se stahuje samostatným endpointem podle veřejného čísla normy.
Endpoint vyžaduje platnou relaci, najde čistý archivovaný originál poslední
zveřejněné verze a vytvoří krátkodobý podepsaný odkaz. Klient nikdy nedostane
interní UUID souboru.

## Připomínkování

U každého komentovatelného bloku může ověřený člen vytvořit komentář nebo návrh
změny, odpovědět ve vlákně a hlasovat pro či proti důležitosti podnětu. Člen
může také hlasovat o potřebnosti dokumentu. Mutace vyžadují relaci, CSRF,
idempotency key a aktuální verzi cílového záznamu.

Server při každé mutaci ověří aktivního uživatele, ověřený e-mail, publikovaný
stav, otevřené připomínky, aktuální blok poslední publikované verze a případné
vlastnictví dokumentu. Komentář se zapisuje společně s auditem a outbox událostí
v jedné transakci. Uzavřený dokument zůstává čitelný, ale nepřijímá nové
komentáře, odpovědi ani hlasy.

## Databáze

Existující tabulky `comment_threads`, `comments`, historie a vypořádání se
zachovají. Nová migrace doplní transakční číslování veřejných vláken a
komentářů, unikátní hlas uživatele u komentáře a unikátní hlas uživatele o
potřebnosti dokumentu. E-mail ani členské ID se do připomínkových tabulek
nekopírují.

## Pilotní hranice

Tento balíček obsahuje čtení bloků, komentáře, návrhy, odpovědi a hlasování.
Přílohy komentářů, zmínky, editace textu, moderátorské zásahy a kompletní
administrátorské vypořádání zůstávají navazujícím produkčním balíčkem.

## Ověření

Automatizované testy pokryjí RBAC přihlášení, veřejnou redakci detailu,
stažení originálu, blokový komentář, návrh, odpověď, oba druhy hlasování,
uzavřený dokument a klientský tok po reloadu. Po implementaci proběhnou cílené
testy, kompletní Vitest sada, typecheck, oba buildy, pilotní status a UI smoke.

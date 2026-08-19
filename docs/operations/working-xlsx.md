# Pracovní XLSX – provozní postup

Pracovní `.xlsx` je neveřejný administrátorský formulář pro vypořádání připomínek. Publikační výstup zůstává PDF; XLSX se nezobrazuje běžným členům.

## Limity a bezpečnost

- pouze `.xlsx`, nejvýše 25 MiB a 1 000 pracovních řádků;
- makra, externí odkazy, vlastní XML a vzorce v editovatelných polích se odmítají;
- upload se ukládá nejprve do karantény, kontroluje se MIME, ZIP struktura, hash a manifest;
- do sešitu ani auditních metadat se nevkládá e-mail ani členské ID;
- administrátor vidí a mění pouze vlastní dokumenty, superadministrátor všechny.

## Pracovní postup

1. Administrátor vytvoří export z konkrétní připravené verze dokumentu.
2. Po dokončení exportu stáhne chráněný sešit, upraví pouze odemčená pole a nahraje jej zpět.
3. Systém vytvoří třícestný náhled: beze změny, bezpečná změna, již aktuální, konflikt nebo chyba.
4. Bezkonfliktní validní řádky se aplikují v jedné transakci. Konflikty se rozhodují po celých řádcích volbou „zachovat systém“ nebo „použít XLSX“.
5. Každá aplikace, rozhodnutí, storno a chyba se zapisuje do hashovaného auditu. Při návratu ze stavu `settled` se původní settlement pouze zneaktivní a historie zůstává zachována.

## Obnova po chybě

Při chybě validace zůstává původní soubor v karanténě a dávka přejde do `failed`; originální exportní snapshot se nemění. Operátor může bezpečně zopakovat upload s novým idempotency klíčem. Nikdy nemažte archivovaný originál ani nepřepisujte konfliktní řádky ručně v databázi.

## Audit a retence

Audit vyhledávejte podle ID importní dávky a korelačního ID. Karanténní objekty se čistí retenční úlohou po skončení retenční lhůty; exportní deriváty a doménové revize zůstávají dle retenční politiky dokumentu.

# Etapa C: verzování dokumentů a PDF exporty

## Cíl

Etapa C doplní nad existující převod DOCX neměnné verze dokumentu, automatické a ručně potvrzované mapování bloků, projekci připomínek mezi verzemi a bezpečné veřejné i interní PDF exporty. Výsledek musí být použitelný v serverovém pilotu a nesmí čerpat z demonstračního úložiště prohlížeče.

## Rozsah a nezbytný předpoklad

Aktuální server ukládá dokumenty, soubory, verze, bloky a revize, ale produkční připomínky a vypořádání zatím neexistují. Před balíčkem 11 proto vznikne úzký serverový základ:

- `comment_threads`, `comments`, `comment_revisions` a `comment_status_transitions`;
- `settlements`, `settlement_revisions` a `settlement_block_links`;
- veřejná stabilní ID připomínek, vlastnictví dokumentu, optimistické `row_version` a audit;
- API pouze pro čtení exportního snapshotu a pro vazby projekcí. Rozšířené UX zmínek, příloh a moderace zůstává samostatnou návaznou prací.

Tento most je nutný, protože projekce a PDF nesmějí vznikat z klientských demodat. Etapa D ani XLSX nejsou součástí.

## Verze dokumentu

Nová verze vzniká pouze z nového DOCX a prochází stávajícím tokem karantény, AV kontroly, převodu a administrátorského náhledu. Publikovaná verze ani její revize bloků se nemění. Dokument může mít více připravených verzí, ale nejvýše jednu aktuálně publikovanou verzi.

Po dokončení převodu nové verze vznikne mapovací úloha mezi bezprostředně předchozí publikovanou/připravenou verzí a novou verzí. Mapování je reprodukovatelné a nese verzi algoritmu.

## Mapování bloků

`block_mappings` ukládá zdrojovou a cílovou revizi, vztah, jistotu, metodu, stav potvrzení a případné rozhodnutí administrátora. Povolené vztahy jsou:

- `unchanged` — stejný obsah a logická identita;
- `modified` — jeden zdroj odpovídá jednomu cíli;
- `moved` — obsah zůstal, změnilo se pořadí nebo kontext;
- `split` — jeden zdroj odpovídá více cílům;
- `merged` — více zdrojů odpovídá jednomu cíli;
- `removed` a `added` — bez protějšku.

Automatický postup používá v tomto pořadí stabilní `block_uid`, přesný normalizovaný hash, zdrojové identifikátory DOCX, shodu okolních bloků a nakonec textovou podobnost. Jednoznačné shody s vysokou jistotou se potvrdí automaticky. Nejasné, dělené, slučované a konfliktní vazby čekají na rozhodnutí administrátora. Potvrzení kontroluje vlastnictví dokumentu a `row_version`.

## Projekce připomínek

Původní vlákno se nikdy nepřepisuje. `thread_version_projections` pouze určí, u které revize nové verze se stará připomínka zobrazí a zda je projekce automatická, potvrzená, nejasná nebo bez cíle.

- `unchanged`, jednoznačné `modified` a `moved` mohou vytvořit automatickou projekci;
- `split` a `merged` vždy vyžadují potvrzení administrátora;
- `removed` zůstává dohledatelné u původní verze a v exportu je označeno jako bez cíle;
- cílová verze zapracování ve vypořádání se nemění automaticky.

## Exportní snapshot

Každý export vzniká z neměnného JSON snapshotu uloženého v `export_jobs`. Snapshot obsahuje identitu dokumentu a verze, čas, filtry, veřejnou nebo interní variantu, součty, blokové cíle, vlákna, připomínky, veřejná stanoviska a stav vypořádání. Má kanonický SHA-256 checksum a verzi schématu.

Worker načítá pouze uložený snapshot, takže pozdější změna databáze nezmění opakovaný výsledek stejné úlohy. Výsledný soubor je privátní objekt s omezeným podepsaným odkazem. Spuštění, dokončení, selhání a stažení interního exportu se auditují.

## Veřejné PDF

Veřejný export je dostupný oprávněným čtenářům podle viditelnosti dokumentu. Obsahuje titulní stranu, identifikaci verze a snapshotu, statistiku, filtrovaný seznam připomínek, veřejná stanoviska, stav vypořádání a informaci o projekci do nové verze.

Redakční allowlist nepovolí e-mail, členské ID, interní UUID, IP adresu, interní poznámku, bezpečnostní metadata ani technické identifikátory úložiště. Testy vkládají do každého zakázaného pole unikátní canary hodnotu a ověřují, že není v modelu pro render, textové vrstvě ani metadatech PDF.

## Interní PDF

Interní export smí vytvořit a stáhnout pouze vlastník dokumentu nebo superadministrátor po čerstvém ověření. Citlivá pole nejsou předvolena; administrátor je vybírá explicitně filtrem. Export vždy obsahuje označení `INTERNÍ`, autora exportu, čas a identifikátor snapshotu.

## PDF technologie a dostupnost

Java worker používá PDFBox pro sestavení dokumentu a veraPDF pro validační profil PDF/A-2u. Český font se vkládá do PDF, text zůstává vyhledatelný a struktura používá záložky, opakovaná záhlaví tabulek, číslování stran a srozumitelný lineární tok. Pokud veraPDF v lokálním prostředí není dostupné, test musí stav označit jako neověřený; produkční dokončení úlohy vyžaduje úspěšnou validaci.

## API a oprávnění

- `POST /api/documents/{id}/versions/uploads` zůstává jedinou cestou vzniku nové obsahové verze.
- `GET /api/document-versions/{id}/mappings` vrací mapovací náhled.
- `PUT /api/block-mappings/{id}/decision` potvrzuje nebo opravuje nejasnou vazbu.
- `POST /api/documents/{id}/exports` vytvoří snapshot a asynchronní úlohu.
- `GET /api/export-jobs/{id}` vrací bezpečný stav bez objektového klíče.
- `POST /api/export-jobs/{id}/download-link` vydá krátkodobý odkaz po opětovné autorizaci.

Všechny změnové operace používají CSRF, `Idempotency-Key`, vlastnictví dokumentu, `If-Match`/`row_version`, RFC Problem Details a audit povoleného i odmítnutého pokusu.

## Chybové stavy

Stabilní kódy zahrnují `SOURCE_VERSION_NOT_READY`, `TARGET_VERSION_NOT_READY`, `MAPPING_REVIEW_REQUIRED`, `MAPPING_CONFLICT`, `EXPORT_SNAPSHOT_INVALID`, `EXPORT_REDACTION_FAILED`, `PDF_A_VALIDATION_FAILED`, `EXPORT_NOT_READY`, `EXPORT_EXPIRED` a `FOREIGN_DOCUMENT`.

Opakování exportu se stejným idempotency klíčem vrací tutéž úlohu. Worker používá lease a omezené retry; neplatný snapshot ani selhání redakce se automaticky neopakují.

## Akceptační kritéria

- nová verze nikdy nezmění publikovanou předchozí verzi;
- jednoznačné mapování je deterministické, nejasné mapování nelze použít bez rozhodnutí;
- původní připomínka zůstává spojena se zdrojovou revizí a projekce je samostatná auditovaná vazba;
- veřejný PDF model ani výsledný soubor neobsahuje žádné zakázané interní údaje;
- interní PDF je dostupné jen vlastníkovi nebo superadministrátorovi a jeho stažení je auditované;
- export je reprodukovatelný ze snapshotu, má checksum a stav úlohy;
- české znaky, dlouhé texty, více stran, tabulky a prázdné výsledky se vykreslí bez překryvů či ořezu;
- unit, integrační, contract, autorizační, redakční a vizuální smoke testy projdou.

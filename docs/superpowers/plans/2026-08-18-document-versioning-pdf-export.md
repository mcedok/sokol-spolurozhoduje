# Document Versioning and PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodat Etapu C jako produkční tok od nové DOCX verze přes mapování bloků a projekci připomínek až po auditované veřejné a interní PDF/A exporty.

**Architecture:** Stávající Next.js/TypeScript modulární monolit vytváří verze, mapování, projekce a neměnné exportní snapshoty v PostgreSQL. Java 21 worker renderuje PDF z uloženého snapshotu, ukládá výsledek do privátního objektového úložiště a validuje PDF/A. UI poskytuje vlastníkovi dokumentu kontrolu nejasných mapování, filtry exportu a stav úlohy.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Zod 4, PostgreSQL 16, Azure Blob kompatibilní úložiště, Java 21, PostgreSQL JDBC, Jackson, Apache PDFBox, veraPDF, JUnit 5, Vitest, Docker Compose.

## Globální omezení

- Rozsah je Etapa C, balíčky 10–13, plus pouze nezbytný serverový základ připomínek/vypořádání pro projekce a exportní snapshot.
- Publikované verze, revize bloků, původní připomínky, revize vypořádání a exportní snapshoty jsou neměnné.
- Administrátor pracuje pouze se svým dokumentem, superadministrátor se všemi.
- Každá změnová operace používá TDD, optimistické zamykání, idempotenci a audit povolení i zamítnutí.
- Veřejný export používá allowlist; citlivá pole se neodstraňují až z hotového PDF.
- PDF musí zachovat české znaky, textovou vrstvu a splnit dostupnost a vizuální QA.
- Každý balíček končí cílenými testy a samostatným lokálním commitem.

---

### Task 1: Serverový základ připomínek a vypořádání

**Files:**
- Create: `contracts/comments.ts`
- Modify: `contracts/index.ts`
- Create: `server/db/migrations/0005_comments_settlements.sql`
- Modify: `test/server/db-test-context.ts`
- Create: `test/server/comment-settlement-foundation.test.ts`

- [ ] Napsat RED kontraktní a databázové testy pro stabilní ID, cílení na `block_uid` + `block_revision_id`, vlákna, revize, stav a vypořádání.
- [ ] Přidat tabulky s FK, check constraints, unikátními klíči, `row_version` a append-only historií.
- [ ] Ověřit, že veřejné kontrakty neobsahují e-mail, členské ID ani interní poznámku.
- [ ] Spustit cílené GREEN testy a commitnout `feat: add comment settlement export foundation`.

### Task 2: Nové verze a deterministické mapování bloků

**Files:**
- Create: `contracts/document-versioning.ts`
- Modify: `contracts/index.ts`
- Create: `server/db/migrations/0006_block_mappings.sql`
- Create: `server/modules/versioning/block-matcher.ts`
- Create: `server/modules/versioning/versioning-repository.ts`
- Create: `server/modules/versioning/versioning-service.ts`
- Create: `test/server/block-matcher.test.ts`
- Create: `test/server/versioning-workflows.test.ts`

- [ ] RED: přesná shoda `block_uid`/hash, přesun, změna, přidání, odstranění a nejasná podobnost.
- [ ] Implementovat čistý deterministický matcher s verzí algoritmu a vysvětlitelným skóre.
- [ ] Persistovat mapovací běh a vazby atomicky; zabránit mapování cizích dokumentů a nepřipravených verzí.
- [ ] Ověřit idempotenci a souběžný vznik další verze.
- [ ] Cílené GREEN testy a commit `feat: map blocks across document versions`.

### Task 3: Rozhodnutí nejasných mapování a projekce vláken

**Files:**
- Create: `server/db/migrations/0007_thread_version_projections.sql`
- Modify: `server/modules/versioning/versioning-repository.ts`
- Modify: `server/modules/versioning/versioning-service.ts`
- Create: `app/api/document-versions/[versionId]/mappings/route.ts`
- Create: `app/api/block-mappings/[mappingId]/decision/route.ts`
- Create: `test/server/version-projection-workflows.test.ts`
- Create: `test/server/versioning-routes.test.ts`

- [ ] RED: automatická projekce jednoznačné shody, povinné potvrzení split/merge, odstraněný blok bez cíle a odmítnutý cizí admin.
- [ ] Přidat `thread_version_projections` a auditované rozhodnutí s `If-Match`.
- [ ] Zajistit, že projekce nikdy nepřepíše zdrojové vlákno ani cílovou verzi vypořádání.
- [ ] Contract/route GREEN testy a commit `feat: review mappings and project comment threads`.

### Task 4: Přístupný administrátorský náhled mapování

**Files:**
- Create: `app/components/admin/VersionMappingReview.js`
- Modify: `app/components/admin/NormAdministration.js`
- Modify: `app/data/server-api-client.js`
- Modify: `app/globals.css`
- Create: `test/version-mapping-review.test.jsx`

- [ ] RED: role gating, souhrn jistých/nejasných vazeb, klávesnicové ovládání, stavové ARIA a konflikt `row_version`.
- [ ] Implementovat responzivní náhled se zvýrazněním zdroj/cíl a explicitním potvrzením.
- [ ] Ověřit 44×44 px cíle a mobilní rozvržení.
- [ ] GREEN a commit `feat: add accessible version mapping review`.

### Task 5: Exportní snapshoty a úlohy

**Files:**
- Create: `contracts/exports.ts`
- Modify: `contracts/index.ts`
- Create: `server/db/migrations/0008_pdf_exports.sql`
- Create: `server/modules/exports/export-snapshot.ts`
- Create: `server/modules/exports/export-repository.ts`
- Create: `server/modules/exports/export-service.ts`
- Create: `test/server/export-snapshot.test.ts`
- Create: `test/server/export-workflows.test.ts`

- [ ] RED: reprodukovatelný snapshot, checksum, filtry, idempotence, vlastnictví a zakázaná veřejná pole.
- [ ] Vytvořit `export_jobs`, snapshot schéma a outbox událost v jedné transakci.
- [ ] Interní volitelná pole defaultně vypnout a vyžadovat čerstvé ověření.
- [ ] GREEN a commit `feat: create immutable pdf export snapshots`.

### Task 6: Veřejné PDF a redakční testy

**Files:**
- Modify: `worker/pom.xml`
- Create: `worker/src/main/java/cz/sokol/conversion/pdf/PdfExportRenderer.java`
- Create: `worker/src/main/java/cz/sokol/conversion/pdf/PdfExportSnapshot.java`
- Create: `worker/src/main/java/cz/sokol/conversion/pdf/PdfExportProcessor.java`
- Modify: `worker/src/main/java/cz/sokol/conversion/WorkerMain.java`
- Create: `worker/src/test/java/cz/sokol/conversion/pdf/PublicPdfExportTest.java`

- [ ] RED golden test s českými znaky, více stranami, tabulkou a canary hodnotami ve všech zakázaných polích.
- [ ] Renderovat titulní stranu, statistiku, připomínky, stanoviska, stavy a projekce přes PDFBox s vloženým fontem.
- [ ] Ověřit absenci canary hodnot v render modelu, textové vrstvě a PDF metadatech.
- [ ] Renderovat fixture do `tmp/pdfs`, převést stránky na PNG a vizuálně zkontrolovat.
- [ ] GREEN a commit `feat: render redacted public pdf exports`.

### Task 7: Interní PDF, filtry a PDF/A validace

**Files:**
- Modify: `worker/src/main/java/cz/sokol/conversion/pdf/PdfExportRenderer.java`
- Create: `worker/src/main/java/cz/sokol/conversion/pdf/PdfAValidator.java`
- Create: `worker/src/test/java/cz/sokol/conversion/pdf/InternalPdfExportTest.java`
- Create: `worker/src/test/java/cz/sokol/conversion/pdf/PdfAValidationTest.java`

- [ ] RED: interní označení, explicitní volby polí, filtry, auditní metadata a selhání validace.
- [ ] Přidat PDF/A-2u metadata, vložené fonty, číslování, záložky a opakovaná záhlaví.
- [ ] Spustit veraPDF jako oddělený validátor; bez úspěchu nesmí být produkční úloha `completed`.
- [ ] Vizuálně porovnat veřejnou a interní fixture.
- [ ] GREEN a commit `feat: add filtered internal pdfa exports`.

### Task 8: Exportní API a administrační UI

**Files:**
- Create: `app/api/documents/[documentId]/exports/route.ts`
- Create: `app/api/export-jobs/[jobId]/route.ts`
- Create: `app/api/export-jobs/[jobId]/download-link/route.ts`
- Create: `app/components/admin/PdfExportPanel.js`
- Modify: `app/components/admin/NormAdministration.js`
- Modify: `app/data/server-api-client.js`
- Modify: `app/globals.css`
- Create: `test/server/export-routes.test.ts`
- Create: `test/pdf-export-panel.test.jsx`

- [ ] RED: autorizace, CSRF, idempotence, stav úlohy, expirace odkazu, interní reautentizace a přístupnost UI.
- [ ] Implementovat veřejnou/interní volbu, filtry, polling stavu, bezpečné stažení a srozumitelné chyby.
- [ ] Ověřit mobilní layout a klávesnici.
- [ ] GREEN a commit `feat: expose secure pdf export workflow`.

### Task 9: Celkové ověření Etapy C

- [ ] Spustit všechny Vitest testy včetně skutečné PostgreSQL a objektového úložiště.
- [ ] Spustit všechny JUnit testy workeru v Docker/Maven prostředí.
- [ ] Spustit typecheck, browser build, server build a `git diff --check`.
- [ ] Vytvořit veřejný a interní vzorový PDF, znovu je otevřít, extrahovat text a ověřit redakci.
- [ ] Renderovat všechny stránky do PNG a vizuálně zkontrolovat typografii, přetečení, tabulky, záhlaví a číslování.
- [ ] Spustit reálný browser smoke: nová verze, náhled mapování, rozhodnutí nejasné vazby, veřejný export, interní export a stažení.
- [ ] Zapsat ověřené výsledky a dokončit větev bez automatického merge nebo nasazení.

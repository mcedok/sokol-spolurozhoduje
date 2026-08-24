# Pracovní XLSX a bezpečný zpětný import – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementovat administrátorský export připomínek do chráněného `.xlsx`, bezpečný třícestný import a auditované řešení konfliktů podle schválené specifikace.

**Architecture:** Webová aplikace poskytne stejno-doménové interní API, PostgreSQL staging a administrační UI. Stávající Java worker s Apache POI bude generovat, kontrolovat a parsovat XLSX; změny se aplikují přes atomické transakce s kontrolou vlastnictví, `row_version`, doménové historie, outboxu a hashovaného auditu.

**Tech Stack:** Next/Vinext, TypeScript, Zod, PostgreSQL, existing `postgres` client, Java 21, Maven, Apache POI, Azure Blob/object storage, ClamAV, Vitest, JUnit 5, Playwright-style browser smoke.

**Spec:** `docs/superpowers/specs/2026-08-19-working-xlsx-import-design.md`

## Global Constraints

- Povolit pouze `.xlsx`; `.xls`, `.xlsm`, makra, externí odkazy a vzorce v editovatelných buňkách odmítnout.
- Jeden sešit patří jednomu dokumentu, jedné verzi a jedné exportní dávce.
- Maximální velikost souboru je 25 MB a maximální počet pracovních řádků 1 000.
- Administrátor pracuje jen s vlastními dokumenty, superadministrátor se všemi.
- E-mail a členské ID se do XLSX ani auditních metadat neexportují.
- Bezkonfliktní platné změny se aplikují automaticky; konflikty se rozhodují po celých řádcích volbou `keep_system` nebo `use_xlsx`.
- `row_version`, idempotency key, CSRF, `If-Match` a fresh-authentication se kontrolují na serveru.
- Systémová pole a původní text připomínky se importem nikdy nepřepisují.
- Při návratu ze `settled` do `open`/`under_review` se staré vypořádání zneaktivní a nový `settled` záznam vznikne jako nový aktivní záznam.
- Během implementace se spouštějí jen cílené testy změněné logiky; úplná ověřovací brána proběhne až po Tasku 7.
- Každý task končí samostatným commitem a kontrolou `git diff --check`.

## Mapa souborů a hranic

| Oblast | Soubory | Odpovědnost |
|---|---|---|
| Kontrakty a DB | `contracts/xlsx.ts`, `server/db/migrations/0010_working_xlsx.sql` | Zod/TypeScript typy, stavové enumy, tabulky a indexy |
| Export/import služby | `server/modules/xlsx/*` | snapshot, manifest, staging, třícestné porovnání, autorizace |
| API | `app/api/documents/[documentId]/xlsx-exports/route.ts`, `app/api/xlsx-exports/[jobId]/*`, `app/api/documents/[documentId]/xlsx-imports/route.ts`, `app/api/xlsx-imports/[batchId]/*` | stejno-doménové HTTP hranice |
| Worker | `worker/src/main/java/cz/sokol/conversion/xlsx/*`, `worker/pom.xml`, `WorkerMain.java` | Apache POI generování, bezpečný parsing, worker leasing |
| UI | `app/components/admin/XlsxWorkingPanel.js`, `NormAdministration.js`, `app/data/server-api-client.js`, `app/hooks/use-app-controller.js` | export, upload, stav, náhled, konflikty |
| Testy | `test/server/xlsx-*.test.ts`, `test/xlsx-working-panel.test.js`, `worker/src/test/.../xlsx/*` | cílené testy tasků a závěrečná brána |

---

### Task 1: Kontrakty, migrace a doménové invariants

**Files:**
- Create: `contracts/xlsx.ts`
- Modify: `contracts/index.ts`
- Create: `server/db/migrations/0010_working_xlsx.sql`
- Test: `test/server/xlsx-foundation.test.ts`

**Interfaces:**
- Produces `XlsxExportJob`, `XlsxImportBatch`, `XlsxImportRow`, `XlsxImportDecision`, `XlsxApplyRun`, `XlsxRowClassification`, `XlsxConflictDecision` and Zod schemas consumed by all later services/routes.
- Produces tables `xlsx_export_jobs`, `xlsx_import_batches`, `xlsx_import_rows`, `xlsx_import_decisions`, `xlsx_apply_runs`, `xlsx_row_applications` and the partial unique index for one active settlement per comment.

- [ ] **Step 1: Write failing database tests** for table presence, `.xlsx` purpose values, 1 000-row constraint, valid classifications, one active settlement, and rejection of a second active settlement.

```ts
it("allows only one active settlement per comment", async () => {
  await insertSettlement({ commentId, voidedAt: null });
  await expect(insertSettlement({ commentId, voidedAt: null })).rejects.toMatchObject({ code: "23505" });
});
```

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run test/server/xlsx-foundation.test.ts`

Expected: FAIL because the migration and contracts do not exist.

- [ ] **Step 3: Implement the migration and contracts**

Use `uuid`, `jsonb`, `row_version`, timestamps and foreign keys consistent with migrations `0001`–`0009`. Add `file_objects.purpose` values `xlsx_export` and `xlsx_import`. Add `settlements.declared_settlement_date date`, `voided_at`, `voided_by_user_id`, `void_reason`; replace the global `comment_id` uniqueness with `unique (comment_id) where voided_at is null`. Keep old settlement rows immutable through `settlement_revisions` and add the missing previous fields. Define strict Zod enums for `unchanged`, `safe_change`, `already_current`, `conflict`, `invalid`, `structural_error`, `keep_system`, and `use_xlsx`.

- [ ] **Step 4: Run the focused test**

Run: `pnpm vitest run test/server/xlsx-foundation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/xlsx.ts contracts/index.ts server/db/migrations/0010_working_xlsx.sql test/server/xlsx-foundation.test.ts
git commit -m "feat: add working xlsx data model"
```

### Task 2: Immutable export snapshot and internal export API

**Files:**
- Create: `server/modules/xlsx/xlsx-export-snapshot.ts`
- Create: `server/modules/xlsx/xlsx-export-repository.ts`
- Create: `server/modules/xlsx/xlsx-export-service.ts`
- Create: `app/api/documents/[documentId]/xlsx-exports/route.ts`
- Create: `app/api/xlsx-exports/[jobId]/route.ts`
- Create: `app/api/xlsx-exports/[jobId]/download-link/route.ts`
- Modify: `contracts/xlsx.ts`, `server/runtime.ts`, `app/data/server-api-client.js`
- Test: `test/server/xlsx-export-snapshot.test.ts`, `test/server/xlsx-export-workflows.test.ts`

**Interfaces:**
- `buildXlsxExportSnapshot(source, generatedAt): XlsxExportSnapshot` excludes e-mail/member ID and includes only active settlement data.
- `createXlsxExport(actor, documentId, input, correlationId): Promise<XlsxExportJob>`.
- `getXlsxExport(actor, jobId, correlationId): Promise<XlsxExportJob>` and `getXlsxExportDownloadFileId(...)` enforce owner/superadmin access and fresh auth for the internal working file.

- [ ] **Step 1: Write failing snapshot and authorization tests** covering deterministic SHA-256, active-only settlements, no e-mail/member ID, owner-only admin access, superadmin access, denied audit, and idempotency conflict.

```ts
it("never places email or membership id in the working snapshot", () => {
  const snapshot = buildXlsxExportSnapshot(source, "2026-08-19T12:00:00.000Z");
  expect(JSON.stringify(snapshot)).not.toContain("author@example.test");
  expect(JSON.stringify(snapshot)).not.toContain("MEM-123");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run test/server/xlsx-export-snapshot.test.ts test/server/xlsx-export-workflows.test.ts`

Expected: FAIL because the service and routes do not exist.

- [ ] **Step 3: Implement snapshot, repository, service and routes** by following `server/modules/exports/export-service.ts` and `app/api/documents/[documentId]/exports/route.ts`. Persist an immutable JSON snapshot and checksum, emit `xlsx.export.requested`, append allowed/denied audit, and return only safe job fields from HTTP.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/server/xlsx-export-snapshot.test.ts test/server/xlsx-export-workflows.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/modules/xlsx app/api/documents/[documentId]/xlsx-exports app/api/xlsx-exports contracts/xlsx.ts server/runtime.ts app/data/server-api-client.js test/server/xlsx-export-snapshot.test.ts test/server/xlsx-export-workflows.test.ts
git commit -m "feat: expose working xlsx export jobs"
```

### Task 3: Apache POI workbook generator, manifest and parser hardening

**Files:**
- Modify: `worker/pom.xml`, `worker/src/main/java/cz/sokol/conversion/WorkerMain.java`
- Create: `worker/src/main/java/cz/sokol/conversion/xlsx/XlsxExportProcessor.java`
- Create: `worker/src/main/java/cz/sokol/conversion/xlsx/XlsxWorkbookRenderer.java`
- Create: `worker/src/main/java/cz/sokol/conversion/xlsx/XlsxManifestCodec.java`
- Create: `worker/src/main/java/cz/sokol/conversion/xlsx/XlsxImportParser.java`
- Create: `worker/src/main/java/cz/sokol/conversion/xlsx/XlsxSecurityPolicy.java`
- Test: `worker/src/test/java/cz/sokol/conversion/xlsx/XlsxWorkbookRendererTest.java`
- Test: `worker/src/test/java/cz/sokol/conversion/xlsx/XlsxImportParserTest.java`
- Test: `worker/src/test/java/cz/sokol/conversion/xlsx/XlsxManifestCodecTest.java`

**Interfaces:**
- `XlsxWorkbookRenderer.render(XlsxExportSnapshot snapshot, Path output): RenderedWorkbook` creates the five approved sheets and protected/editable cells.
- `XlsxManifestCodec.sign(ManifestPayload): SignedManifest` and `verify(SignedManifest, serverSnapshot): void` use a key ID and secret supplied by `WorkerConfig`.
- `XlsxImportParser.parse(Path input, XlsxSecurityPolicy policy): ParsedWorkbook` rejects unsafe OOXML before returning rows.

- [ ] **Step 1: Add Apache POI and write RED tests** for sheet names, hidden/protected lookup sheets, locked system cells, editable settlement cells, named validation ranges, statistics, string treatment of user text, manifest signature, 1 001 rows, macros, external links, formulas and malformed ZIP input.

```java
@Test
void rejectsMoreThanOneThousandWorkingRows() {
  Path workbook = fixtureWithRows(1001);
  assertThatThrownBy(() -> parser.parse(workbook, policy))
      .isInstanceOf(XlsxValidationException.class)
      .hasMessageContaining("ROW_LIMIT");
}
```

- [ ] **Step 2: Run worker-focused tests and verify RED**

Run: `mvn -f worker/pom.xml -Dtest='cz.sokol.conversion.xlsx.*' test`

Expected: FAIL because Apache POI classes and XLSX module do not exist.

- [ ] **Step 3: Implement renderer, manifest and parser** using streaming/low-memory APIs where possible. Reject `.xlsm`, macros, external relationships, formula cells in editable columns, unexpected sheets/headers, ZIP expansion beyond policy, and row count above 1 000. Write all user text as string cells. Keep secrets out of the manifest; key material comes from environment-backed worker configuration.

- [ ] **Step 4: Wire the processor into `WorkerMain`** with the existing lease loop, Azure Blob store, ClamAV client and quarantine cleanup. A retry must read the archived import object without deleting or moving the source object.

- [ ] **Step 5: Run worker-focused tests and verify GREEN**

Run: `mvn -f worker/pom.xml -Dtest='cz.sokol.conversion.xlsx.*' test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/pom.xml worker/src/main/java/cz/sokol/conversion/WorkerMain.java worker/src/main/java/cz/sokol/conversion/xlsx worker/src/test/java/cz/sokol/conversion/xlsx
git commit -m "feat: generate and validate protected xlsx workbooks"
```

### Task 4: Import staging, třícestný merge and safe-row application

**Files:**
- Create: `server/modules/xlsx/xlsx-import-repository.ts`
- Create: `server/modules/xlsx/xlsx-import-service.ts`
- Create: `server/modules/xlsx/xlsx-three-way-merge.ts`
- Create: `server/modules/xlsx/xlsx-safe-apply-service.ts`
- Create: `app/api/documents/[documentId]/xlsx-imports/route.ts`
- Create: `app/api/xlsx-imports/[batchId]/route.ts`
- Create: `app/api/xlsx-imports/[batchId]/rows/route.ts`
- Modify: `server/modules/files/file-config.ts`, `server/modules/files/upload-service.ts`, `server/runtime.ts`
- Test: `test/server/xlsx-three-way-merge.test.ts`, `test/server/xlsx-import-workflows.test.ts`

**Interfaces:**
- `classifyRow(base, current, incoming): XlsxRowClassification` implements the exact six-way table from the spec.
- `createXlsxImport(actor, documentId, file, idempotencyKey, correlationId): Promise<XlsxImportBatch>` stages the source and enqueues parsing.
- `getXlsxImport(actor, batchId, filters, cursor): Promise<ImportPage>` returns safe public IDs and classifications.
- `applySafeRows(batchId, expectedBatchVersion, correlationId): Promise<XlsxApplyRun>` applies all safe rows in one transaction or rolls the phase back.

- [ ] **Step 1: Write RED tests** for unchanged, safe change, already current, whole-row conflict, invalid row, structural rejection, missing row as non-delete, foreign document rejection, owner/superadmin access, idempotency and safe-apply rollback.

```ts
it("classifies a whole row as conflict when two editable cells diverge", () => {
  expect(classifyRow(baseRow, currentRowWithPriorityChange, incomingRowWithStatementChange))
    .toBe("conflict");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run test/server/xlsx-three-way-merge.test.ts test/server/xlsx-import-workflows.test.ts`

Expected: FAIL because staging, merge and routes do not exist.

- [ ] **Step 3: Implement pure merge and staging repositories** with JSON canonicalization, source row-version capture, validation errors and cursor-based row listing. Fatal manifest/structure errors mark the entire batch failed; row errors remain visible without blocking other safe rows.

- [ ] **Step 4: Implement secure upload route** using the existing file configuration/object storage patterns. Require a fresh admin authentication, quarantine the upload, verify MIME/size/hash, create the immutable `file_object`, and enqueue exactly one import job with idempotency.

- [ ] **Step 5: Implement safe-row application** with `withTransaction`, `FOR UPDATE`, owner checks, current `row_version` checks, settlement lifecycle rules, domain revisions, outbox and audit. Use only active settlements in current projections.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/server/xlsx-three-way-merge.test.ts test/server/xlsx-import-workflows.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/modules/xlsx server/modules/files/file-config.ts server/modules/files/upload-service.ts server/runtime.ts app/api/documents/[documentId]/xlsx-imports app/api/xlsx-imports test/server/xlsx-three-way-merge.test.ts test/server/xlsx-import-workflows.test.ts
git commit -m "feat: stage xlsx imports and apply safe rows"
```

### Task 5: Conflict decisions, full transactional apply and audit history

**Files:**
- Create: `server/modules/xlsx/xlsx-conflict-service.ts`
- Create: `app/api/xlsx-imports/[batchId]/decisions/route.ts`
- Create: `app/api/xlsx-imports/[batchId]/apply-conflicts/route.ts`
- Create: `app/api/xlsx-imports/[batchId]/cancel/route.ts`
- Modify: `server/modules/xlsx/xlsx-import-service.ts`, `server/modules/audit/audit-writer.ts`
- Test: `test/server/xlsx-conflict-workflows.test.ts`, `test/server/xlsx-audit.test.ts`

**Interfaces:**
- `recordConflictDecision(actor, batchId, rowId, decision, expectedRowVersion, correlationId): Promise<XlsxImportDecision>`.
- `applyConflictDecisions(actor, batchId, expectedBatchVersion, correlationId): Promise<XlsxApplyRun>` applies all selected decisions atomically.
- `cancelImport(actor, batchId, correlationId): Promise<void>` is idempotent and append-audited.

- [ ] **Step 1: Write RED tests** for both decisions, whole-row semantics, missing decision rejection, stale preview rollback, admin/superadmin ownership, denied audit, active settlement uniqueness, reopen invalidation, new settlement creation, immutable decision history and sanitized audit metadata.

```ts
it("reopening a settled comment voids the old settlement and leaves no active row", async () => {
  await applyConflict({ status: "open", ...editableFields }, "use_xlsx");
  expect(await loadActiveSettlement(commentId)).toBeNull();
  expect(await loadSettlementHistory(commentId)).toHaveLength(1);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run test/server/xlsx-conflict-workflows.test.ts test/server/xlsx-audit.test.ts`

Expected: FAIL because conflict routes and apply service do not exist.

- [ ] **Step 3: Implement decision recording** with `If-Match`, append-only rows, latest-decision projection and explicit `keep_system`/`use_xlsx` enum validation.

- [ ] **Step 4: Implement conflict application** with a fresh current-state check. Lock every row, verify all selected decisions, apply the chosen row atomically, void old settlements on reopen, create a new active settlement on re-settlement, write domain revisions, `xlsx_row_applications`, outbox and audit events. A single failure rolls back the whole conflict phase.

- [ ] **Step 5: Implement complete audit coverage** for export, download, upload, scan, manifest verification, classifications, automatic safe applications, decisions, conflict applications, failures, cancel and completion. Preserve the existing hash chain and redaction rules.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/server/xlsx-conflict-workflows.test.ts test/server/xlsx-audit.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/modules/xlsx app/api/xlsx-imports server/modules/audit/audit-writer.ts test/server/xlsx-conflict-workflows.test.ts test/server/xlsx-audit.test.ts
git commit -m "feat: resolve xlsx conflicts transactionally"
```

### Task 6: Admin UI, client API and accessibility

**Files:**
- Create: `app/components/admin/XlsxWorkingPanel.js`
- Modify: `app/components/admin/NormAdministration.js`
- Modify: `app/data/server-api-client.js`, `app/hooks/use-app-controller.js`
- Modify: `app/globals.css`
- Test: `test/xlsx-working-panel.test.js`, `test/norm-administration-xlsx.test.js`

**Interfaces:**
- `XlsxWorkingPanel({ document, api, canManage })` renders export, upload, status, summary, paginated rows and conflict decisions.
- Client methods: `createXlsxExport`, `getXlsxExport`, `getXlsxExportDownloadLink`, `uploadXlsxImport`, `getXlsxImport`, `getXlsxImportRows`, `recordXlsxDecision`, `applyXlsxConflicts`, `cancelXlsxImport`.

- [ ] **Step 1: Write RED component tests** for role gating, export/download, upload, 1 000-row limit message, safe/conflict/error counters, side-by-side row preview, keep-system/use-XLSX decisions, stale response, cancel, keyboard access, focus return and ARIA live statuses.

```js
it("shows conflict actions only for a manager and exposes their decision state", async () => {
  render(h(XlsxWorkingPanel, { document, api, canManage: true }));
  expect(screen.getByRole("button", { name: "Zachovat systém" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Použít XLSX" })).toHaveAttribute("aria-pressed", "false");
});
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `pnpm vitest run test/xlsx-working-panel.test.js test/norm-administration-xlsx.test.js`

Expected: FAIL because the panel and client methods do not exist.

- [ ] **Step 3: Implement client methods** with JSON/problem-details handling, idempotency keys, `If-Match` and multipart upload.

- [ ] **Step 4: Implement the panel and integrate it** next to the existing PDF export panel. Poll queued/processing states, keep the upload input resettable, show only safe public IDs, paginate rows, and render conflict data in accessible three-column comparison. Require explicit confirmation before applying conflict decisions.

- [ ] **Step 5: Add CSS and accessibility behavior** for visible focus, minimum 44×44 action targets, responsive table-to-card layout, dialog escape/return focus and `aria-live` statuses. Do not expose internal e-mail/member ID.

- [ ] **Step 6: Run focused UI tests and verify GREEN**

Run: `pnpm vitest run test/xlsx-working-panel.test.js test/norm-administration-xlsx.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/components/admin/XlsxWorkingPanel.js app/components/admin/NormAdministration.js app/data/server-api-client.js app/hooks/use-app-controller.js app/globals.css test/xlsx-working-panel.test.js test/norm-administration-xlsx.test.js
git commit -m "feat: add admin working xlsx interface"
```

### Task 7: Operational configuration, documentation and recovery paths

**Files:**
- Modify: `worker/src/main/java/cz/sokol/conversion/WorkerConfig.java`
- Modify: `worker/Dockerfile`, `infra/local/compose.yaml`, `.env.example`
- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/operations/working-xlsx.md`
- Test: `worker/src/test/java/cz/sokol/conversion/WorkerConfigTest.java`, `test/server/xlsx-recovery.test.ts`

**Interfaces:**
- Worker configuration exposes `XLSX_MAX_BYTES=26214400`, `XLSX_MAX_ROWS=1000`, parser expansion limits, manifest key ID/secret and worker concurrency without repurposing existing environment names.
- Operator documentation explains quarantine, retry, archived input immutability, key rotation, retention, metrics and failure recovery.

- [ ] **Step 1: Write RED configuration/recovery tests** for default limits, environment override, missing signing key, retry not deleting archived input, failed batch status and cleanup after success/failure.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `mvn -f worker/pom.xml -Dtest=WorkerConfigTest test` and `pnpm vitest run test/server/xlsx-recovery.test.ts`

Expected: FAIL for new settings and recovery behavior.

- [ ] **Step 3: Implement configuration and container wiring** with non-secret defaults, secret-only environment injection, bounded concurrency, temp directory cleanup and explicit logs that exclude credentials and personal identifiers.

- [ ] **Step 4: Document operator actions** for failed scans, invalid signatures, stale previews, worker retries, key rotation and audit lookup. Document that `.xlsx` is a working admin form while PDF remains the publication/archive export.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `mvn -f worker/pom.xml -Dtest=WorkerConfigTest test` and `pnpm vitest run test/server/xlsx-recovery.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/main/java/cz/sokol/conversion/WorkerConfig.java worker/Dockerfile infra/local/compose.yaml .env.example docs/ARCHITECTURE.md docs/operations/working-xlsx.md test/server/xlsx-recovery.test.ts worker/src/test/java/cz/sokol/conversion/WorkerConfigTest.java
git commit -m "docs: operate working xlsx imports safely"
```

### Task 8: Single complete verification gate

**Files:**
- Modify only files needed for fixes found by the gate.
- Create: `docs/verification/2026-08-19-stage-d-verification.md`

- [ ] **Step 1: Apply and migrate a clean local database**

Run: `pnpm db:up` and `pnpm db:migrate`.

Expected: migration `0010_working_xlsx.sql` applies once and is idempotently recorded.

- [ ] **Step 2: Run all Java worker tests and build**

Run: `mvn -f worker/pom.xml test` and `mvn -f worker/pom.xml -DskipTests package`.

Expected: all worker tests pass and the shaded worker artifact builds.

- [ ] **Step 3: Run all TypeScript tests and type/build checks**

Run: `pnpm test`, `pnpm typecheck`, `pnpm build`.

Expected: all tests pass, typecheck is clean and production build succeeds.

- [ ] **Step 4: Run security and concurrency scenarios**

Run the XLSX malformed-file fixtures, 1 001-row rejection, changed manifest, stale preview, rollback, ownership and fresh-auth tests from Tasks 3–5.

Expected: unsafe files are rejected, no partial transaction survives, and denied operations have audit events.

- [ ] **Step 5: Run the real browser smoke**

Run: `pnpm smoke:access` plus the expanded XLSX flow: admin creates export, downloads, modifies editable cells, uploads, sees automatic safe rows, resolves one conflict, verifies final status and checks `browserErrors=[]` and `resourceErrors=[]`.

Expected: responsive mobile/desktop UI passes with no console or resource errors.

- [ ] **Step 6: Run final hygiene checks**

Run: `git diff --check`, inspect `git status --short --branch`, and confirm no `.env`, token, e-mail, member ID or generated workbook is committed.

Expected: clean worktree except the verification report before its commit.

- [ ] **Step 7: Write and commit the verification report**

Record commands, counts, migration/build versions, browser viewport, limits and any known non-blocking caveats in `docs/verification/2026-08-19-stage-d-verification.md`, then commit:

```bash
git add docs/verification/2026-08-19-stage-d-verification.md
git commit -m "test: verify working xlsx import stage"
```

## Self-review checklist

- Snapshot/export requirements map to Tasks 2–3.
- Protected workbook, manifest, code lists, validation, filters and statistics map to Task 3.
- Upload quarantine, size/row limits, parser hardening and three-way preview map to Task 4.
- Whole-row conflict decisions, atomic phases, reopen/void/new settlement behavior map to Task 5.
- Admin-only UI, ownership, responsive display and accessibility map to Task 6.
- Retry, archived input immutability, secrets, limits and operations map to Task 7.
- Full suite, security, browser smoke and final report map to Task 8.
- No task relies on an undefined later function; all cross-task interfaces are stated above.
- The final gate is intentionally deferred until after Task 7, while each task retains a small targeted RED/GREEN cycle.

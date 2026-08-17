# DOCX Ingestion, Conversion and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodat bezpečný produkční tok od nahrání DOCX přes karanténu, antivirovou kontrolu a převod až po administrátorem potvrzený blokový náhled ve stavu `ready`.

**Architecture:** Stávající Next.js/TypeScript modulární monolit přijme proudový upload, uloží metadata do PostgreSQL a binární obsah do privátního Azure Blob kompatibilního úložiště. Izolovaný Java 21 worker pronajímá úlohy z databáze, používá ClamAV, docx4j a LibreOffice, poté zapisuje bloky a nálezy; webová aplikace poskytne vlastníku dokumentu responzivní kontrolní průvodce.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Zod 4, PostgreSQL 16, `@azure/storage-blob` 12.33.0, Azurite, Java 21, Maven 3.9, docx4j 11.5.14, Azure Storage Blob Java 12.26.0, PostgreSQL JDBC 42.7.7, Jackson 2.20.1, JUnit 5.14.2, LibreOffice, ClamAV, Docker Compose, Vitest.

## Global Constraints

- Rozsah je pouze etapa B, balíčky 5–7; komentáře, vypořádání, mapování různých DOCX verzí, PDF a XLSX nejsou součástí.
- Přijímat pouze `.docx`; upload nejvýše 25 MiB a nejdéle 120 sekund.
- OOXML po rozbalení nejvýše 250 MiB, nejvýše 10 000 ZIP položek a kompresní poměr položky nejvýše 100:1.
- Aktivní VBA/OLE obsah odmítnout a externí vztahy nikdy nenačítat ze sítě.
- Kontejnery `quarantine`, `originals` a `derivatives` musí být privátní; autorizovaný odkaz smí platit nejvýše 5 minut.
- Pouze `av_status=clean` smí postoupit do archivu a parseru; infikovaný objekt se automaticky neopakuje.
- Originální DOCX je neměnný a SHA-256 před a po archivaci se musí shodovat.
- Stav verze postupuje pouze `file_check -> conversion -> conversion_review -> ready`.
- Retry je nejvýše třikrát po 1, 5 a 20 minutách; bezpečnostní odmítnutí vyžaduje nový upload.
- Administrátor spravuje jen vlastní dokumenty, superadministrátor všechny; každé povolení i zamítnutí se audituje.
- Administrátor smí měnit pouze strukturu, nikoli text; textová oprava vyžaduje nový DOCX.
- Publikované verze a jejich blokové revize jsou neměnné.
- Nové primární identifikátory jsou UUIDv7; deterministický `block_uid` používá čas verze a hash zdrojové identity.
- Komplikovanou tabulku systém doporučí jako `html`, `image_with_attachment` nebo `attachment_only`; konečnou volbu potvrzuje administrátor.
- Všechny nové uživatelské texty jsou česky, ovládání splňuje WCAG 2.2 AA a dotykové cíle mají nejméně 44 × 44 px.
- Každý úkol používá TDD, zachovává 200 stávajících testů a končí samostatným lokálním commitem.

---

### Task 1: Kontrakty a databázový základ souborů, verzí a bloků

**Files:**
- Create: `contracts/document-conversion.ts`
- Modify: `contracts/index.ts`
- Create: `server/db/migrations/0003_document_conversion.sql`
- Modify: `test/server/db-test-context.ts`
- Create: `test/server/document-conversion-foundation.test.ts`

**Interfaces:**
- Consumes: `documentStatusSchema`, `Actor`, PostgreSQL migrační běh a `resetTestDatabase()`.
- Produces: Zod schémata `documentVersionSchema`, `processingStatusSchema`, `documentBlockSchema`, `conversionFindingSchema`; tabulky `file_objects`, `document_versions`, `conversion_jobs`, `conversion_findings`, `document_blocks`, `block_revisions`, `block_assets`, `block_edit_revisions`, `security_events`.

- [ ] **Step 1: Napište selhávající kontraktní a databázový test**

```ts
import { describe, expect, it } from "vitest";
import { documentBlockSchema, processingStatusSchema } from "../../contracts";
import { migrateTestDatabase, resetTestDatabase, testSql } from "./db-test-context";

it("accepts supported conversion blocks and rejects unsafe links", () => {
  expect(documentBlockSchema.parse({
    blockUid: "018f6f9d-7e10-7000-8000-000000000001",
    blockRevisionId: "018f6f9d-7e10-7000-8000-000000000002",
    type: "paragraph", order: 0, commentable: true,
    text: "Bezpečný text", content: [{ type: "link", text: "Web", href: "https://sokol.eu" }],
  }).type).toBe("paragraph");
  expect(() => documentBlockSchema.parse({
    blockUid: crypto.randomUUID(), blockRevisionId: crypto.randomUUID(),
    type: "paragraph", order: 0, commentable: true, text: "X",
    content: [{ type: "link", text: "X", href: "javascript:alert(1)" }],
  })).toThrow();
  expect(processingStatusSchema.parse({ jobStatus: "queued", versionStatus: "file_check" }))
    .toMatchObject({ jobStatus: "queued" });
});

it("creates conversion tables and enforces one block order per version", async () => {
  await migrateTestDatabase();
  await resetTestDatabase();
  const names = await testSql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in
      ('file_objects','document_versions','conversion_jobs','conversion_findings',
       'document_blocks','block_revisions','block_assets','block_edit_revisions','security_events')
  `;
  expect(names).toHaveLength(9);
});
```

- [ ] **Step 2: Spusťte test a ověřte RED**

Run: `pnpm vitest run test/server/document-conversion-foundation.test.ts`

Expected: FAIL, protože exporty a migrace `0003_document_conversion.sql` neexistují.

- [ ] **Step 3: Přidejte přesné Zod kontrakty**

```ts
export const blockTypeSchema = z.enum([
  "heading", "paragraph", "list_item", "table", "table_image",
  "attachment_reference", "quote", "callout", "technical_separator",
]);
export const safeHrefSchema = z.string().url().refine((value) =>
  ["https:", "http:", "mailto:"].includes(new URL(value).protocol));
export const conversionJobStatusSchema = z.enum([
  "queued", "leased", "scanning", "archiving", "parsing", "rendering",
  "analyzing", "completed", "retry_wait", "failed", "rejected",
]);
export const findingSeveritySchema = z.enum(["info", "warning", "blocking"]);
export const tableRepresentationSchema = z.enum([
  "html", "image_with_attachment", "attachment_only",
]);
```

`documentBlockSchema` musí nést `blockUid`, `blockRevisionId`, `type`, `order`, `commentable`, `text`, `content`, volitelná `headingLevel`, `list`, `table` a `assets`. `processingStatusSchema` musí vracet verzi, krok, počet pokusů, bezpečný chybový kód a časy bez objektového klíče.

- [ ] **Step 4: Přidejte migraci s integritními omezeními**

V `0003_document_conversion.sql` vytvořte uvedených devět tabulek, enumy/check constraints z kontraktů, cizí klíče ke `documents` a `users`, unikátní `(document_id, version_number)`, `(document_version_id, block_order)` a `(document_version_id, block_uid)`. `conversion_jobs` musí obsahovat `lease_owner`, `lease_expires_at`, `heartbeat_at`, `attempt_count`, `next_attempt_at`, `input_sha256`, `profile_version`, `idempotency_key unique`, `error_code` a `correlation_id`. `security_events` je append-only a ukládá stabilní kód, závažnost, cílový soubor, čas a redigovaná metadata. Nové ID vkládá TypeScript/Java UUIDv7 generátor, nikoli databázový `gen_random_uuid()`. Blob klíč nesmí být součástí veřejného view.

- [ ] **Step 5: Rozšiřte testovací reset a ověřte GREEN**

Přidejte nové tabulky na začátek `truncate ... cascade` v `resetTestDatabase()` a spusťte:

Run: `pnpm vitest run test/server/document-conversion-foundation.test.ts test/server/database-foundation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add contracts server/db/migrations/0003_document_conversion.sql test/server
git commit -m "feat: add document conversion contracts and schema"
```

---

### Task 2: Privátní objektové úložiště a lokální infrastruktura

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.env.example`
- Create: `server/modules/files/object-storage.ts`
- Create: `server/modules/files/azure-blob-storage.ts`
- Create: `server/modules/files/file-config.ts`
- Modify: `server/runtime.ts`
- Modify: `infra/local/compose.yaml`
- Create: `test/server/object-storage.test.ts`

**Interfaces:**
- Consumes: Azure Storage connection string a privátní kontejnery z prostředí.
- Produces: `ObjectStorage` s metodami `putQuarantine`, `open`, `copyIfAbsent`, `delete`, `createReadUrl`; `fileConfig()` s pevnými bezpečnostními limity.

- [ ] **Step 1: Napište selhávající integrační test úložiště**

```ts
it("keeps blobs private and issues a five-minute single-blob read URL", async () => {
  const storage = createAzureBlobStorage(testFileConfig());
  await storage.ensureContainers();
  const stored = await storage.putQuarantine({
    objectKey: "test/input.docx", body: Readable.from([Buffer.from("PK\u0003\u0004payload")]),
    contentType: DOCX_MIME,
  });
  expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(fetch(`${testFileConfig().blobEndpoint}/quarantine/${stored.objectKey}`))
    .resolves.toMatchObject({ status: 404 });
  const signed = await storage.createReadUrl("quarantine", stored.objectKey, 300);
  expect(new URL(signed).searchParams.has("sig")).toBe(true);
});
```

- [ ] **Step 2: Spusťte Azurite a ověřte RED**

Run: `docker compose -f infra/local/compose.yaml up -d --wait postgres azurite`

Run: `pnpm vitest run test/server/object-storage.test.ts`

Expected: FAIL, protože služba `azurite` a adaptér úložiště neexistují.

- [ ] **Step 3: Přidejte závislost a konfiguraci**

Run: `pnpm add @azure/storage-blob@12.33.0`

```ts
export interface FileConfig {
  connectionString: string;
  blobEndpoint: string;
  quarantineContainer: "quarantine";
  originalsContainer: "originals";
  derivativesContainer: "derivatives";
  maxUploadBytes: 25 * 1024 * 1024;
  maxUnpackedBytes: 250 * 1024 * 1024;
  maxEntries: 10_000;
  maxCompressionRatio: 100;
  readUrlTtlSeconds: 300;
}
```

Konfigurace musí při startu odmítnout veřejný endpoint, chybějící tajemství a TTL nad 300 sekund.

- [ ] **Step 4: Implementujte adaptér bez veřejného přístupu**

`putQuarantine()` musí uploadovat proudově, průběžně počítat SHA-256 a vracet `{ sizeBytes, sha256, etag }`. `copyIfAbsent()` musí používat podmínku `If-None-Match: *`; při existujícím objektu ověří uložený hash. `createReadUrl()` smí vystavit jen oprávnění `r`, jeden objekt a nejvýše 300 sekund.

- [ ] **Step 5: Doplňte Azurite a ClamAV do Compose**

```yaml
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite:3.35.0
    command: azurite-blob --blobHost 0.0.0.0 --loose
    ports: ["127.0.0.1:10000:10000"]
    volumes: ["sokol_azurite_data:/data"]
  clamav:
    image: clamav/clamav:stable-debian
    ports: ["127.0.0.1:3310:3310"]
    healthcheck:
      test: ["CMD", "/usr/local/bin/clamdcheck.sh"]
      interval: 10s
      timeout: 5s
      retries: 30
```

Přidejte pojmenovaný volume pro Azurite a proměnné `AZURE_STORAGE_CONNECTION_STRING`, `CLAMAV_HOST`, `CLAMAV_PORT` do `.env.example` bez reálných tajemství.

- [ ] **Step 6: Ověřte GREEN a commit**

Run: `pnpm vitest run test/server/object-storage.test.ts`

Expected: PASS a anonymní Blob URL vrací 404.

```bash
git add package.json pnpm-lock.yaml .env.example server/modules/files server/runtime.ts infra/local/compose.yaml test/server/object-storage.test.ts
git commit -m "feat: add private blob storage foundation"
```

---

### Task 3: Proudový upload, OOXML obal a založení převodní úlohy

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `server/modules/files/docx-envelope-validator.ts`
- Create: `server/modules/files/file-repository.ts`
- Create: `server/modules/files/upload-service.ts`
- Create: `app/api/documents/[documentId]/versions/uploads/route.ts`
- Create: `test/fixtures/docx/valid-minimal.docx`
- Create: `test/fixtures/docx/fake-extension.docx`
- Create: `test/server/document-upload.test.ts`

**Interfaces:**
- Consumes: `ObjectStorage`, `FileConfig`, `DocumentService.getManagedDocument()`, audit/outbox a `Idempotency-Key`.
- Produces: `uploadService.accept(actor, documentId, request, command): Promise<{versionId, jobId, status:"file_check"}>`.

- [ ] **Step 1: Vytvořte bezpečné fixtures a selhávající testy**

Test musí pokrýt platný minimální DOCX, falešnou příponu, špatný MIME, chybějící `[Content_Types].xml`, soubor nad 25 MiB, znovupoužití idempotency key a cizího administrátora.

```ts
it("accepts one valid DOCX and creates one queued job", async () => {
  const response = await upload(owner.actor, document.id, fixture("valid-minimal.docx"), key);
  expect(response).toMatchObject({ status: "file_check" });
  expect(await testSql`select * from conversion_jobs where id = ${response.jobId}`).toHaveLength(1);
  expect(await testSql`select * from outbox_events where idempotency_key = ${key}`).toHaveLength(1);
});

it("rejects a foreign administrator and audits the denial", async () => {
  await expect(upload(other.actor, document.id, fixture("valid-minimal.docx"), crypto.randomUUID()))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await testSql`select * from audit_events where action = 'document.upload_denied'`)
    .toHaveLength(1);
});
```

- [ ] **Step 2: Spusťte test a ověřte RED**

Run: `pnpm vitest run test/server/document-upload.test.ts`

Expected: FAIL na chybějící `createUploadService` a upload route.

- [ ] **Step 3: Implementujte omezený proud a validátor obalu**

Run: `pnpm add yauzl@3.4.0 && pnpm add -D @types/yauzl@3.4.0`

`docx-envelope-validator.ts` musí před uložením ověřit název, MIME a první bajty `PK\x03\x04`; proud zapisuje do náhodného souboru v OS temp adresáři, zastaví na 25 MiB nebo 120 sekund a vždy uklidí temp soubor. Poté přes `yauzl.openPromise(path, { lazyEntries: true, validateEntrySizes: true })` ověří `[Content_Types].xml`, `word/document.xml`, počet položek, rozbalenou velikost, poměr a zákaz `vbaProject.bin`/OLE. Cesty se zpětným lomítkem, absolutní cesty a segmenty `..` odmítne.

- [ ] **Step 4: Implementujte transakční upload service**

Po úspěšné validaci uploadujte temp soubor do `quarantine/{documentId}/{versionId}/{fileId}.docx`. V jedné transakci vložte `file_objects`, `document_versions`, `conversion_jobs`, nastavte dokument na `file_check`, zvyšte `documents.row_version`, přidejte `document.conversion_queued` do outboxu a `document.uploaded` do auditu. Idempotentní replay vrátí původní `versionId/jobId`; stejný klíč s jiným hashem vrátí `IDEMPOTENCY_CONFLICT`.

- [ ] **Step 5: Implementujte route**

Route přijme raw tělo s hlavičkami `Content-Type`, `Content-Length`, `X-File-Name`, `Idempotency-Key` a `If-Match`. Použijte existující `request-context`, session, CSRF a Problem Details. Úspěch vrací `202` a `{ versionId, jobId, status, processingUrl }`.

- [ ] **Step 6: Ověřte GREEN, regresi a commit**

Run: `pnpm vitest run test/server/document-upload.test.ts test/server/document-workflows.test.ts test/server/transactional-audit.test.ts`

Expected: PASS.

```bash
git add package.json pnpm-lock.yaml server/modules/files app/api/documents test/fixtures/docx test/server/document-upload.test.ts
git commit -m "feat: accept secure DOCX uploads"
```

---

### Task 4: Java worker, pronájem úloh, ClamAV a neměnný originál

**Files:**
- Create: `worker/pom.xml`
- Create: `worker/src/main/java/cz/sokol/conversion/WorkerMain.java`
- Create: `worker/src/main/java/cz/sokol/conversion/WorkerConfig.java`
- Create: `worker/src/main/java/cz/sokol/conversion/JobLeaseRepository.java`
- Create: `worker/src/main/java/cz/sokol/conversion/BlobStore.java`
- Create: `worker/src/main/java/cz/sokol/conversion/ClamAvClient.java`
- Create: `worker/src/main/java/cz/sokol/conversion/ConversionProcessor.java`
- Create: `worker/src/main/java/cz/sokol/conversion/QuarantineRetention.java`
- Create: `worker/src/test/java/cz/sokol/conversion/JobLeaseRepositoryTest.java`
- Create: `worker/src/test/java/cz/sokol/conversion/ClamAvClientTest.java`
- Create: `worker/src/test/java/cz/sokol/conversion/QuarantineRetentionTest.java`
- Create: `worker/Dockerfile`
- Modify: `infra/local/compose.yaml`

**Interfaces:**
- Consumes: `conversion_jobs`, Azure Blob kontejnery a ClamAV INSTREAM na TCP 3310.
- Produces: idempotentní kroky `scanAndArchive(job)`, stavové přechody a čistý objekt v `originals` se shodným SHA-256.

- [ ] **Step 1: Napište selhávající JUnit testy pronájmu a AV výsledků**

```java
@Test void onlyOneWorkerLeasesAQueuedJob() throws Exception {
  var first = repo.leaseNext("worker-a", now);
  var second = repo.leaseNext("worker-b", now);
  assertTrue(first.isPresent());
  assertTrue(second.isEmpty());
}

@Test void classifiesClamResponsesWithoutLeakingRawOutput() {
  assertEquals(AvStatus.CLEAN, client.classify("stream: OK"));
  assertEquals(AvStatus.INFECTED, client.classify("stream: Eicar-Signature FOUND"));
  assertThrows(AvProtocolException.class, () -> client.classify("unexpected secret path"));
}
```

- [ ] **Step 2: Spusťte Maven test a ověřte RED**

Run: `docker run --rm -v "${PWD}/worker:/workspace" -w /workspace maven:3.9.11-eclipse-temurin-21 mvn test`

Expected: FAIL, protože worker třídy neexistují.

- [ ] **Step 3: Založte Maven modul s přesnými závislostmi**

`pom.xml` nastaví Java release 21 a závislosti `docx4j-JAXB-ReferenceImpl:11.5.14`, `azure-storage-blob:12.26.0`, `postgresql:42.7.7`, `jackson-databind:2.20.1`, `slf4j-simple` a testovací `junit-jupiter:5.14.2`. Shade plugin vytvoří jeden spustitelný JAR s hlavní třídou `WorkerMain`.

- [ ] **Step 4: Implementujte bezpečný pronájem a retry**

```sql
with candidate as (
  select id from conversion_jobs
  where status in ('queued','retry_wait') and coalesce(next_attempt_at, now()) <= now()
    and (lease_expires_at is null or lease_expires_at < now())
  order by created_at for update skip locked limit 1
)
update conversion_jobs j
set status='leased', lease_owner=?, lease_expires_at=now()+interval '2 minutes', heartbeat_at=now()
from candidate where j.id=candidate.id returning j.*
```

Retry prodlevy jsou přesně 1, 5 a 20 minut. Čtvrtá přechodná chyba nastaví `failed`; malware nebo neplatný OOXML nastaví `rejected` bez retry.

- [ ] **Step 5: Implementujte AV a archivaci**

`ClamAvClient` použije příkaz `zINSTREAM\0`, 64 KiB chunky a ukončovací nulový chunk. `ConversionProcessor` načte objekt pouze z karantény, nastaví `scanning`, uloží `av_status`, při `clean` provede server-side copy-if-absent do `originals/{documentId}/{versionId}/{sha256}.docx`, znovu ověří SHA-256 a až poté smaže karanténní kopii. `infected` vytvoří `security_events` a nikdy nevolá parser.

- [ ] **Step 6: Přidejte neprivilegovaný worker kontejner**

`worker/Dockerfile` má Maven build stage, explicitní `test` stage s `RUN mvn test` a runtime s Java 21 + LibreOffice headless a `poppler-utils`. Runtime vytvoří uživatele UID 10001, používá omezený `/tmp/conversion`, nemá shellový entrypoint a spouští `java -jar /app/worker.jar`.

- [ ] **Step 7: Implementujte řízenou sedmidenní retenci karantény**

`QuarantineRetention.purge(now)` vybere pouze objekty se stavem `rejected`, `created_at < now - interval '7 days'` a bez aktivní bezpečnostní blokace. Nejprve odstraní konkrétní Blob s podmínkou na uložený ETag, potom v transakci nastaví stav `deleted`, `deleted_at` a zapíše audit. Čisté originály, nedokončené kontroly a objekty s `legal_hold=true` se nikdy nevyberou. JUnit test musí zmrazit čas a ověřit všechny čtyři větve.

- [ ] **Step 8: Ověřte GREEN a commit**

Run: `docker compose -f infra/local/compose.yaml up -d --wait postgres azurite clamav`

Run: `docker build -f worker/Dockerfile --target test worker`

Expected: JUnit PASS, jeden lease a EICAR skončí `rejected` bez objektu v `originals`.

```bash
git add worker infra/local/compose.yaml
git commit -m "feat: scan and archive DOCX in conversion worker"
```

---

### Task 5: Deterministický DOCX parser a stabilní bloky

**Files:**
- Create: `contracts/schemas/conversion-result.schema.json`
- Create: `worker/src/main/java/cz/sokol/conversion/model/ConversionResult.java`
- Create: `worker/src/main/java/cz/sokol/conversion/DocxParser.java`
- Create: `worker/src/main/java/cz/sokol/conversion/StableBlockId.java`
- Create: `worker/src/main/java/cz/sokol/conversion/SafeLink.java`
- Create: `worker/src/test/java/cz/sokol/conversion/DocxParserGoldenTest.java`
- Create: `test/fixtures/docx/supported-elements.docx`
- Create: `test/fixtures/docx/bookmarks-and-ids.docx`
- Create: `test/fixtures/docx/unsafe-links.docx`
- Create: `test/fixtures/docx/expected/supported-elements.json`

**Interfaces:**
- Consumes: čistý archivovaný DOCX.
- Produces: `ConversionResult { profileVersion, blocks, findings, sourceSha256 }` odpovídající JSON Schema; stabilní `blockUid` pro stejný vstup.

- [ ] **Step 1: Napište golden test před implementací**

```java
@Test void parsesSupportedElementsIntoStableBlocks() throws Exception {
  var first = parser.parse(fixture("supported-elements.docx"), SOURCE_SHA, PROFILE);
  var second = parser.parse(fixture("supported-elements.docx"), SOURCE_SHA, PROFILE);
  assertEquals(expectedJson("supported-elements.json"), canonicalJson(first));
  assertEquals(first.blocks().stream().map(Block::blockUid).toList(),
               second.blocks().stream().map(Block::blockUid).toList());
}

@Test void removesUnsafeProtocolsAndReportsThem() throws Exception {
  var result = parser.parse(fixture("unsafe-links.docx"), sha(), PROFILE);
  assertTrue(result.findings().stream().anyMatch(f -> f.code().equals("UNSAFE_LINK_REMOVED")));
  assertFalse(canonicalJson(result).contains("javascript:"));
}
```

- [ ] **Step 2: Spusťte test a ověřte RED**

Run: `docker build -f worker/Dockerfile --target test worker`

Expected: FAIL na chybějící parser/model.

- [ ] **Step 3: Definujte jeden přenosný JSON kontrakt**

Schema musí uzavřít nepovolená pole (`additionalProperties: false`) a popsat všechny bloky, inline runy, list metadata, tabulkové buňky, assets a finding. `profileVersion` začíná `docx-web-v1`.

- [ ] **Step 4: Implementujte parser podporovaných prvků**

Mapujte Word styly a outline level na `heading`, běžné odstavce na `paragraph`, numbering properties na `list_item`, tabulky na `table`, citace/callout podle explicitní mapy stylů a prázdné technické zlomy na `technical_separator`. Inline run zachová `bold`, `italic`, `underline`, `highlight`; vztahy projdou `SafeLink`, který povolí jen `http`, `https`, `mailto`.

- [ ] **Step 5: Implementujte deterministický UUIDv7 identifikátor**

`StableBlockId` použije čas verze dokumentu pro prvních 48 bitů UUIDv7 a prvních 74 bitů SHA-256 seedu. Seed je nejprve bookmark/`w14:paraId`; jinak `headingPath + type + normalizedText + previousHash + nextHash + collisionIndex`. Stejný dokument, čas verze a profil musí dát stejný `blockUid`.

- [ ] **Step 6: Aktualizujte golden snapshot pouze po ruční kontrole**

Run: `docker build -f worker/Dockerfile --target test worker`

Expected: PASS; snapshot obsahuje nadpis, odstavec, číslovaný i odrážkový seznam, tabulku, zvýraznění a bezpečný odkaz.

- [ ] **Step 7: Commit**

```bash
git add contracts/schemas worker/src test/fixtures/docx
git commit -m "feat: convert DOCX into stable structured blocks"
```

---

### Task 6: Referenční render a doporučení komplikovaných tabulek

**Files:**
- Create: `worker/src/main/java/cz/sokol/conversion/LibreOfficeRenderer.java`
- Create: `worker/src/main/java/cz/sokol/conversion/TableComplexityAnalyzer.java`
- Create: `worker/src/main/java/cz/sokol/conversion/TableImageExtractor.java`
- Modify: `worker/src/main/java/cz/sokol/conversion/ConversionProcessor.java`
- Create: `worker/src/test/java/cz/sokol/conversion/TableComplexityAnalyzerTest.java`
- Create: `worker/src/test/java/cz/sokol/conversion/LibreOfficeRendererTest.java`
- Create: `test/fixtures/docx/complex-tables.docx`

**Interfaces:**
- Consumes: AST a čistý originál.
- Produces: referenční PDF/stránky v `derivatives`, `TableRecommendation` a případný `table_image` asset.

- [ ] **Step 1: Napište selhávající rozhodovací testy**

```java
@ParameterizedTest
@CsvSource({
  "0,0,5,20,false,html",
  "3,0,8,40,false,image_with_attachment",
  "1,1,25,220,true,attachment_only"
})
void recommendsRepresentation(int merges, int nested, int columns, int rows,
                              boolean renderMismatch, String expected) {
  assertEquals(expected, analyzer.analyze(metrics(merges,nested,columns,rows,renderMismatch))
    .recommendation().code());
}
```

- [ ] **Step 2: Spusťte test a ověřte RED**

Run: `docker build -f worker/Dockerfile --target test worker`

Expected: FAIL na chybějící analyzer/renderer.

- [ ] **Step 3: Implementujte explicitní skóre tabulky**

Skóre: +3 za každé sloučení, +10 za vnořenou tabulku, +10 nad 20 sloupců, +10 nad 200 řádků, +5 za obrázek/textové pole/více odstavců v buňce, +15 za render mismatch. `0–9 => html`, `10–29 => image_with_attachment`, `30+ => attachment_only`. Uložte skóre i jednotlivé důvody, aby UI vysvětlilo doporučení.

- [ ] **Step 4: Implementujte sandboxovaný LibreOffice proces**

Spouštějte `soffice --headless --nologo --nodefault --nolockcheck --nofirststartwizard --convert-to pdf --outdir <jobDir> <docx>`, s prázdným uživatelským profilem, pracovním adresářem konkrétní úlohy, timeoutem 180 sekund a maximálně jedním procesem na úlohu. Síť worker kontejneru omezte pouze na PostgreSQL, Blob a ClamAV; výstup procesu redigujte na stabilní kódy.

- [ ] **Step 5: Vytvořte deriváty a nálezy**

Referenční PDF uložte podle hashe do `derivatives/{documentId}/{versionId}/reference/{sha256}.pdf`. Pro obrazovou tabulku vytvořte PNG výřez, vazbu na originál jako přílohu a blokující finding `ALT_TEXT_REQUIRED`. Odchylka renderu vytvoří `TABLE_RENDER_MISMATCH`.

- [ ] **Step 6: Ověřte GREEN a commit**

Run: `docker build -f worker/Dockerfile --target test worker`

Expected: PASS a fixture vytvoří všechna tři doporučení.

```bash
git add worker test/fixtures/docx/complex-tables.docx infra/local/compose.yaml
git commit -m "feat: render DOCX and classify complex tables"
```

---

### Task 7: Atomické uložení převodu, nálezy a podmínky `ready`

**Files:**
- Create: `server/modules/conversion/conversion-repository.ts`
- Create: `server/modules/conversion/conversion-service.ts`
- Create: `server/modules/conversion/readiness-policy.ts`
- Modify: `server/runtime.ts`
- Modify: `worker/src/main/java/cz/sokol/conversion/ConversionProcessor.java`
- Create: `test/server/conversion-workflows.test.ts`
- Create: `worker/src/test/java/cz/sokol/conversion/ConversionPersistenceTest.java`

**Interfaces:**
- Consumes: dokončený `ConversionResult`, aktéra a `VersionedCommand`.
- Produces: `getProcessing`, `getPreview`, `retry`, `editBlockStructure`, `decideFinding`, `completeReview`; atomický přechod `conversion_review -> ready`.

- [ ] **Step 1: Napište selhávající policy a autorizační testy**

```ts
it.each([
  ["AV není čisté", { avStatus: "pending" }],
  ["úloha není dokončená", { jobStatus: "rendering" }],
  ["blokující nález", { openBlockingFindings: 1 }],
  ["chybí alt text", { missingAltTexts: 1 }],
  ["není blok", { blockCount: 0 }],
])("blocks ready when %s", async (_label, override) => {
  await expect(service.completeReview(owner.actor, version.id, command(), override))
    .rejects.toMatchObject({ code: "VERSION_NOT_READY" });
});

it("rejects a structural edit that changes normalized text", async () => {
  await expect(service.editBlockStructure(owner.actor, version.id, block.uid, {
    rowVersion: version.rowVersion, reason: "Oprava typu", type: "heading",
    text: "Jiný text",
  })).rejects.toMatchObject({ code: "TEXT_CHANGE_REQUIRES_DOCX" });
});
```

- [ ] **Step 2: Spusťte test a ověřte RED**

Run: `pnpm vitest run test/server/conversion-workflows.test.ts`

Expected: FAIL na chybějící conversion service.

- [ ] **Step 3: Ukládejte výsledek workeru atomicky**

V jedné transakci ověřte lease a input SHA-256, vložte nové `document_blocks`, `block_revisions`, `block_assets`, `conversion_findings`, nastavte job `completed`, verzi i dokument `conversion_review`, přidejte audit/outbox. Při retry nejprve smažte pouze nepublikovaný neúspěšný derivovaný výstup dané úlohy; archivní originál se nikdy nemaže.

- [ ] **Step 4: Implementujte strukturální editace jako nové revize**

Povolené operace jsou změna typu, komentovatelnosti, hranic bez změny pořadí znaků, technického oddělovače, pořadí technicky chybného bloku, tabulkové reprezentace a alt textu. Porovnejte normalizovaný text před/po; při rozdílu vraťte `TEXT_CHANGE_REQUIRES_DOCX`. Vložte `block_edit_revisions`, novou `block_revision`, zvyšte `row_version` a auditujte důvod.

- [ ] **Step 5: Implementujte readiness policy**

```ts
export function readinessFailures(snapshot: ReadinessSnapshot): ReadinessFailure[] {
  return [
    snapshot.avStatus !== "clean" && { code: "AV_NOT_CLEAN", message: "Soubor není bezpečnostně ověřen." },
    snapshot.jobStatus !== "completed" && { code: "CONVERSION_NOT_COMPLETE", message: "Převod není dokončen." },
    snapshot.blockCount < 1 && { code: "NO_BLOCKS", message: "Dokument neobsahuje platný blok." },
    snapshot.openBlockingFindings > 0 && { code: "BLOCKING_FINDINGS", message: "Zůstávají závažné nálezy." },
    snapshot.unconfirmedTables > 0 && { code: "TABLE_DECISION_REQUIRED", message: "Potvrďte zobrazení tabulek." },
    snapshot.missingAltTexts > 0 && { code: "ALT_TEXT_REQUIRED", message: "Doplňte alternativní popisy." },
  ].filter(Boolean) as ReadinessFailure[];
}
```

`completeReview()` načte snapshot a zamkne verzi v jedné transakci, ověří aktuální `row_version`, zapíše potvrzujícího admina a posune dokument/verzi do `ready` jen při prázdném seznamu.

- [ ] **Step 6: Ověřte GREEN a commit**

Run: `pnpm vitest run test/server/conversion-workflows.test.ts test/server/document-workflows.test.ts`

Run: `docker build -f worker/Dockerfile --target test worker`

Expected: PASS.

```bash
git add server/modules/conversion server/runtime.ts worker/src test/server/conversion-workflows.test.ts
git commit -m "feat: persist conversion review and readiness"
```

---

### Task 8: Interní API, autorizované stažení a klient

**Files:**
- Create: `app/api/document-versions/[versionId]/processing/route.ts`
- Create: `app/api/document-versions/[versionId]/preview/route.ts`
- Create: `app/api/document-versions/[versionId]/review-completion/route.ts`
- Create: `app/api/document-versions/[versionId]/blocks/[blockUid]/route.ts`
- Create: `app/api/conversion-jobs/[jobId]/retry/route.ts`
- Create: `app/api/conversion-findings/[findingId]/decision/route.ts`
- Create: `app/api/file-objects/[fileId]/download-link/route.ts`
- Modify: `app/data/server-api-client.js`
- Create: `test/server/conversion-routes.test.ts`
- Modify: `test/server/server-api-client.test.js`

**Interfaces:**
- Consumes: `conversionService`, session/CSRF/Problem Details a `ObjectStorage.createReadUrl()`.
- Produces: API operace definované ve specifikaci a klientské metody stejného názvu.

- [ ] **Step 1: Napište selhávající route contract test**

```ts
it("never exposes blob keys and denies a foreign admin", async () => {
  const allowed = await GET(previewRequest(ownerCookie), { params: Promise.resolve({ versionId }) });
  expect(allowed.status).toBe(200);
  expect(await allowed.text()).not.toMatch(/objectKey|connectionString|sig=/);
  const denied = await GET(previewRequest(otherCookie), { params: Promise.resolve({ versionId }) });
  expect(denied.status).toBe(403);
  expect((await denied.json()).code).toBe("FORBIDDEN");
});
```

- [ ] **Step 2: Spusťte test a ověřte RED**

Run: `pnpm vitest run test/server/conversion-routes.test.ts test/server/server-api-client.test.js`

Expected: FAIL na chybějící routes/client metody.

- [ ] **Step 3: Implementujte tenké route adaptéry**

Každá route pouze parsuje Zod vstup, získá aktéra/correlation ID, ověří CSRF pro zápis a volá jednu metodu conversion service. `PATCH block` a `review-completion` vyžadují `If-Match`; upload/retry vyžaduje `Idempotency-Key`. Úspěšný processing GET nastaví `Cache-Control: no-store`.

- [ ] **Step 4: Implementujte stažení bez úniku klíče**

Route ověří, že soubor patří verzi spravovaného dokumentu a má `av_status=clean`. Vrátí pouze `{ url, expiresAt }`; originál je dostupný adminovi vlastníka a superadminovi, referenční derivát stejným rolím. Audit ukládá `fileId`, nikoli URL.

- [ ] **Step 5: Rozšiřte server API client**

Přidejte `uploadDocumentVersion`, `getConversionProcessing`, `getConversionPreview`, `retryConversion`, `updateBlockStructure`, `decideConversionFinding`, `completeConversionReview`, `createFileDownloadLink`. Upload musí poslat raw `File`, přesný MIME, URL-encoded `X-File-Name`, CSRF, `If-Match` a idempotency key.

- [ ] **Step 6: Ověřte GREEN a commit**

Run: `pnpm vitest run test/server/conversion-routes.test.ts test/server/server-api-client.test.js test/server/server-security.test.ts`

Expected: PASS a žádná odpověď neobsahuje blob klíč nebo podpis.

```bash
git add app/api app/data/server-api-client.js test/server
git commit -m "feat: expose secure conversion review API"
```

---

### Task 9: Responzivní administrační průvodce převodem

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `app/components/admin/DocumentConversionWizard.js`
- Create: `app/components/admin/ConversionProgress.js`
- Create: `app/components/admin/ConversionPreview.js`
- Create: `app/components/admin/ConversionFindings.js`
- Create: `app/components/admin/BlockStructureEditor.js`
- Modify: `app/components/admin/NormAdministration.js`
- Modify: `app/hooks/use-app-controller.js`
- Modify: `app/globals.css`
- Create: `test/document-conversion-wizard.test.js`
- Modify: `test/norm-views.test.js`

**Interfaces:**
- Consumes: metody API klienta z Task 8 a kontrakty preview/processing.
- Produces: čtyřkrokový průvodce `upload`, `compare`, `structure`, `summary`, který po potvrzení obnoví dokument se stavem `ready`.

- [ ] **Step 1: Napište selhávající UI testy**

```js
it("accepts only DOCX and announces processing progress", async () => {
  render(h(DocumentConversionWizard, { document, api, onReady }));
  const input = screen.getByLabelText("Nahrát dokument DOCX");
  expect(input).toHaveAttribute("accept", ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await user.upload(input, docxFile);
  expect(await screen.findByRole("status")).toHaveTextContent("Antivirová kontrola");
});

it("shows mobile preview tabs and blocks completion with unresolved findings", async () => {
  render(h(DocumentConversionWizard, { document, api: blockingApi, onReady }));
  expect(await screen.findByRole("tab", { name: "Webový dokument" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Referenční náhled" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Potvrdit náhled" })).toBeDisabled();
});
```

- [ ] **Step 2: Spusťte test a ověřte RED**

Run: `pnpm vitest run test/document-conversion-wizard.test.js test/norm-views.test.js`

Expected: FAIL na chybějící wizard.

- [ ] **Step 3: Připojte upload a bezpečné sledování stavu**

Run: `pnpm add @tanstack/react-virtual@3.14.9`

Nahraďte pole „Nahrát PDF, DOCX nebo ODT“ jediným DOCX vstupem a otevřete wizard. Po `202` dotazujte processing po 2 sekundách, při skryté kartě dotazování pozastavte a po návratu ihned obnovte. `failed` nabídne retry, `rejected` pouze nový upload. `aria-live=polite` oznamuje změny kroku bez zahlcení.

- [ ] **Step 4: Implementujte porovnání a nálezy**

Desktop používá dva synchronizované panely; mobil role `tablist/tab/tabpanel`. Kliknutí na nález zaostří blok a posune oba náhledy. Nálezy zobrazují český text, závažnost a povolené rozhodnutí; surová diagnostika není v UI.

- [ ] **Step 5: Implementujte strukturální editor**

Editor nabízí pouze povolené typy, komentovatelnost, rozdělení/sloučení hranic, technický oddělovač, tabulkovou reprezentaci a alt text. Text je `readOnly`. Uložení vyžaduje důvod a používá aktuální `rowVersion`; konflikt 409 načte nový náhled a zachová neodeslanou volbu k porovnání.

- [ ] **Step 6: Implementujte souhrn a přístupnost**

Souhrn ukáže počet bloků/tabulek/nálezů a úplný seznam blokátorů. Tlačítko „Potvrdit náhled“ je dostupné jen při nulových blokátorech, ale serverová kontrola zůstává autoritativní. Přidejte viditelný fokus, 44px cíle, reduced motion a virtualizaci po 300 blocích bez odstranění aktivního bloku z accessibility tree.

- [ ] **Step 7: Ověřte GREEN a commit**

Run: `pnpm vitest run test/document-conversion-wizard.test.js test/norm-views.test.js`

Run: `pnpm typecheck`

Expected: PASS.

```bash
git add package.json pnpm-lock.yaml app/components/admin app/hooks/use-app-controller.js app/globals.css test/document-conversion-wizard.test.js test/norm-views.test.js
git commit -m "feat: add accessible DOCX review wizard"
```

---

### Task 10: Produkční Docker tok, browserový smoke a dokumentace

**Files:**
- Modify: `Dockerfile`
- Modify: `infra/local/compose.yaml`
- Modify: `package.json`
- Create: `scripts/smoke-conversion.mjs`
- Create: `test/server/docx-ingestion-acceptance.test.ts`
- Create: `server/modules/conversion/conversion-metrics.ts`
- Modify: `server/health-service.ts`
- Modify: `app/api/health/ready/route.ts`
- Create: `test/server/conversion-observability.test.ts`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Create: `docs/operations/docx-conversion-runbook.md`

**Interfaces:**
- Consumes: kompletní balíčky Tasks 1–9.
- Produces: jedním příkazem spustitelný stack, úplný produkční smoke a provozní postup pro chyby/AV/retry/retenci.

- [ ] **Step 1: Napište selhávající akceptační test**

```ts
it("moves a clean DOCX through quarantine, conversion, review and ready", async () => {
  const accepted = await uploadFixture("supported-elements.docx");
  await runWorkerUntilIdle();
  const preview = await conversion.getPreview(owner.actor, accepted.versionId);
  expect(preview.blocks.map((block) => block.type)).toEqual(
    expect.arrayContaining(["heading", "paragraph", "list_item", "table"]),
  );
  await confirmAllTableRecommendations(preview);
  const ready = await conversion.completeReview(owner.actor, accepted.versionId, command(preview.rowVersion));
  expect(ready.status).toBe("ready");
});
```

Přidejte negativní akceptaci pro EICAR, cizího administrátora, textovou změnu, chybějící alt text a veřejný Blob URL.

- [ ] **Step 2: Spusťte test a ověřte RED**

Run: `pnpm vitest run test/server/docx-ingestion-acceptance.test.ts`

Expected: FAIL, dokud stack/worker test helper a všechny vazby nejsou dokončeny.

- [ ] **Step 3: Dokončete Compose a image buildy**

Compose musí obsahovat `postgres`, `azurite`, `clamav`, `migrate`, `worker`, `web`, oddělené healthchecky, privátní interní síť a pouze lokálně publikované porty webu/PostgreSQL/Azurite. Worker nastavte `read_only: true`, `tmpfs: /tmp/conversion`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, paměť 1 GiB a 1 CPU. Web obdobně běží non-root a nemá přímý přístup ke ClamAV.

- [ ] **Step 4: Rozšiřte smoke o skutečný browserový scénář**

`scripts/smoke-conversion.mjs` musí automaticky:

1. sestavit image a spustit čistý stack;
2. provést migrace a založit testovacího admina;
3. přihlásit admina v reálném browseru;
4. vytvořit dokument a nahrát `supported-elements.docx`;
5. čekat na `conversion_review` bez pevného sleepu;
6. otevřít nález a potvrdit reprezentaci tabulky;
7. provést povolenou strukturální opravu a potvrdit náhled;
8. ověřit stav `ready` a zákaz cizímu adminovi;
9. zopakovat UI kontrolu při šířce 390 px;
10. ověřit `browserErrors=[]`, `resourceErrors=[]` a uvolnění portů/profilu po cleanupu.

- [ ] **Step 5: Doplňte provozní dokumentaci**

README popíše `docker compose up --build --wait`, migraci, worker a bezpečné testovací přihlášení. SECURITY vysvětlí karanténu, AV, zakázaný aktivní obsah a hlášení incidentu. Runbook obsahuje přesné rozhodovací postupy pro `infected`, nedostupný ClamAV/Blob, starou lease, `failed`, ruční retry a sedmidenní odstranění zamítnuté karantény; nesmí obsahovat tajemství.

- [ ] **Step 6: Přidejte provozní metriky a readiness závislostí**

`conversion-metrics.ts` vrátí agregace `queue_depth`, `oldest_queued_seconds`, počty `retry_wait/failed/rejected`, doby kroků a otevřené nálezy podle kódu; nesmí vracet název souboru ani osobní údaje. Readiness vrátí 503, pokud PostgreSQL, Blob nebo ClamAV nejsou dosažitelné, a bezpečný seznam názvů nezdravých komponent. Test ověří hranice alarmů: nejstarší úloha nad 600 sekund, nejméně 5 technických selhání za 15 minut, nedostupná závislost a každý AV nález. Samotné Azure alert rules zůstávají v etapě E, ale názvy metrik a prahy se tímto fixují.

- [ ] **Step 7: Spusťte celý ověřovací gate**

Run: `pnpm test`

Expected: všechny původní i nové Vitest testy PASS.

Run: `pnpm typecheck`

Expected: PASS bez TypeScript chyb.

Run: `docker build --target runner -t sokol-web:conversion .`

Expected: PASS a web image běží jako non-root.

Run: `docker build -f worker/Dockerfile -t sokol-worker:conversion worker`

Expected: PASS a worker test stage je zelený.

Run: `pnpm smoke:conversion`

Expected: všechny smoke assertions PASS, žádné browser/resource chyby a cleanup PASS.

Run: `git diff --check`

Expected: žádný výstup.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile infra/local/compose.yaml package.json scripts/smoke-conversion.mjs test/server/docx-ingestion-acceptance.test.ts server/modules/conversion/conversion-metrics.ts server/health-service.ts app/api/health/ready/route.ts test/server/conversion-observability.test.ts README.md SECURITY.md docs/operations/docx-conversion-runbook.md
git commit -m "test: complete DOCX conversion production gate"
```

---

## Závěrečná kontrola před předáním

- [ ] Porovnat každé akceptační kritérium ve specifikaci s jedním konkrétním automatickým testem.
- [ ] Ověřit čistý pracovní strom a vypsat SHA všech deseti implementačních commitů.
- [ ] Spustit `pnpm test`, `pnpm typecheck`, oba Docker buildy a `pnpm smoke:conversion` z čistého checkoutu.
- [ ] Provést `superpowers:requesting-code-review`; opravit všechny Critical a Important nálezy před tvrzením o dokončení.
- [ ] Použít `superpowers:verification-before-completion` a uvést čerstvé počty testů, buildů, smoke kontrol a stav cleanupu.
- [ ] Nenasazovat, nemergovat a neposílat na GitHub bez samostatného pokynu uživatele.

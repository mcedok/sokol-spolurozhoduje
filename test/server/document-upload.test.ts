import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../contracts";
import { createDocumentService } from "../../server/modules/documents/document-service";
import { createAzureBlobStorage } from "../../server/modules/files/azure-blob-storage";
import { fileConfig } from "../../server/modules/files/file-config";
import { createUploadService } from "../../server/modules/files/upload-service";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  testSql,
} from "./db-test-context";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const fixtureRoot = join(process.env.SOKOL_PROJECT_ROOT!, "test", "fixtures", "docx");
const config = fileConfig({ NODE_ENV: "test" });
const storage = createAzureBlobStorage(config);
const documents = createDocumentService({ sql: testSql });
const uploads = createUploadService({ sql: testSql, storage, config });

beforeAll(async () => {
  await migrateTestDatabase();
  await storage.ensureContainers();
});
beforeEach(resetTestDatabase);
afterEach(async () => {
  const files = await testSql<{ container: "quarantine"; object_key: string; etag: string | null }[]>`
    select container, object_key, etag from file_objects
  `;
  await Promise.all(files.map((file) => storage.delete(
    file.container,
    file.object_key,
    file.etag ?? undefined,
  ).catch(() => undefined)));
});

async function manager(role: "admin" | "superadmin" = "admin") {
  const user = await seedActiveAdmin({ role });
  return {
    user,
    actor: { userId: user.id, role, sessionId: crypto.randomUUID() } satisfies Actor,
  };
}

function input(name: string, rowVersion: number, idempotencyKey = crypto.randomUUID()) {
  const path = join(fixtureRoot, name);
  return {
    fileName: name,
    contentType: DOCX_MIME,
    contentLength: statSync(path).size,
    body: createReadStream(path),
    rowVersion,
    idempotencyKey,
  };
}

describe("document upload", () => {
  it("accepts one valid DOCX and queues one conversion job", async () => {
    const owner = await manager();
    const document = await documents.createDocument(owner.actor, {
      title: "Upload norma",
      explanatoryReport: "Důvod",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      idempotencyKey: crypto.randomUUID(),
    });

    const accepted = await uploads.accept(
      owner.actor,
      document.id,
      input("valid-minimal.docx", document.rowVersion),
    );

    expect(accepted).toMatchObject({ status: "file_check" });
    expect(accepted.versionId[14]).toBe("7");
    expect(await testSql`select id from conversion_jobs where id = ${accepted.jobId}`).toHaveLength(1);
    expect(await testSql`
      select id from outbox_events
      where aggregate_id = ${accepted.versionId} and event_type = 'document.conversion_queued'
    `).toHaveLength(1);
  });

  it("replays the same upload key without duplicating the version or outbox event", async () => {
    const owner = await manager();
    const document = await documents.createDocument(owner.actor, {
      title: "Idempotentní norma",
      explanatoryReport: "Důvod",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      idempotencyKey: crypto.randomUUID(),
    });
    const key = crypto.randomUUID();
    const first = await uploads.accept(
      owner.actor,
      document.id,
      input("valid-minimal.docx", document.rowVersion, key),
    );
    const replay = await uploads.accept(
      owner.actor,
      document.id,
      input("valid-minimal.docx", document.rowVersion, key),
    );
    expect(replay).toEqual(first);
    expect(await testSql`select id from document_versions where document_id = ${document.id}`)
      .toHaveLength(1);
    expect(await testSql`select id from outbox_events where idempotency_key = ${key}`)
      .toHaveLength(1);
  });

  it("rejects a foreign administrator before storing a file and audits the denial", async () => {
    const owner = await manager();
    const other = await manager();
    const document = await documents.createDocument(owner.actor, {
      title: "Cizí norma",
      explanatoryReport: "Důvod",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(uploads.accept(
      other.actor,
      document.id,
      input("valid-minimal.docx", document.rowVersion),
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await testSql`select id from file_objects where document_id = ${document.id}`)
      .toHaveLength(0);
    expect(await testSql`
      select id from audit_events
      where action = 'document.upload_denied' and target_id = ${document.id}
    `).toHaveLength(1);
  });

  it("rejects a fake DOCX before writing metadata", async () => {
    const owner = await manager();
    const document = await documents.createDocument(owner.actor, {
      title: "Neplatný soubor",
      explanatoryReport: "Důvod",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(uploads.accept(
      owner.actor,
      document.id,
      input("fake-extension.docx", document.rowVersion),
    )).rejects.toMatchObject({ code: "INVALID_DOCX" });
    expect(await testSql`select id from file_objects where document_id = ${document.id}`)
      .toHaveLength(0);
  });

  it("rejects a DOCX with the wrong declared MIME type", async () => {
    const owner = await manager();
    const document = await documents.createDocument(owner.actor, {
      title: "Špatný typ",
      explanatoryReport: "Důvod",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(uploads.accept(owner.actor, document.id, {
      ...input("valid-minimal.docx", document.rowVersion),
      contentType: "application/zip",
    })).rejects.toMatchObject({ code: "INVALID_DOCX" });
  });

  it("rejects an OOXML package without content types", async () => {
    const owner = await manager();
    const document = await documents.createDocument(owner.actor, {
      title: "Chybějící struktura",
      explanatoryReport: "Důvod",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(uploads.accept(
      owner.actor,
      document.id,
      input("missing-content-types.docx", document.rowVersion),
    )).rejects.toMatchObject({ code: "INVALID_DOCX" });
  });

  it("rejects a declared upload larger than 25 MiB before reading it", async () => {
    const owner = await manager();
    const document = await documents.createDocument(owner.actor, {
      title: "Příliš velký dokument",
      explanatoryReport: "Důvod",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(uploads.accept(owner.actor, document.id, {
      ...input("valid-minimal.docx", document.rowVersion),
      contentLength: config.maxUploadBytes + 1,
    })).rejects.toMatchObject({ code: "INVALID_DOCX" });
  });
});

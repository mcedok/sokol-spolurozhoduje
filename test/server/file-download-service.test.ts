import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileDownloadService } from "../../server/modules/files/file-download-service";
import type { ObjectStorage } from "../../server/modules/files/object-storage";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

function storageDouble(): ObjectStorage {
  return {
    ensureContainers: vi.fn(),
    putQuarantine: vi.fn(),
    open: vi.fn(),
    copyIfAbsent: vi.fn(),
    delete: vi.fn(),
    createReadUrl: vi.fn().mockResolvedValue({
      url: "https://storage.example/original.docx?sig=secret",
      expiresAt: "2026-08-18T12:05:00.000Z",
    }),
  } as unknown as ObjectStorage;
}

async function seedFile(objectStatus: "quarantined" | "archived") {
  const owner = await seedActiveAdmin();
  const documentId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  await testSql`
    insert into documents(id,number,title,owner_admin_id,status)
    values (${documentId},${`SOKOL-2099-${Math.floor(Math.random() * 900000 + 100000)}`},
      'Stažení originálu',${owner.id},'conversion_review')
  `;
  await testSql`
    insert into file_objects(
      id,document_id,data_owner_user_id,purpose,container,object_key,original_name,
      declared_mime,detected_mime,size_bytes,sha256,av_status,object_status
    ) values (
      ${fileId},${documentId},${owner.id},'original_docx',
      ${objectStatus === "archived" ? "originals" : "quarantine"},
      ${`${documentId}/${fileId}.docx`},'source.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      42,${"a".repeat(64)},'clean',${objectStatus}
    )
  `;
  return { owner, fileId };
}

describe("file download service", () => {
  it("creates a five-minute link for the owner without auditing the URL or object key", async () => {
    const { owner, fileId } = await seedFile("archived");
    const storage = storageDouble();
    const service = createFileDownloadService({ sql: testSql, storage, ttlSeconds: 300 });

    await expect(service.createReadLink({
      userId: owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    }, fileId)).resolves.toEqual({
      url: "https://storage.example/original.docx?sig=secret",
      expiresAt: "2026-08-18T12:05:00.000Z",
    });
    expect(storage.createReadUrl).toHaveBeenCalledWith("originals", expect.any(String), 300);
    const [audit] = await testSql<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events where action='file.download_link_created'
    `;
    expect(JSON.stringify(audit.metadata)).not.toMatch(/sig=|objectKey|\.docx/i);
  });

  it("never signs a clean object that is still quarantined", async () => {
    const { owner, fileId } = await seedFile("quarantined");
    const storage = storageDouble();
    const service = createFileDownloadService({ sql: testSql, storage, ttlSeconds: 300 });

    await expect(service.createReadLink({
      userId: owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    }, fileId)).rejects.toMatchObject({ code: "FILE_NOT_DOWNLOADABLE" });
    expect(storage.createReadUrl).not.toHaveBeenCalled();
  });
});

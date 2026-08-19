import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../contracts";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase, 30_000);

describe("working XLSX export workflows", () => {
  it("creates a queued export for the document owner", async () => {
    const owner = await seedActiveAdmin();
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await testSql`
      insert into documents (id, number, title, owner_admin_id, status)
      values (${documentId}, 'SOKOL-2026-911', 'Pracovní export', ${owner.id}, 'ready')
    `;
    await testSql`
      insert into document_versions (id, document_id, version_number, status, created_by_user_id, review_completed_at)
      values (${versionId}, ${documentId}, 1, 'ready', ${owner.id}, now())
    `;
    const sessionId = crypto.randomUUID();
    await testSql`
      insert into sessions (id, user_id, token_hash, csrf_hash, expires_at, created_at)
      values (${sessionId}, ${owner.id}, ${"a".repeat(64)}, ${"b".repeat(64)}, now() + interval '1 day', now())
    `;
    const modulePath = "../../server/modules/xlsx/xlsx-export-service";
    const { createXlsxExportService } = await import(modulePath) as typeof import("../../server/modules/xlsx/xlsx-export-service");
    const actor: Actor = { userId: owner.id, role: "admin", sessionId };
    const service = createXlsxExportService({ sql: testSql });
    const job = await service.createExport(actor, documentId, {
      documentVersionId: versionId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(job).toMatchObject({ status: "queued", rowCount: 0 });
  });
});

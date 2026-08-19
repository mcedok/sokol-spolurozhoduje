import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase, 30_000);

describe("working XLSX import workflow", () => {
  it("rejects an import that does not belong to the selected document", async () => {
    const admin = await seedActiveAdmin();
    const documentA = crypto.randomUUID();
    const documentB = crypto.randomUUID();
    const versionA = crypto.randomUUID();
    const versionB = crypto.randomUUID();
    await testSql`
      insert into documents (id, number, title, owner_admin_id, status)
      values (${documentA}, 'SOKOL-2026-912', 'A', ${admin.id}, 'ready'),
             (${documentB}, 'SOKOL-2026-913', 'B', ${admin.id}, 'ready')
    `;
    await testSql`
      insert into document_versions (id, document_id, version_number, status, created_by_user_id, review_completed_at)
      values (${versionA}, ${documentA}, 1, 'ready', ${admin.id}, now()),
             (${versionB}, ${documentB}, 1, 'ready', ${admin.id}, now())
    `;
    const modulePath = "../../server/modules/xlsx/xlsx-import-service";
    const { createXlsxImportService } = await import(modulePath) as typeof import("../../server/modules/xlsx/xlsx-import-service");
    const service = createXlsxImportService({ sql: testSql });
    await expect(service.assertSourceDocument(documentA, versionB)).rejects.toMatchObject({ code: "IMPORT_SOURCE_MISMATCH" });
  });
});

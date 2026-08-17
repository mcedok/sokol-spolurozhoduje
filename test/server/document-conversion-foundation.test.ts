import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  documentBlockSchema,
  processingStatusSchema,
} from "../../contracts";
import {
  migrateTestDatabase,
  resetTestDatabase,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

describe("document conversion foundation", () => {
  it("accepts supported blocks and rejects unsafe links", () => {
    const block = documentBlockSchema.parse({
      blockUid: "018f6f9d-7e10-7000-8000-000000000001",
      blockRevisionId: "018f6f9d-7e10-7000-8000-000000000002",
      type: "paragraph",
      order: 0,
      commentable: true,
      text: "Bezpečný text",
      content: [{ type: "link", text: "Web", href: "https://sokol.eu" }],
    });
    expect(block.type).toBe("paragraph");

    expect(() => documentBlockSchema.parse({
      blockUid: "018f6f9d-7e10-7000-8000-000000000003",
      blockRevisionId: "018f6f9d-7e10-7000-8000-000000000004",
      type: "paragraph",
      order: 0,
      commentable: true,
      text: "Nebezpečný odkaz",
      content: [{ type: "link", text: "Odkaz", href: "javascript:alert(1)" }],
    })).toThrow();

    expect(processingStatusSchema.parse({
      versionId: "018f6f9d-7e10-7000-8000-000000000005",
      jobId: "018f6f9d-7e10-7000-8000-000000000006",
      jobStatus: "queued",
      versionStatus: "file_check",
      step: "file_check",
      attemptCount: 0,
      errorCode: null,
      startedAt: null,
      completedAt: null,
    })).toMatchObject({ jobStatus: "queued", versionStatus: "file_check" });
  });

  it("creates all conversion tables", async () => {
    const expected = [
      "block_assets",
      "block_edit_revisions",
      "block_revisions",
      "conversion_findings",
      "conversion_jobs",
      "document_blocks",
      "document_versions",
      "file_objects",
      "security_events",
    ];
    const rows = await testSql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = any(${expected})
      order by table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual(expected);
  });

  it("enforces unique block order and block identity within a version", async () => {
    const constraints = await testSql<{ constraint_name: string }[]>`
      select constraint_name
      from information_schema.table_constraints
      where table_schema = 'public'
        and table_name = 'block_revisions'
        and constraint_type = 'UNIQUE'
      order by constraint_name
    `;
    expect(constraints.map((row) => row.constraint_name)).toEqual(
      expect.arrayContaining([
        "block_revisions_version_block_key",
        "block_revisions_version_order_key",
      ]),
    );
  });
});

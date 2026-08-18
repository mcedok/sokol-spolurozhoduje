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

  it("enforces unique current block order and identity while retaining history", async () => {
    const indexes = await testSql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public' and tablename = 'block_revisions'
        and indexname in ('block_revisions_current_block_key', 'block_revisions_current_order_key')
      order by indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "block_revisions_current_block_key",
      "block_revisions_current_order_key",
    ]);
    expect(indexes.every((row) => row.indexdef.includes("WHERE (superseded_at IS NULL)"))).toBe(true);
  });
});

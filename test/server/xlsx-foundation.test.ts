import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as contracts from "../../contracts";
import {
  migrateTestDatabase,
  resetTestDatabase,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

describe("working XLSX foundation", () => {
  it("exports strict row classifications and decisions", () => {
    expect(contracts.xlsxRowClassificationSchema.parse("safe_change")).toBe("safe_change");
    expect(contracts.xlsxConflictDecisionSchema.parse("keep_system")).toBe("keep_system");
    expect(() => contracts.xlsxRowClassificationSchema.parse("delete_everything")).toThrow();
    expect(() => contracts.xlsxConflictDecisionSchema.parse("merge_cells")).toThrow();
  });

  it("creates staging tables and xlsx file purposes", async () => {
    const expected = [
      "xlsx_apply_runs",
      "xlsx_export_jobs",
      "xlsx_import_batches",
      "xlsx_import_decisions",
      "xlsx_import_rows",
      "xlsx_import_stage_events",
      "xlsx_row_applications",
    ];
    const rows = await testSql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = any(${expected})
      order by table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual(expected);

    const purposeConstraint = await testSql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'file_objects'::regclass and conname = 'file_objects_purpose_check'
    `;
    expect(purposeConstraint[0].definition).toContain("xlsx_export");
    expect(purposeConstraint[0].definition).toContain("xlsx_import");
  });

  it("separates declared settlement date from actual apply time and supports one active settlement", async () => {
    const columns = await testSql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'settlements'
        and column_name = any(${["declared_settlement_date", "voided_at", "voided_by_user_id", "void_reason"]})
      order by column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      "declared_settlement_date",
      "void_reason",
      "voided_at",
      "voided_by_user_id",
    ]);

    const indexes = await testSql<{ indexdef: string }[]>`
      select indexdef
      from pg_indexes
      where schemaname = 'public' and tablename = 'settlements'
        and indexdef ilike '%comment_id%'
    `;
    expect(indexes.some((row) => row.indexdef.includes("WHERE (voided_at IS NULL)"))).toBe(true);
  });
});

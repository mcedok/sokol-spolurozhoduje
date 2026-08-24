import { describe, expect, it } from "vitest";
import { classifyXlsxRow, type XlsxMergeRow } from "../../server/modules/xlsx/xlsx-three-way-merge";

const base: XlsxMergeRow = {
  type: "proposal", priority: "normal", status: "open", outcome: null,
  statement: null, targetVersionNumber: null, responsibleUserId: null, declaredSettlementDate: null,
};

describe("XLSX three-way merge", () => {
  it("classifies unchanged, safe, already-current and conflict rows", () => {
    expect(classifyXlsxRow(base, base, base)).toBe("unchanged");
    expect(classifyXlsxRow(base, base, { ...base, priority: "high" })).toBe("safe_change");
    expect(classifyXlsxRow(base, { ...base, priority: "high" }, { ...base, priority: "high" })).toBe("already_current");
    expect(classifyXlsxRow(base, { ...base, priority: "high" }, { ...base, statement: "Vysvětlit" })).toBe("conflict");
  });

  it("classifies validation errors before comparing values", () => {
    expect(classifyXlsxRow(base, base, base, ["STATEMENT_REQUIRED"])).toBe("invalid");
  });
});

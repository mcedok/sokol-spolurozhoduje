import { describe, expect, it } from "vitest";
import { xlsxExportSnapshotSchema } from "../../contracts";
import type { XlsxExportSource } from "../../server/modules/xlsx/xlsx-export-snapshot";
import {
  buildXlsxExportSnapshot,
  xlsxSnapshotChecksum,
} from "../../server/modules/xlsx/xlsx-export-snapshot";

const generatedAt = "2026-08-19T12:00:00.000Z";
const source: XlsxExportSource = {
  document: {
    id: "018f6f9d-7e10-7000-8000-000000000010",
    versionId: "018f6f9d-7e10-7000-8000-000000000011",
    number: "SOKOL-2026-110",
    title: "Jednací řád",
    versionNumber: 2,
  },
  comments: [{
    id: "018f6f9d-7e10-7000-8000-000000000012",
    publicId: "PRIP-2026-000110",
    blockOrder: 2,
    blockUid: "018f6f9d-7e10-7000-8000-000000000013",
    blockText: "Článek 2",
    authorName: "Jan Člen",
    organizationName: "TJ Sokol Test",
    createdAt: "2026-08-18T10:00:00.000Z",
    body: "Navrhuji změnu.",
    type: "proposal",
    priority: "high",
    status: "settled",
    commentRowVersion: 4,
    settlement: {
      id: "018f6f9d-7e10-7000-8000-000000000014",
      rowVersion: 2,
      outcome: "accepted",
      statement: "Zapracováno.",
      responsibleUserId: "018f6f9d-7e10-7000-8000-000000000015",
      responsibleAdminName: "Anna Správce",
      declaredSettlementDate: "2026-08-19",
      targetVersionNumber: 2,
    },
  }],
};

describe("working XLSX export snapshot", () => {
  it("builds a deterministic allowlist without private member data", () => {
    const first = buildXlsxExportSnapshot(source, generatedAt);
    const second = buildXlsxExportSnapshot({ ...source, comments: [...source.comments].reverse() }, generatedAt);
    expect(xlsxExportSnapshotSchema.parse(first)).toEqual(first);
    expect(xlsxSnapshotChecksum(first)).toBe(xlsxSnapshotChecksum(second));
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("membership");
    expect(first.schemaVersion).toBe("xlsx-working-v1");
    expect(first.rowCount).toBe(1);
  });

  it("exposes only editable fields and immutable base values", () => {
    const snapshot = buildXlsxExportSnapshot(source, generatedAt);
    expect(snapshot.comments[0]).toMatchObject({
      publicId: "PRIP-2026-000110",
      base: {
        type: "proposal",
        priority: "high",
        status: "settled",
        settlement: {
          outcome: "accepted",
          declaredSettlementDate: "2026-08-19",
        },
      },
    });
    expect(snapshot.comments[0]).not.toHaveProperty("authorEmail");
    expect(snapshot.comments[0]).not.toHaveProperty("membershipId");
  });
});

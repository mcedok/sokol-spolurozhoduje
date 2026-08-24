import { describe, expect, it } from "vitest";
import { pdfExportSnapshotSchema } from "../../contracts";
import type { PdfExportSource } from "../../server/modules/exports/export-snapshot";
import {
  buildPdfExportSnapshot,
  snapshotChecksum,
} from "../../server/modules/exports/export-snapshot";

const generatedAt = "2026-08-18T12:00:00.000Z";
const source: PdfExportSource = {
  document: {
    number: "SOKOL-2026-100",
    title: "Jednací řád",
    explanatoryReport: "Důvodová zpráva",
    versionNumber: 2,
  },
  comments: [{
    publicId: "PRIP-2026-000100",
    blockOrder: 3,
    blockText: "Článek 3",
    authorName: "Jan Člen",
    organizationName: "TJ Sokol Test",
    authorEmail: "CANARY-email@example.cz",
    membershipId: "CANARY-MEMBER-ID",
    createdAt: "2026-08-17T10:00:00.000Z",
    body: "Navrhuji doplnit lhůtu.",
    type: "proposal",
    priority: "high",
    status: "settled",
    settlement: {
      outcome: "accepted",
      statement: "Zapracováno do druhé verze.",
      settledAt: "2026-08-18T09:00:00.000Z",
      targetVersionNumber: 2,
      internalNote: "CANARY-INTERNAL-NOTE",
    },
  }],
};

describe("PDF export snapshot", () => {
  it("builds a deterministic public allowlist without internal canaries", () => {
    const first = buildPdfExportSnapshot({
      visibility: "public",
      generatedAt,
      filters: {},
      options: {},
      source,
    });
    const second = buildPdfExportSnapshot({
      visibility: "public",
      generatedAt,
      filters: {},
      options: {},
      source: { ...source, comments: [...source.comments].reverse() },
    });

    expect(pdfExportSnapshotSchema.parse(first)).toEqual(first);
    expect(snapshotChecksum(first)).toBe(snapshotChecksum(second));
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("CANARY-email");
    expect(serialized).not.toContain("CANARY-MEMBER-ID");
    expect(serialized).not.toContain("CANARY-INTERNAL-NOTE");
    expect(first.statistics).toEqual({ total: 1, settled: 1, open: 0 });
  });

  it("keeps internal fields opt-in and applies filters before statistics", () => {
    const snapshot = buildPdfExportSnapshot({
      visibility: "internal",
      generatedAt,
      filters: { priorities: ["high"], statuses: ["settled"] },
      options: {
        includeAuthorEmail: true,
        includeMembershipId: false,
        includeInternalNote: true,
      },
      source,
    });

    expect(pdfExportSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.comments[0]).toMatchObject({
      authorEmail: "CANARY-email@example.cz",
      internalNote: "CANARY-INTERNAL-NOTE",
    });
    expect(snapshot.comments[0]).not.toHaveProperty("membershipId");
    expect(snapshot.statistics.total).toBe(1);
  });
});

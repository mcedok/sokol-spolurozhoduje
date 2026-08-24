import { createHash } from "node:crypto";
import type { XlsxExportSnapshot } from "../../../contracts";

export interface XlsxExportSourceComment {
  id: string;
  publicId: string;
  blockOrder: number;
  blockUid: string;
  blockText: string;
  authorName: string;
  organizationName: string;
  createdAt: string;
  body: string;
  type: "comment" | "proposal" | "question";
  priority: "low" | "normal" | "high" | "critical";
  status: "open" | "under_review" | "settled" | "withdrawn" | "hidden";
  commentRowVersion: number;
  settlement: null | {
    id: string;
    rowVersion: number;
    outcome: "accepted" | "partially_accepted" | "rejected" | "explained_no_change" | "duplicate" | "out_of_scope" | "withdrawn";
    statement: string;
    responsibleUserId: string;
    responsibleAdminName: string;
    declaredSettlementDate: string | null;
    targetVersionNumber: number | null;
  };
}

export interface XlsxExportSource {
  document: {
    id: string;
    versionId: string;
    number: string;
    title: string;
    versionNumber: number;
  };
  comments: XlsxExportSourceComment[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function xlsxSnapshotChecksum(snapshot: XlsxExportSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

export function buildXlsxExportSnapshot(
  source: XlsxExportSource,
  generatedAt: string,
): XlsxExportSnapshot {
  const comments = [...source.comments]
    .filter((comment) => comment.status !== "hidden")
    .sort((left, right) => left.blockOrder - right.blockOrder || left.publicId.localeCompare(right.publicId))
    .map((comment) => ({
      id: comment.id,
      publicId: comment.publicId,
      blockOrder: comment.blockOrder,
      blockUid: comment.blockUid,
      blockText: comment.blockText,
      authorName: comment.authorName,
      organizationName: comment.organizationName,
      createdAt: comment.createdAt,
      body: comment.body,
      base: {
        type: comment.type,
        priority: comment.priority,
        status: comment.status,
        settlement: comment.settlement,
      },
      commentRowVersion: comment.commentRowVersion,
    }));

  return {
    schemaVersion: "xlsx-working-v1",
    generatedAt,
    document: source.document,
    rowCount: comments.length,
    comments,
  };
}

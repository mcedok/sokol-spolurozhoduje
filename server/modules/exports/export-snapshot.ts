import { createHash } from "node:crypto";
import type {
  CommentPriority,
  CommentStatus,
  CommentType,
  PdfExportFilters,
  PdfExportInternalOptions,
  PdfExportSnapshot,
  SettlementOutcome,
} from "../../../contracts";

export interface PdfExportSourceComment {
  publicId: string;
  blockOrder: number;
  blockText: string;
  authorName: string;
  organizationName: string;
  authorEmail: string;
  membershipId: string | null;
  createdAt: string;
  body: string;
  type: CommentType;
  priority: CommentPriority;
  status: CommentStatus;
  settlement: null | {
    outcome: SettlementOutcome;
    statement: string;
    settledAt: string;
    targetVersionNumber: number | null;
    internalNote: string | null;
  };
}

export interface PdfExportSource {
  document: {
    number: string;
    title: string;
    explanatoryReport: string;
    versionNumber: number;
  };
  comments: PdfExportSourceComment[];
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

export function snapshotChecksum(snapshot: PdfExportSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

export function buildPdfExportSnapshot(input: {
  visibility: "public" | "internal";
  generatedAt: string;
  filters?: Partial<PdfExportFilters>;
  options?: Partial<PdfExportInternalOptions>;
  source: PdfExportSource;
}): PdfExportSnapshot {
  const filters: PdfExportFilters = {
    statuses: input.filters?.statuses ?? [],
    priorities: input.filters?.priorities ?? [],
    types: input.filters?.types ?? [],
  };
  const options: PdfExportInternalOptions = input.visibility === "public"
    ? { includeAuthorEmail: false, includeMembershipId: false, includeInternalNote: false }
    : {
      includeAuthorEmail: input.options?.includeAuthorEmail ?? false,
      includeMembershipId: input.options?.includeMembershipId ?? false,
      includeInternalNote: input.options?.includeInternalNote ?? false,
    };
  const selected = input.source.comments
    .filter((comment) => comment.status !== "hidden")
    .filter((comment) => filters.statuses.length === 0 || filters.statuses.includes(comment.status))
    .filter((comment) => filters.priorities.length === 0 || filters.priorities.includes(comment.priority))
    .filter((comment) => filters.types.length === 0 || filters.types.includes(comment.type))
    .sort((left, right) => left.blockOrder - right.blockOrder
      || left.publicId.localeCompare(right.publicId));
  const comments = selected.map((comment) => {
    const common = {
      publicId: comment.publicId,
      blockOrder: comment.blockOrder,
      blockText: comment.blockText,
      authorName: comment.authorName,
      organizationName: comment.organizationName,
      createdAt: comment.createdAt,
      body: comment.body,
      type: comment.type,
      priority: comment.priority,
      status: comment.status,
      settlement: comment.settlement ? {
        outcome: comment.settlement.outcome,
        statement: comment.settlement.statement,
        settledAt: comment.settlement.settledAt,
        targetVersionNumber: comment.settlement.targetVersionNumber,
      } : null,
    };
    if (input.visibility === "public") return common;
    return {
      ...common,
      ...(options.includeAuthorEmail ? { authorEmail: comment.authorEmail } : {}),
      ...(options.includeMembershipId && comment.membershipId
        ? { membershipId: comment.membershipId }
        : {}),
      ...(options.includeInternalNote && comment.settlement?.internalNote
        ? { internalNote: comment.settlement.internalNote }
        : {}),
    };
  });
  const settled = selected.filter((comment) => comment.status === "settled").length;
  return {
    schemaVersion: "pdf-export-v1",
    visibility: input.visibility,
    generatedAt: input.generatedAt,
    document: input.source.document,
    filters,
    options,
    statistics: { total: selected.length, settled, open: selected.length - settled },
    comments,
  } as PdfExportSnapshot;
}

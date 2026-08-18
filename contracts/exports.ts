import { z } from "zod";
import {
  commentPrioritySchema,
  commentStatusSchema,
  commentTypeSchema,
  settlementOutcomeSchema,
} from "./comments";

export const pdfExportVisibilitySchema = z.enum(["public", "internal"]);

export const pdfExportFiltersSchema = z.object({
  statuses: z.array(commentStatusSchema).default([]),
  priorities: z.array(commentPrioritySchema).default([]),
  types: z.array(commentTypeSchema).default([]),
}).strict();

export const pdfExportInternalOptionsSchema = z.object({
  includeAuthorEmail: z.boolean().default(false),
  includeMembershipId: z.boolean().default(false),
  includeInternalNote: z.boolean().default(false),
}).strict();

const exportDocumentSchema = z.object({
  number: z.string().min(1),
  title: z.string().min(1),
  explanatoryReport: z.string(),
  versionNumber: z.number().int().positive(),
}).strict();

const exportSettlementSchema = z.object({
  outcome: settlementOutcomeSchema,
  statement: z.string().min(1),
  settledAt: z.string().datetime(),
  targetVersionNumber: z.number().int().positive().nullable(),
}).strict();

const exportCommentBase = z.object({
  publicId: z.string().regex(/^PRIP-\d{4}-\d{6,}$/),
  blockOrder: z.number().int().nonnegative(),
  blockText: z.string(),
  authorName: z.string().min(1),
  organizationName: z.string().min(1),
  createdAt: z.string().datetime(),
  body: z.string().min(1),
  type: commentTypeSchema,
  priority: commentPrioritySchema,
  status: commentStatusSchema,
  settlement: exportSettlementSchema.nullable(),
});

const snapshotBase = z.object({
  schemaVersion: z.literal("pdf-export-v1"),
  generatedAt: z.string().datetime(),
  document: exportDocumentSchema,
  filters: pdfExportFiltersSchema,
  statistics: z.object({
    total: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  }).strict(),
});

const publicSnapshotSchema = snapshotBase.extend({
  visibility: z.literal("public"),
  options: z.object({
    includeAuthorEmail: z.literal(false),
    includeMembershipId: z.literal(false),
    includeInternalNote: z.literal(false),
  }).strict(),
  comments: z.array(exportCommentBase.strict()),
}).strict();

const internalSnapshotSchema = snapshotBase.extend({
  visibility: z.literal("internal"),
  options: pdfExportInternalOptionsSchema,
  comments: z.array(exportCommentBase.extend({
    authorEmail: z.string().email().optional(),
    membershipId: z.string().min(1).optional(),
    internalNote: z.string().min(1).optional(),
  }).strict()),
}).strict();

export const pdfExportSnapshotSchema = z.discriminatedUnion("visibility", [
  publicSnapshotSchema,
  internalSnapshotSchema,
]);

export const pdfExportJobSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  visibility: pdfExportVisibilitySchema,
  status: z.enum(["queued", "processing", "completed", "failed"]),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export type PdfExportFilters = z.infer<typeof pdfExportFiltersSchema>;
export type PdfExportInternalOptions = z.infer<typeof pdfExportInternalOptionsSchema>;
export type PdfExportSnapshot = z.infer<typeof pdfExportSnapshotSchema>;
export type PdfExportJob = z.infer<typeof pdfExportJobSchema>;

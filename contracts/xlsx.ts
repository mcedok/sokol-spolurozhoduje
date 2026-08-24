import { z } from "zod";
import {
  commentPrioritySchema,
  commentStatusSchema,
  commentTypeSchema,
  settlementOutcomeSchema,
} from "./comments";

export const xlsxRowClassificationSchema = z.enum([
  "unchanged",
  "safe_change",
  "already_current",
  "conflict",
  "invalid",
  "structural_error",
]);

export const xlsxConflictDecisionSchema = z.enum(["keep_system", "use_xlsx"]);

export const xlsxExportStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);
export const xlsxImportStatusSchema = z.enum([
  "uploaded",
  "scanning",
  "validating",
  "comparing",
  "applying_safe",
  "awaiting_resolution",
  "applying_conflicts",
  "completed",
  "failed",
  "cancelled",
]);

export const xlsxEditableRowSchema = z.object({
  type: commentTypeSchema,
  priority: commentPrioritySchema,
  status: commentStatusSchema,
  outcome: settlementOutcomeSchema.nullable(),
  statement: z.string().trim().min(1).nullable(),
  targetVersionNumber: z.number().int().positive().nullable(),
  responsibleUserId: z.string().uuid().nullable(),
  declaredSettlementDate: z.string().date().nullable(),
}).strict();

export const xlsxExportJobSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  status: xlsxExportStatusSchema,
  schemaVersion: z.string().min(1),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowCount: z.number().int().nonnegative().max(1000),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  outputFileId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
}).strict();

export const xlsxImportBatchSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  exportJobId: z.string().uuid(),
  status: xlsxImportStatusSchema,
  fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowCount: z.number().int().nonnegative().max(1000),
  counts: z.object({
    unchanged: z.number().int().nonnegative(),
    safeChange: z.number().int().nonnegative(),
    alreadyCurrent: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }).strict(),
  rowVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();

const xlsxSnapshotSettlementSchema = z.object({
  id: z.string().uuid(),
  rowVersion: z.number().int().positive(),
  outcome: settlementOutcomeSchema,
  statement: z.string().trim().min(1),
  responsibleUserId: z.string().uuid(),
  responsibleAdminName: z.string().trim().min(1),
  declaredSettlementDate: z.string().date().nullable(),
  targetVersionNumber: z.number().int().positive().nullable(),
}).strict();

const xlsxSnapshotCommentSchema = z.object({
  id: z.string().uuid(),
  publicId: z.string().regex(/^PRIP-\d{4}-\d{6,}$/),
  blockOrder: z.number().int().nonnegative(),
  blockUid: z.string().uuid(),
  blockText: z.string(),
  authorName: z.string().trim().min(1),
  organizationName: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  body: z.string().trim().min(1),
  base: z.object({
    type: commentTypeSchema,
    priority: commentPrioritySchema,
    status: commentStatusSchema,
    settlement: xlsxSnapshotSettlementSchema.nullable(),
  }).strict(),
  commentRowVersion: z.number().int().positive(),
}).strict();

export const xlsxExportSnapshotSchema = z.object({
  schemaVersion: z.literal("xlsx-working-v1"),
  generatedAt: z.string().datetime(),
  document: z.object({
    id: z.string().uuid(),
    versionId: z.string().uuid(),
    number: z.string().min(1),
    title: z.string().min(1),
    versionNumber: z.number().int().positive(),
  }).strict(),
  rowCount: z.number().int().nonnegative().max(1000),
  comments: z.array(xlsxSnapshotCommentSchema),
}).strict();

export type XlsxRowClassification = z.infer<typeof xlsxRowClassificationSchema>;
export type XlsxConflictDecision = z.infer<typeof xlsxConflictDecisionSchema>;
export type XlsxEditableRow = z.infer<typeof xlsxEditableRowSchema>;
export type XlsxExportJob = z.infer<typeof xlsxExportJobSchema>;
export type XlsxImportBatch = z.infer<typeof xlsxImportBatchSchema>;
export type XlsxExportSnapshot = z.infer<typeof xlsxExportSnapshotSchema>;

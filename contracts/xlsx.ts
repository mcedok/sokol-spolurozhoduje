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

export type XlsxRowClassification = z.infer<typeof xlsxRowClassificationSchema>;
export type XlsxConflictDecision = z.infer<typeof xlsxConflictDecisionSchema>;
export type XlsxEditableRow = z.infer<typeof xlsxEditableRowSchema>;
export type XlsxExportJob = z.infer<typeof xlsxExportJobSchema>;
export type XlsxImportBatch = z.infer<typeof xlsxImportBatchSchema>;

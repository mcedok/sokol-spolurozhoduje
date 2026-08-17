import { z } from "zod";

export const blockTypeSchema = z.enum([
  "heading",
  "paragraph",
  "list_item",
  "table",
  "table_image",
  "attachment_reference",
  "quote",
  "callout",
  "technical_separator",
]);

export const conversionJobStatusSchema = z.enum([
  "queued",
  "leased",
  "scanning",
  "archiving",
  "parsing",
  "rendering",
  "analyzing",
  "completed",
  "retry_wait",
  "failed",
  "rejected",
]);

export const conversionVersionStatusSchema = z.enum([
  "file_check",
  "conversion",
  "conversion_review",
  "ready",
]);

export const findingSeveritySchema = z.enum(["info", "warning", "blocking"]);
export const findingStatusSchema = z.enum(["open", "accepted", "resolved"]);
export const tableRepresentationSchema = z.enum([
  "html",
  "image_with_attachment",
  "attachment_only",
]);

export const safeHrefSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
}, "Odkaz používá nepovolený protokol.");

const inlineFormattingSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  highlight: z.string().min(1).optional(),
});

export const inlineContentSchema = z.discriminatedUnion("type", [
  inlineFormattingSchema.extend({
    type: z.literal("text"),
    text: z.string(),
  }),
  inlineFormattingSchema.extend({
    type: z.literal("link"),
    text: z.string(),
    href: safeHrefSchema,
  }),
]);

export const documentBlockSchema = z.object({
  blockUid: z.string().uuid(),
  blockRevisionId: z.string().uuid(),
  type: blockTypeSchema,
  order: z.number().int().nonnegative(),
  commentable: z.boolean(),
  text: z.string(),
  content: z.array(inlineContentSchema),
  headingLevel: z.number().int().min(1).max(9).optional(),
  list: z.object({
    listId: z.string().min(1),
    level: z.number().int().nonnegative(),
    marker: z.enum(["ordered", "bullet"]),
  }).optional(),
  table: z.object({
    rows: z.array(z.array(z.object({
      text: z.string(),
      rowSpan: z.number().int().positive().default(1),
      colSpan: z.number().int().positive().default(1),
      header: z.boolean().default(false),
    }))),
    recommendation: tableRepresentationSchema,
    confirmedRepresentation: tableRepresentationSchema.nullable(),
    complexityScore: z.number().int().nonnegative(),
    reasons: z.array(z.string()),
  }).optional(),
  assets: z.array(z.object({
    id: z.string().uuid(),
    purpose: z.enum(["table_image", "reference_page", "attachment"]),
    alternativeText: z.string().nullable(),
  })).default([]),
});

export const documentVersionSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  status: conversionVersionStatusSchema,
  originalFileId: z.string().uuid().nullable(),
  rowVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  reviewCompletedAt: z.string().datetime().nullable(),
});

export const processingStatusSchema = z.object({
  versionId: z.string().uuid(),
  jobId: z.string().uuid(),
  jobStatus: conversionJobStatusSchema,
  versionStatus: conversionVersionStatusSchema,
  step: z.string().min(1),
  attemptCount: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const conversionFindingSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  blockUid: z.string().uuid().nullable(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  severity: findingSeveritySchema,
  status: findingStatusSchema,
  message: z.string().min(1),
  decisionReason: z.string().nullable(),
});

export type BlockType = z.infer<typeof blockTypeSchema>;
export type ConversionJobStatus = z.infer<typeof conversionJobStatusSchema>;
export type ConversionVersionStatus = z.infer<typeof conversionVersionStatusSchema>;
export type TableRepresentation = z.infer<typeof tableRepresentationSchema>;
export type DocumentBlock = z.infer<typeof documentBlockSchema>;
export type DocumentVersion = z.infer<typeof documentVersionSchema>;
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;
export type ConversionFinding = z.infer<typeof conversionFindingSchema>;

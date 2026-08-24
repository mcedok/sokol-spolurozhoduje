import { z } from "zod";

export const documentStatusSchema = z.enum([
  "concept",
  "file_check",
  "conversion",
  "conversion_review",
  "ready",
  "published_open",
  "comments_closed",
  "settlement",
  "settled",
  "approved",
  "rejected",
  "archived",
]);

export const publicDocumentSummarySchema = z.object({
  publicId: z.string().regex(/^SOKOL-\d{4}-\d{3,}$/),
  title: z.string().min(1),
  explanatoryReport: z.string(),
  responsibleAdminName: z.string().min(1),
  status: documentStatusSchema,
  commentsOpen: z.boolean(),
  visibilityMode: z.enum(["public_detail", "login_required_detail"]),
  fourEyesRequired: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const documentAdminViewSchema = publicDocumentSummarySchema.extend({
  id: z.string().uuid(),
  ownerAdminId: z.string().uuid(),
  closureReason: z.string(),
  rowVersion: z.number().int().positive(),
  latestReadyVersionId: z.string().uuid().nullable(),
});

export type DocumentStatus = z.infer<typeof documentStatusSchema>;
export type PublicDocumentSummary = z.infer<typeof publicDocumentSummarySchema>;
export type DocumentAdminView = z.infer<typeof documentAdminViewSchema>;

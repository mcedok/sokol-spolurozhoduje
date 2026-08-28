import { z } from "zod";
import { publicCommentThreadSchema } from "./comments";

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

export const publicDocumentBlockSchema = z.object({
  blockUid: z.string().uuid(),
  blockRevisionId: z.string().uuid(),
  type: z.enum([
    "heading", "paragraph", "list_item", "table", "table_image",
    "attachment_reference", "quote", "callout", "technical_separator",
  ]),
  order: z.number().int().nonnegative(),
  commentable: z.boolean(),
  text: z.string(),
  structuredContent: z.record(z.string(), z.unknown()),
});

export const publicDocumentDetailSchema = publicDocumentSummarySchema.extend({
  documentRevision: z.number().int().positive(),
  participationVersion: z.number().int().positive(),
  version: z.object({
    versionNumber: z.number().int().positive(),
    publishedAt: z.string().datetime().nullable(),
    originalName: z.string().min(1).nullable(),
    blocks: z.array(publicDocumentBlockSchema),
  }).nullable(),
  threads: z.array(publicCommentThreadSchema),
  needVotes: z.object({
    yes: z.number().int().nonnegative(),
    no: z.number().int().nonnegative(),
    currentUserVote: z.enum(["yes", "no"]).nullable(),
  }),
});

export type DocumentStatus = z.infer<typeof documentStatusSchema>;
export type PublicDocumentSummary = z.infer<typeof publicDocumentSummarySchema>;
export type DocumentAdminView = z.infer<typeof documentAdminViewSchema>;
export type PublicDocumentBlock = z.infer<typeof publicDocumentBlockSchema>;
export type PublicDocumentDetail = z.infer<typeof publicDocumentDetailSchema>;

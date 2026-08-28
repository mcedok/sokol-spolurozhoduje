import { z } from "zod";

export const commentTypeSchema = z.enum([
  "comment",
  "proposal",
  "question",
]);

export const commentPrioritySchema = z.enum([
  "low",
  "normal",
  "high",
  "critical",
]);

export const commentStatusSchema = z.enum([
  "open",
  "under_review",
  "settled",
  "withdrawn",
  "hidden",
]);

export const settlementOutcomeSchema = z.enum([
  "accepted",
  "partially_accepted",
  "rejected",
  "explained_no_change",
  "duplicate",
  "out_of_scope",
  "withdrawn",
]);

export const publicSettlementSchema = z.object({
  outcome: settlementOutcomeSchema,
  statement: z.string().trim().min(1),
  responsibleAdminName: z.string().trim().min(1),
  settledAt: z.string().datetime(),
  targetVersionNumber: z.number().int().positive().nullable(),
}).strict();

export const publicCommentSchema = z.object({
  publicId: z.string().regex(/^PRIP-\d{4}-\d{6,}$/),
  threadPublicId: z.string().regex(/^VLAK-\d{4}-\d{6,}$/),
  blockUid: z.string().uuid(),
  blockRevisionId: z.string().uuid(),
  authorName: z.string().trim().min(1),
  organizationName: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  text: z.string().trim().min(1),
  type: commentTypeSchema,
  priority: commentPrioritySchema,
  status: commentStatusSchema,
  rowVersion: z.number().int().positive(),
  settlement: publicSettlementSchema.nullable(),
}).strict();

export const publicDiscussionCommentSchema = publicCommentSchema.extend({
  parentPublicId: z.string().regex(/^PRIP-\d{4}-\d{6,}$/).nullable(),
  score: z.number().int(),
  currentUserVote: z.union([z.literal(-1), z.literal(1)]).nullable(),
}).strict();

export const publicCommentThreadSchema = z.object({
  publicId: z.string().regex(/^VLAK-\d{4}-\d{6,}$/),
  blockUid: z.string().uuid(),
  blockRevisionId: z.string().uuid(),
  status: z.enum(["open", "locked", "hidden", "resolved"]),
  rowVersion: z.number().int().positive(),
  comments: z.array(publicDiscussionCommentSchema),
}).strict();

export type CommentType = z.infer<typeof commentTypeSchema>;
export type CommentPriority = z.infer<typeof commentPrioritySchema>;
export type CommentStatus = z.infer<typeof commentStatusSchema>;
export type SettlementOutcome = z.infer<typeof settlementOutcomeSchema>;
export type PublicComment = z.infer<typeof publicCommentSchema>;
export type PublicDiscussionComment = z.infer<typeof publicDiscussionCommentSchema>;
export type PublicCommentThread = z.infer<typeof publicCommentThreadSchema>;

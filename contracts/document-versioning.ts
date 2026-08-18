import { z } from "zod";

export const blockMappingRelationSchema = z.enum([
  "unchanged",
  "modified",
  "moved",
  "split",
  "merged",
  "removed",
  "added",
]);

export const blockMappingReviewStatusSchema = z.enum([
  "auto_confirmed",
  "needs_review",
  "confirmed",
  "rejected",
]);

export const blockMappingSchema = z.object({
  id: z.string().uuid(),
  sourceRevisionIds: z.array(z.string().uuid()).max(1),
  targetRevisionIds: z.array(z.string().uuid()).max(1),
  relation: blockMappingRelationSchema,
  confidence: z.number().min(0).max(1),
  method: z.enum([
    "stable_uid",
    "exact_hash",
    "source_identity",
    "text_similarity",
    "unmatched",
    "administrator",
  ]),
  reviewStatus: blockMappingReviewStatusSchema,
  rowVersion: z.number().int().positive(),
}).strict();

export const blockMappingRunSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  sourceVersionId: z.string().uuid(),
  targetVersionId: z.string().uuid(),
  algorithmVersion: z.string().min(1),
  status: z.enum(["review_required", "confirmed", "failed"]),
  rowVersion: z.number().int().positive(),
  mappings: z.array(blockMappingSchema),
}).strict();

export type BlockMapping = z.infer<typeof blockMappingSchema>;
export type BlockMappingRun = z.infer<typeof blockMappingRunSchema>;

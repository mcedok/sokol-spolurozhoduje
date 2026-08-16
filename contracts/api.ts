import { z } from "zod";
import { documentAdminViewSchema, publicDocumentSummarySchema } from "./documents";
import { viewerUserSchema } from "./users";

export const apiProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  code: z.string(),
  correlationId: z.string().uuid(),
});

export const versionedCommandSchema = z.object({
  rowVersion: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
});

export const appSnapshotSchema = z.object({
  viewer: viewerUserSchema.nullable(),
  documents: z.array(publicDocumentSummarySchema),
  managedDocuments: z.array(documentAdminViewSchema),
  organizations: z.array(z.object({ code: z.string().min(1), name: z.string() })),
  capabilities: z.object({
    manageUsers: z.boolean(),
    createDocument: z.boolean(),
  }),
});

export type ApiProblem = z.infer<typeof apiProblemSchema>;
export type VersionedCommand = z.infer<typeof versionedCommandSchema>;
export type AppSnapshot = z.infer<typeof appSnapshotSchema>;

import { z } from "zod";
import { roleSchema, userStatusSchema } from "./access";

export const publicUserSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  organizationName: z.string().min(1),
  role: roleSchema,
});

export const viewerUserSchema = publicUserSchema.extend({
  id: z.string().uuid(),
  emailVerifiedAt: z.string().datetime().nullable(),
});

export const adminUserViewSchema = publicUserSchema.extend({
  id: z.string().uuid(),
  email: z.string().email(),
  membershipId: z.string().nullable(),
  status: userStatusSchema,
  emailVerifiedAt: z.string().datetime().nullable(),
  lastLoginAt: z.string().datetime().nullable(),
  rowVersion: z.number().int().positive(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;
export type ViewerUser = z.infer<typeof viewerUserSchema>;
export type AdminUserView = z.infer<typeof adminUserViewSchema>;

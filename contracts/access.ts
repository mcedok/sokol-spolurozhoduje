import { z } from "zod";

export const roleSchema = z.enum(["member", "admin", "superadmin"]);
export const userStatusSchema = z.enum([
  "invited",
  "pending_verification",
  "active",
  "blocked",
]);

export type Role = z.infer<typeof roleSchema>;
export type UserStatus = z.infer<typeof userStatusSchema>;

export const actorSchema = z.object({
  userId: z.string().uuid(),
  role: roleSchema,
  sessionId: z.string().uuid(),
});

export type Actor = z.infer<typeof actorSchema>;

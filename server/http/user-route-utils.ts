import { z } from "zod";
import { assertCsrf } from "./csrf";
import { currentActor } from "./route-utils";
import { unauthenticated, AuthError } from "../modules/identity/auth-errors";
import { getIdentityRuntime } from "../runtime";

export async function actorForMutation(request: Request) {
  const actor = await currentActor();
  if (!actor) throw unauthenticated();
  const runtime = getIdentityRuntime();
  await assertCsrf(runtime.sql, runtime.secrets, actor.sessionId, request.headers.get("x-csrf-token"));
  return actor;
}

export function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!z.string().uuid().safeParse(key).success) {
    throw new AuthError("IDEMPOTENCY_KEY_REQUIRED", "Chybí platný Idempotency-Key.", 400);
  }
  return key!;
}

export function expectedRowVersion(request: Request): number {
  const raw = request.headers.get("if-match")?.replace(/^W\//, "").replaceAll('"', "");
  const parsed = z.coerce.number().int().positive().safeParse(raw);
  if (!parsed.success) {
    throw new AuthError("ROW_VERSION_REQUIRED", "Chybí platná verze záznamu v If-Match.", 400);
  }
  return parsed.data;
}

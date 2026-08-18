import { cookies } from "next/headers";
import { z } from "zod";
import { getIdentityRuntime } from "../runtime";
import { resolveActor } from "../modules/identity/session-repository";
import { sessionCookieOptions, setSessionCookie } from "./session-cookie";
import type { AuthSession } from "../modules/identity/auth-service";

export function requestCorrelationId(request: Request): string {
  const supplied = request.headers.get("x-correlation-id");
  return z.string().uuid().safeParse(supplied).success ? supplied! : crypto.randomUUID();
}

export async function currentActor() {
  const runtime = getIdentityRuntime();
  const store = await cookies();
  return resolveActor(runtime.sql, runtime.secrets, store.get(sessionCookieOptions.name)?.value);
}

export async function commitSession(session: AuthSession): Promise<Response> {
  setSessionCookie(await cookies(), session.token, session.expiresAt);
  return Response.json({ user: session.user, csrfToken: session.csrfToken });
}

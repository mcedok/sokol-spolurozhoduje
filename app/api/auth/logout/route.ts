import { cookies } from "next/headers";
import { assertCsrf } from "../../../../server/http/csrf";
import { problemResponse } from "../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../server/http/route-utils";
import { clearSessionCookie } from "../../../../server/http/session-cookie";
import { unauthenticated } from "../../../../server/modules/identity/auth-errors";
import { getIdentityRuntime } from "../../../../server/runtime";

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const runtime = getIdentityRuntime();
    const actor = await currentActor();
    if (!actor) throw unauthenticated();
    await assertCsrf(runtime.sql, runtime.secrets, actor.sessionId, request.headers.get("x-csrf-token"));
    await runtime.auth.logout(actor.sessionId, correlationId);
    clearSessionCookie(await cookies());
    return new Response(null, { status: 204 });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

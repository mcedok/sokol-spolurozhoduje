import { problemResponse } from "../../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../../server/http/route-utils";
import { unauthenticated } from "../../../../../server/modules/identity/auth-errors";
import { renewCsrfToken } from "../../../../../server/modules/identity/session-repository";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await currentActor();
    if (!actor) throw unauthenticated();
    const runtime = getIdentityRuntime();
    const csrfToken = await renewCsrfToken(runtime.sql, runtime.secrets, actor.sessionId);
    return Response.json({ csrfToken }, {
      headers: { "cache-control": "no-store", "x-correlation-id": correlationId },
    });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

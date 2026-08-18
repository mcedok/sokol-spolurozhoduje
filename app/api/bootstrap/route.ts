import { buildBootstrapSnapshot } from "../../../server/bootstrap-service";
import { problemResponse } from "../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../server/runtime";

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const snapshot = await buildBootstrapSnapshot(
      getIdentityRuntime().sql,
      await currentActor(),
    );
    return Response.json(snapshot, {
      headers: { "cache-control": "no-store", "x-correlation-id": correlationId },
    });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ versionId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { versionId } = await context.params;
    const version = await getIdentityRuntime().conversions.completeReview(actor, versionId, {
      rowVersion: expectedRowVersion(request),
      idempotencyKey: idempotencyKey(request),
    }, correlationId);
    return Response.json(version);
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

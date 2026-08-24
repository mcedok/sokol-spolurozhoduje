import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { jobId } = await context.params;
    const job = await getIdentityRuntime().conversions.retry(actor, jobId, {
      rowVersion: expectedRowVersion(request),
      idempotencyKey: idempotencyKey(request),
    }, correlationId);
    return Response.json(job);
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

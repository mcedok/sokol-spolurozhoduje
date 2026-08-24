import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const { batchId } = await context.params;
    const result = await getIdentityRuntime().xlsxImports.applySafeRows(
      await actorForMutation(request), batchId, {
        expectedBatchRowVersion: expectedRowVersion(request),
        idempotencyKey: idempotencyKey(request),
      }, correlationId,
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

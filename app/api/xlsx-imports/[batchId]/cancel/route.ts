import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const { batchId } = await context.params;
    await getIdentityRuntime().xlsxImports.cancel(await actorForMutation(request), batchId, correlationId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

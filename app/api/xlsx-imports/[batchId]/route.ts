import { problemResponse } from "../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../server/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const { batchId } = await context.params;
    const batch = await getIdentityRuntime().xlsxImports.getBatch(await currentActor(), batchId, correlationId);
    return Response.json(batch, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

import { problemResponse } from "../../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ versionId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await currentActor();
    const { versionId } = await context.params;
    const preview = await getIdentityRuntime().conversions.getPreview(actor, versionId, correlationId);
    return Response.json(preview, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

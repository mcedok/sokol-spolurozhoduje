import { problemResponse } from "../../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function GET(request: Request, context: { params: Promise<{ fileId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await currentActor();
    const { fileId } = await context.params;
    const link = await getIdentityRuntime().downloads.createReadLink(actor, fileId, correlationId);
    return Response.json(link, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

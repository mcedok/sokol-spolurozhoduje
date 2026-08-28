import { problemResponse } from "../../../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const { publicId } = await context.params;
    const link = await getIdentityRuntime().downloads.createPublicOriginalReadLink(
      await currentActor(),
      publicId,
      correlationId,
    );
    return Response.json(link, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

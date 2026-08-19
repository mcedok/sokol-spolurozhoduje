import { problemResponse } from "../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../server/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const { jobId } = await context.params;
    const { outputFileId, ...job } = await getIdentityRuntime().exports.getExport(
      await currentActor(), jobId, correlationId,
    );
    return Response.json({ ...job, downloadReady: Boolean(outputFileId) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

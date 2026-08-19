import { problemResponse } from "../../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await currentActor();
    const { jobId } = await context.params;
    const runtime = getIdentityRuntime();
    const fileId = await runtime.exports.getDownloadFileId(actor, jobId, correlationId);
    const link = await runtime.downloads.createReadLink(actor, fileId, correlationId);
    return Response.json(link, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

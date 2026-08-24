import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({
  documentVersionId: z.string().uuid(),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { documentId } = await context.params;
    const input = schema.parse(await request.json());
    const job = await getIdentityRuntime().xlsxExports.createExport(actor, documentId, {
      ...input,
      idempotencyKey: idempotencyKey(request),
    }, correlationId);
    const { outputFileId: _outputFileId, ...safeJob } = job;
    return Response.json({
      ...safeJob,
      downloadReady: job.status === "completed" && Boolean(job.outputFileId),
    }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

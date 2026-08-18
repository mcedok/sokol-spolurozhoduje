import { Readable } from "node:stream";
import { AuthError } from "../../../../../../server/modules/identity/auth-errors";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../../server/http/route-utils";
import {
  actorForMutation,
  expectedRowVersion,
  idempotencyKey,
} from "../../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { documentId } = await context.params;
    if (!request.body) {
      throw new AuthError("UPLOAD_BODY_REQUIRED", "Chybí obsah nahrávaného souboru.", 400);
    }
    const accepted = await getIdentityRuntime().uploads.accept(actor, documentId, {
      fileName: request.headers.get("x-file-name") ?? "",
      contentType: request.headers.get("content-type") ?? "",
      contentLength: Number(request.headers.get("content-length")),
      body: Readable.fromWeb(request.body as never),
      rowVersion: expectedRowVersion(request),
      idempotencyKey: idempotencyKey(request),
    }, correlationId);
    return Response.json({
      ...accepted,
      processingUrl: `/api/conversion-jobs/${accepted.jobId}`,
    }, { status: 202 });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

import { Readable } from "node:stream";
import { AuthError } from "../../../../../server/modules/identity/auth-errors";
import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { documentId } = await context.params;
    const form = await request.formData();
    const file = form.get("file");
    const exportJobId = form.get("exportJobId");
    if (!(file instanceof File) || typeof exportJobId !== "string" || !exportJobId) {
      throw new AuthError("UPLOAD_BODY_REQUIRED", "Chybí XLSX soubor nebo zdrojový export.", 400);
    }
    const runtime = getIdentityRuntime();
    const batch = await runtime.xlsxImports.accept(actor, documentId, {
      exportJobId,
      fileName: file.name,
      contentType: file.type,
      contentLength: file.size,
      body: Readable.fromWeb(file.stream() as never),
      idempotencyKey: idempotencyKey(request),
    }, runtime.files, runtime.fileConfig, correlationId);
    return Response.json(batch, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

import { AuthError } from "../../../../../server/modules/identity/auth-errors";
import { streamSingleXlsxPart } from "../../../../../server/http/xlsx-multipart";
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
    const runtime = getIdentityRuntime();
    const declaredBodyLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredBodyLength)
      && declaredBodyLength > runtime.fileConfig.maxUploadBytes + 64 * 1024) {
      throw new AuthError("UPLOAD_TOO_LARGE", "Požadavek překračuje povolenou velikost XLSX.", 413);
    }
    const exportJobId = new URL(request.url).searchParams.get("exportJobId");
    if (!exportJobId) {
      throw new AuthError("UPLOAD_BODY_REQUIRED", "Chybí XLSX soubor nebo zdrojový export.", 400);
    }
    const file = await streamSingleXlsxPart(request, runtime.fileConfig.maxUploadBytes);
    try {
      await file.finished;
      const batch = await runtime.xlsxImports.accept(actor, documentId, {
        exportJobId,
        fileName: file.fileName,
        contentType: file.contentType,
        body: file.body,
        idempotencyKey: idempotencyKey(request),
      }, runtime.files, runtime.fileConfig, correlationId);
      return Response.json(batch, { status: 202, headers: { "cache-control": "no-store" } });
    } finally {
      await file.cleanup();
    }
  } catch (error) {
    if (request.body && !request.bodyUsed) {
      await request.body.cancel().catch(() => undefined);
    }
    return problemResponse(error, correlationId);
  }
}

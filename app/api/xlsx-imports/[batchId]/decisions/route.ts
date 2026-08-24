import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";
import { xlsxConflictDecisionSchema } from "../../../../../contracts";

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const { batchId } = await context.params;
    const body = await request.json() as { rowId?: string; decision?: unknown; reason?: string };
    const parsed = xlsxConflictDecisionSchema.safeParse(body.decision);
    if (!body.rowId || !parsed.success) {
      return Response.json({ error: "INVALID_REQUEST", message: "Chybí řádek nebo rozhodnutí." }, { status: 400 });
    }
    const result = await getIdentityRuntime().xlsxImports.decideConflict(
      await actorForMutation(request), batchId, body.rowId, {
        decision: parsed.data,
        expectedRowVersion: expectedRowVersion(request),
        idempotencyKey: idempotencyKey(request),
        reason: body.reason,
      }, correlationId,
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

import { z } from "zod";
import { documentStatusSchema } from "../../../../../contracts";
import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({ status: documentStatusSchema, reason: z.string().default("") });

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { documentId } = await context.params;
    const input = schema.parse(await request.json());
    const document = await getIdentityRuntime().documents.changeDocumentStatus(
      actor, documentId, input.status, input.reason,
      { rowVersion: expectedRowVersion(request), idempotencyKey: idempotencyKey(request) },
      correlationId,
    );
    return Response.json({ document });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

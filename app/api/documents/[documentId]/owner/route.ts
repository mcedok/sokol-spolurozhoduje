import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({ ownerAdminId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { documentId } = await context.params;
    const { ownerAdminId } = schema.parse(await request.json());
    const document = await getIdentityRuntime().documents.transferOwnership(
      actor, documentId, ownerAdminId,
      { rowVersion: expectedRowVersion(request), idempotencyKey: idempotencyKey(request) },
      correlationId,
    );
    return Response.json({ document });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

import { z } from "zod";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../../server/http/route-utils";
import { actorForMutation, idempotencyKey } from "../../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

const schema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().default(""),
});

export async function POST(request: Request, context: { params: Promise<{ approvalId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    idempotencyKey(request);
    const { approvalId } = await context.params;
    const input = schema.parse(await request.json());
    const document = await getIdentityRuntime().documents.decideApproval(
      actor, approvalId, input.decision, input.reason, correlationId,
    );
    return Response.json({ document });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

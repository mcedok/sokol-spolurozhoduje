import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({
  status: z.enum(["accepted", "resolved"]),
  reason: z.string().trim().min(1),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ findingId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { findingId } = await context.params;
    const input = schema.parse(await request.json());
    const finding = await getIdentityRuntime().conversions.decideFinding(
      actor,
      findingId,
      input.status,
      input.reason,
      { rowVersion: expectedRowVersion(request), idempotencyKey: idempotencyKey(request) },
      correlationId,
    );
    return Response.json(finding);
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

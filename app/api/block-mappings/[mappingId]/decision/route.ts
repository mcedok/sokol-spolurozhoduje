import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import {
  actorForMutation,
  expectedRowVersion,
  idempotencyKey,
} from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({
  decision: z.enum(["confirm", "reject"]),
  reason: z.string().trim().min(1),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ mappingId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { mappingId } = await context.params;
    const input = schema.parse(await request.json());
    const result = await getIdentityRuntime().versioning.decideMapping(
      actor,
      mappingId,
      {
        ...input,
        rowVersion: expectedRowVersion(request),
        idempotencyKey: idempotencyKey(request),
      },
      correlationId,
    );
    return Response.json(result);
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

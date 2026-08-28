import { z } from "zod";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../../server/http/route-utils";
import {
  actorForMutation,
  expectedRowVersion,
  idempotencyKey,
} from "../../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

const schema = z.object({
  value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  commentRowVersion: z.number().int().positive(),
}).strict();

export async function PUT(
  request: Request,
  context: { params: Promise<{ commentPublicId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { commentPublicId } = await context.params;
    const result = await getIdentityRuntime().comments.voteComment(actor, commentPublicId, {
      ...schema.parse(await request.json()),
      participationVersion: expectedRowVersion(request),
      idempotencyKey: idempotencyKey(request),
    }, correlationId);
    return Response.json(result);
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

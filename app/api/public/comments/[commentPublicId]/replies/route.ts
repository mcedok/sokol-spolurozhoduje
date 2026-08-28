import { z } from "zod";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../../server/http/route-utils";
import {
  actorForMutation,
  expectedRowVersion,
  idempotencyKey,
} from "../../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

const schema = z.object({ text: z.string().trim().min(1).max(20_000) }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ commentPublicId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { commentPublicId } = await context.params;
    const result = await getIdentityRuntime().comments.reply(actor, commentPublicId, {
      ...schema.parse(await request.json()),
      participationVersion: expectedRowVersion(request),
      idempotencyKey: idempotencyKey(request),
    }, correlationId);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

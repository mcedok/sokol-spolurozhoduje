import { z } from "zod";
import { userStatusSchema } from "../../../../../contracts";
import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({ status: userStatusSchema });

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { userId } = await context.params;
    const { status } = schema.parse(await request.json());
    const user = await getIdentityRuntime().users.changeUserStatus(actor, userId, status, {
      rowVersion: expectedRowVersion(request), idempotencyKey: idempotencyKey(request),
    }, correlationId);
    return Response.json({ user });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

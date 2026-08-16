import { z } from "zod";
import { problemResponse } from "../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion } from "../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../server/runtime";

const schema = z.object({
  email: z.string().email(),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  organizationCode: z.string().trim().min(1),
  membershipId: z.string().trim().min(1).nullable(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { userId } = await context.params;
    const user = await getIdentityRuntime().users.updateUserProfile(actor, userId, {
      ...schema.parse(await request.json()),
      rowVersion: expectedRowVersion(request),
      idempotencyKey: correlationId,
    }, correlationId);
    return Response.json({ user });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

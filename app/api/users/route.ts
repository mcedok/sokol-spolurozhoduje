import { z } from "zod";
import { roleSchema, userStatusSchema } from "../../../contracts";
import { problemResponse } from "../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../server/http/route-utils";
import { actorForMutation, idempotencyKey } from "../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../server/runtime";

const createSchema = z.object({
  email: z.string().email(),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  organizationCode: z.string().trim().min(1),
  membershipId: z.string().trim().min(1).nullable(),
  role: z.enum(["admin", "superadmin"]),
});

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const url = new URL(request.url);
    const role = roleSchema.optional().parse(url.searchParams.get("role") ?? undefined);
    const status = userStatusSchema.optional().parse(url.searchParams.get("status") ?? undefined);
    const search = url.searchParams.get("search") ?? undefined;
    return Response.json(
      { users: await getIdentityRuntime().users.listUsers(await currentActor(), { role, status, search }, correlationId) },
    );
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const user = await getIdentityRuntime().users.createAdministrator(
      actor,
      createSchema.parse(await request.json()),
      idempotencyKey(request),
      correlationId,
    );
    return Response.json({ user }, { status: 201 });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

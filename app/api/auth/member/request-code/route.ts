import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({
  email: z.string().email(),
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  organizationCode: z.string().trim().min(1).optional(),
  membershipId: z.string().trim().min(1).nullable().optional(),
});

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const result = await getIdentityRuntime().auth.requestMemberCode(
      schema.parse(await request.json()),
      correlationId,
    );
    return Response.json(
      { ...result.publicResult, challengeId: result.challengeId },
      { status: 202, headers: { "x-correlation-id": correlationId } },
    );
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

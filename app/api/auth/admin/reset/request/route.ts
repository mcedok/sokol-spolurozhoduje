import { z } from "zod";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

const schema = z.object({ email: z.string().email() });

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const input = schema.parse(await request.json());
    const result = await getIdentityRuntime().auth.requestPasswordReset(
      input.email,
      correlationId,
    );
    return Response.json(result.publicResult, { status: 202 });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

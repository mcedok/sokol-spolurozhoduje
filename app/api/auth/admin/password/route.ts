import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { commitSession, requestCorrelationId } from "../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const input = schema.parse(await request.json());
    const result = await getIdentityRuntime().auth.verifyAdminPassword(
      input.email,
      input.password,
      correlationId,
    );
    if ("user" in result) return commitSession(result);
    return Response.json(result, { headers: { "x-correlation-id": correlationId } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

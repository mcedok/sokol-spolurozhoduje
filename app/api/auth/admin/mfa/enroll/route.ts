import { z } from "zod";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

const schema = z.object({ setupAttemptId: z.string().min(32) });

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const input = schema.parse(await request.json());
    return Response.json(
      await getIdentityRuntime().auth.beginMfaEnrollment(
        input.setupAttemptId,
        correlationId,
      ),
    );
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

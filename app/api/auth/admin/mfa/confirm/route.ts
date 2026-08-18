import { z } from "zod";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { commitSession, requestCorrelationId } from "../../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

const schema = z.object({ setupAttemptId: z.string().min(32), token: z.string().regex(/^\d{6}$/) });

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const input = schema.parse(await request.json());
    return commitSession(
      await getIdentityRuntime().auth.confirmMfaEnrollment(
        input.setupAttemptId,
        input.token,
        correlationId,
      ),
    );
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

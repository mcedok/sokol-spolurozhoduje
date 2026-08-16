import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { commitSession, currentActor, requestCorrelationId } from "../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const schema = z.object({ loginAttemptId: z.string().min(32), token: z.string().regex(/^\d{6}$/) });

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const input = schema.parse(await request.json());
    const session = await getIdentityRuntime().auth.verifyAdminMfa(
      input.loginAttemptId, input.token, (await currentActor())?.sessionId, correlationId,
    );
    return commitSession(session);
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

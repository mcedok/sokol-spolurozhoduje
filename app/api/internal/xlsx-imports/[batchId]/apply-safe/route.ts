import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { getIdentityRuntime } from "../../../../../../server/runtime";

const bodySchema = z.object({
  expectedBatchRowVersion: z.number().int().positive(),
  correlationId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
}).strict();

function authorized(request: Request): boolean {
  const expected = process.env.WORKER_CALLBACK_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  const fallbackCorrelationId = crypto.randomUUID();
  try {
    if (!authorized(request)) return new Response(null, { status: 401 });
    const input = bodySchema.parse(await request.json());
    const { batchId } = await context.params;
    const runtime = getIdentityRuntime();
    const [owner] = await runtime.sql<{
      uploaded_by_user_id: string; actor_session_id: string; role: "admin" | "superadmin";
    }[]>`
      select batch.uploaded_by_user_id, batch.actor_session_id, user_account.role::text role
      from xlsx_import_batches batch join users user_account on user_account.id=batch.uploaded_by_user_id
      where batch.id=${batchId}
    `;
    if (!owner) return new Response(null, { status: 404 });
    const result = await runtime.xlsxImports.applySafeRows({
      userId: owner.uploaded_by_user_id, sessionId: owner.actor_session_id, role: owner.role,
    }, batchId, {
      expectedBatchRowVersion: input.expectedBatchRowVersion,
      idempotencyKey: input.idempotencyKey,
    }, input.correlationId, { trustedWorkerCallback: true });
    return Response.json(result);
  } catch (error) {
    return problemResponse(error, fallbackCorrelationId);
  }
}

import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

const querySchema = z.object({
  classification: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
}).strict();

export async function GET(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const { batchId } = await context.params;
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const rows = await getIdentityRuntime().xlsxImports.listRows(
      await currentActor(), batchId, querySchema.parse(query), correlationId,
    );
    return Response.json({ rows }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

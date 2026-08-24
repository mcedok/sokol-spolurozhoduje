import { z } from "zod";
import { problemResponse } from "../../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../../server/http/route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";
import { xlsxRowClassificationSchema } from "../../../../../contracts";

const querySchema = z.object({
  classification: xlsxRowClassificationSchema.optional(),
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
    const result = await getIdentityRuntime().xlsxImports.listRows(
      await currentActor(), batchId, querySchema.parse(query), correlationId,
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

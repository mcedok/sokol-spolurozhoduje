import { z } from "zod";
import { blockTypeSchema, tableRepresentationSchema } from "../../../../../../contracts";
import { problemResponse } from "../../../../../../server/http/problem-details";
import { requestCorrelationId } from "../../../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion, idempotencyKey } from "../../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../../server/runtime";

const schema = z.object({
  reason: z.string().trim().min(1),
  type: blockTypeSchema,
  commentable: z.boolean(),
  text: z.string(),
  order: z.number().int().min(0).optional(),
  sourceRange: z.record(z.string(), z.unknown()).nullable().optional(),
  tableRepresentation: tableRepresentationSchema.optional(),
  alternativeText: z.string().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ versionId: string; blockUid: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { versionId, blockUid } = await context.params;
    const block = await getIdentityRuntime().conversions.editBlockStructure(
      actor,
      versionId,
      blockUid,
      {
        ...schema.parse(await request.json()),
        rowVersion: expectedRowVersion(request),
        idempotencyKey: idempotencyKey(request),
      },
      correlationId,
    );
    return Response.json(block);
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

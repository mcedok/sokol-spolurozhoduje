import { problemResponse } from "../../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../../server/http/route-utils";
import { actorForMutation, idempotencyKey } from "../../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../../server/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ versionId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await currentActor();
    const { versionId } = await context.params;
    const mappings = await getIdentityRuntime().versioning.getMappings(
      actor,
      versionId,
      correlationId,
    );
    return Response.json(mappings, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ versionId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { versionId } = await context.params;
    const mappings = await getIdentityRuntime().versioning.generateMappingsFromPreviousVersion(
      actor,
      versionId,
      idempotencyKey(request),
      correlationId,
    );
    return Response.json(mappings, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

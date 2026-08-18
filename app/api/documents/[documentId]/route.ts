import { z } from "zod";
import { AuthError } from "../../../../server/modules/identity/auth-errors";
import { problemResponse } from "../../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../../server/http/route-utils";
import { actorForMutation, expectedRowVersion } from "../../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../../server/runtime";

const schema = z.object({
  title: z.string().trim().min(1),
  explanatoryReport: z.string(),
  visibilityMode: z.enum(["public_detail", "login_required_detail"]),
  fourEyesRequired: z.boolean(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await currentActor();
    const { documentId } = await context.params;
    if (actor?.role === "admin" || actor?.role === "superadmin") {
      try {
        return Response.json({
          document: await getIdentityRuntime().documents.getManagedDocument(
            actor,
            documentId,
            correlationId,
          ),
        });
      } catch (error) {
        if (!(error instanceof AuthError) || error.code !== "FORBIDDEN") throw error;
      }
    }
    return Response.json({
      document: await getIdentityRuntime().documents.getVisibleDocument(actor, documentId),
    });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const { documentId } = await context.params;
    const document = await getIdentityRuntime().documents.updateDocument(actor, documentId, {
      ...schema.parse(await request.json()),
      rowVersion: expectedRowVersion(request),
      idempotencyKey: correlationId,
    }, correlationId);
    return Response.json({ document });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

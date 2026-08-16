import { z } from "zod";
import { problemResponse } from "../../../server/http/problem-details";
import { currentActor, requestCorrelationId } from "../../../server/http/route-utils";
import { actorForMutation, idempotencyKey } from "../../../server/http/user-route-utils";
import { getIdentityRuntime } from "../../../server/runtime";

const schema = z.object({
  title: z.string().trim().min(1),
  explanatoryReport: z.string(),
  visibilityMode: z.enum(["public_detail", "login_required_detail"]),
  fourEyesRequired: z.boolean(),
});

export async function GET() {
  try {
    return Response.json({
      documents: await getIdentityRuntime().documents.listVisibleDocuments(await currentActor()),
    });
  } catch (error) {
    return problemResponse(error, crypto.randomUUID());
  }
}

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  try {
    const actor = await actorForMutation(request);
    const document = await getIdentityRuntime().documents.createDocument(actor, {
      ...schema.parse(await request.json()),
      idempotencyKey: idempotencyKey(request),
    }, correlationId);
    return Response.json({ document }, { status: 201 });
  } catch (error) {
    return problemResponse(error, correlationId);
  }
}

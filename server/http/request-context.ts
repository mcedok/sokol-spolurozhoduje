import type { Sql } from "postgres";
import type { Actor } from "../../contracts";
import type { SecretService } from "../modules/identity/secret-service";
import { resolveActor } from "../modules/identity/session-repository";

export interface RequestContext {
  actor: Actor | null;
  correlationId: string;
}

export async function createRequestContext(
  sql: Sql,
  secrets: SecretService,
  rawCookieToken: string | null | undefined,
  correlationId = crypto.randomUUID(),
): Promise<RequestContext> {
  return {
    actor: await resolveActor(sql, secrets, rawCookieToken),
    correlationId,
  };
}

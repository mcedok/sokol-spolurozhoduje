import { timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";
import type { SecretService } from "../modules/identity/secret-service";
import { AuthError } from "../modules/identity/auth-errors";

function equalHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export async function assertCsrf(
  sql: Sql,
  secrets: SecretService,
  sessionId: string,
  rawToken: string | null | undefined,
): Promise<void> {
  if (!rawToken) throw new AuthError("CSRF_INVALID", "CSRF validation failed.", 403);
  const [session] = await sql<{ csrf_hash: string }[]>`
    select csrf_hash from sessions
    where id = ${sessionId}
      and revoked_at is null
      and expires_at > now()
    limit 1
  `;
  const suppliedHash = secrets.hashCsrfToken(rawToken);
  if (!session || !equalHash(suppliedHash, session.csrf_hash)) {
    throw new AuthError("CSRF_INVALID", "CSRF validation failed.", 403);
  }
}

import type { Sql } from "postgres";
import type { Actor, Role } from "../../../contracts";
import { withTransaction } from "../../db/client";
import type { SecretService } from "./secret-service";

export interface CreateSessionInput {
  userId: string;
  ttlMs: number;
  currentSessionId?: string;
}

export interface CreatedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(
  sql: Sql,
  secrets: SecretService,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("Session lifetime must be a positive integer");
  }

  const sessionId = crypto.randomUUID();
  const token = secrets.newSessionToken();
  const csrfToken = secrets.newCsrfToken();
  const expiresAt = new Date(Date.now() + input.ttlMs);

  await withTransaction(sql, async (tx) => {
    let rotatedFromId: string | null = null;
    if (input.currentSessionId) {
      const [current] = await tx<{ id: string }[]>`
        select id from sessions
        where id = ${input.currentSessionId}
          and user_id = ${input.userId}
          and revoked_at is null
        for update
      `;
      if (!current) throw new Error("Current session cannot be rotated");
      await tx`update sessions set revoked_at = now() where id = ${current.id}`;
      rotatedFromId = current.id;
    }

    await tx`
      insert into sessions (
        id, user_id, token_hash, csrf_hash, expires_at, rotated_from_id
      ) values (
        ${sessionId}, ${input.userId}, ${secrets.hashSessionToken(token)},
        ${secrets.hashCsrfToken(csrfToken)}, ${expiresAt}, ${rotatedFromId}
      )
    `;
    await tx`update users set last_login_at = now() where id = ${input.userId}`;
  });

  return { sessionId, token, csrfToken, expiresAt };
}

export async function resolveActor(
  sql: Sql,
  secrets: SecretService,
  rawCookieToken: string | null | undefined,
): Promise<Actor | null> {
  if (!rawCookieToken) return null;
  const [row] = await sql<{ session_id: string; user_id: string; role: Role }[]>`
    select sessions.id as session_id, users.id as user_id, users.role
    from sessions
    join users on users.id = sessions.user_id
    where sessions.token_hash = ${secrets.hashSessionToken(rawCookieToken)}
      and sessions.revoked_at is null
      and sessions.expires_at > now()
      and users.status = 'active'
    limit 1
  `;
  if (!row) return null;
  return { sessionId: row.session_id, userId: row.user_id, role: row.role };
}

export async function revokeSession(sql: Sql, sessionId: string): Promise<void> {
  await sql`
    update sessions set revoked_at = coalesce(revoked_at, now()) where id = ${sessionId}
  `;
}

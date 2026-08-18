import type { Sql } from "postgres";
import type { Role, UserStatus } from "../../../contracts";

export interface AuthUserRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  organization_name: string;
  role: Role;
  status: UserStatus;
  email_verified_at: Date | null;
  password_hash: string | null;
  totp_secret_ciphertext: Uint8Array | null;
  totp_enabled_at: Date | null;
}

export interface ChallengeRow {
  id: string;
  user_id: string | null;
  pending_email: string | null;
  kind: string;
  secret_hash: string;
  expires_at: Date;
  attempts: number;
  used_at: Date | null;
  locked_at: Date | null;
  revoked_at: Date | null;
}

const USER_COLUMNS = `
  users.id, users.email::text, users.first_name, users.last_name,
  coalesce(organizations.name, '') as organization_name,
  users.role, users.status, users.email_verified_at,
  admin_credentials.password_hash,
  admin_credentials.totp_secret_ciphertext,
  admin_credentials.totp_enabled_at
`;

export async function findAuthUserByEmail(
  sql: Sql,
  email: string,
): Promise<AuthUserRow | null> {
  const rows = await sql.unsafe<AuthUserRow[]>(`
    select ${USER_COLUMNS}
    from users
    left join organizations on organizations.id = users.organization_id
    left join admin_credentials on admin_credentials.user_id = users.id
    where users.email = $1
    limit 1
  `, [email]);
  return rows[0] ?? null;
}

export async function findAuthUserById(
  sql: Sql,
  userId: string,
): Promise<AuthUserRow | null> {
  const rows = await sql.unsafe<AuthUserRow[]>(`
    select ${USER_COLUMNS}
    from users
    left join organizations on organizations.id = users.organization_id
    left join admin_credentials on admin_credentials.user_id = users.id
    where users.id = $1
    limit 1
  `, [userId]);
  return rows[0] ?? null;
}

export async function findChallengeByIdForUpdate(
  tx: Sql,
  challengeId: string,
): Promise<ChallengeRow | null> {
  const rows = await tx<ChallengeRow[]>`
    select * from login_challenges where id = ${challengeId} for update
  `;
  return rows[0] ?? null;
}

export async function findChallengeByHashForUpdate(
  tx: Sql,
  kind: string,
  secretHash: string,
): Promise<ChallengeRow | null> {
  const rows = await tx<ChallengeRow[]>`
    select * from login_challenges
    where kind = ${kind} and secret_hash = ${secretHash}
    order by created_at desc
    limit 1
    for update
  `;
  return rows[0] ?? null;
}

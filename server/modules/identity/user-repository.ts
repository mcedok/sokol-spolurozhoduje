import type { Sql } from "postgres";
import type { AdminUserView, Role, UserStatus } from "../../../contracts";

interface AdminUserRow {
  id: string;
  email: string;
  membership_id: string | null;
  first_name: string;
  last_name: string;
  organization_name: string;
  role: Role;
  status: UserStatus;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  row_version: number;
}

export interface UserFilters {
  role?: Role;
  status?: UserStatus;
  search?: string;
}

function toView(row: AdminUserRow): AdminUserView {
  return {
    id: row.id,
    email: row.email,
    membershipId: row.membership_id,
    firstName: row.first_name,
    lastName: row.last_name,
    organizationName: row.organization_name,
    role: row.role,
    status: row.status,
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    rowVersion: row.row_version,
  };
}

export async function findAdminUserView(
  sql: Sql,
  userId: string,
): Promise<AdminUserView | null> {
  const [row] = await sql<AdminUserRow[]>`
    select users.id, users.email::text, users.membership_id,
      users.first_name, users.last_name, coalesce(organizations.name, '') as organization_name,
      users.role, users.status, users.email_verified_at, users.last_login_at, users.row_version
    from users
    left join organizations on organizations.id = users.organization_id
    where users.id = ${userId}
  `;
  return row ? toView(row) : null;
}

export async function listAdminUserViews(
  sql: Sql,
  filters: UserFilters,
): Promise<AdminUserView[]> {
  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;
  const rows = await sql<AdminUserRow[]>`
    select users.id, users.email::text, users.membership_id,
      users.first_name, users.last_name, coalesce(organizations.name, '') as organization_name,
      users.role, users.status, users.email_verified_at, users.last_login_at, users.row_version
    from users
    left join organizations on organizations.id = users.organization_id
    where (${filters.role ?? null}::user_role is null or users.role = ${filters.role ?? null})
      and (${filters.status ?? null}::user_status is null or users.status = ${filters.status ?? null})
      and (${search}::text is null or concat_ws(' ', users.first_name, users.last_name, users.email) ilike ${search})
    order by users.last_name, users.first_name, users.id
  `;
  return rows.map(toView);
}

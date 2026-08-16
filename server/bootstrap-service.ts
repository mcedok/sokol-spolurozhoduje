import type { Sql } from "postgres";
import type { Actor, AppSnapshot, ViewerUser } from "../contracts";
import {
  listManagedDocuments,
  listPublicDocuments,
} from "./modules/documents/document-repository";

export async function buildBootstrapSnapshot(
  sql: Sql,
  actor: Actor | null,
): Promise<AppSnapshot> {
  let viewer: ViewerUser | null = null;
  if (actor) {
    const [row] = await sql<{
      id: string;
      first_name: string;
      last_name: string;
      organization_name: string;
      role: Actor["role"];
      email_verified_at: Date | null;
    }[]>`
      select users.id, users.first_name, users.last_name,
        coalesce(organizations.name, '') as organization_name,
        users.role, users.email_verified_at
      from users
      left join organizations on organizations.id = users.organization_id
      where users.id = ${actor.userId} and users.status = 'active'
    `;
    if (row) {
      viewer = {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        organizationName: row.organization_name,
        role: row.role,
        emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
      };
    }
  }

  const documents = await listPublicDocuments(sql, Boolean(viewer));
  const managedDocuments =
    viewer && (viewer.role === "admin" || viewer.role === "superadmin")
      ? await listManagedDocuments(sql, { userId: viewer.id, role: viewer.role })
      : [];
  const organizations = await sql<{ code: string; name: string }[]>`
    select code, name from organizations where active = true order by name, code
  `;

  return {
    viewer,
    documents,
    managedDocuments,
    organizations,
    capabilities: {
      manageUsers: viewer?.role === "superadmin",
      createDocument: viewer?.role === "admin" || viewer?.role === "superadmin",
    },
  };
}

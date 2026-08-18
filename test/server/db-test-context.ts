import { createDatabase } from "../../server/db/client";
import { runMigrations } from "../../server/db/migrate";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test";

export const testSql = createDatabase(TEST_DATABASE_URL);

export async function resetPublicSchema(): Promise<void> {
  await testSql.unsafe("drop schema if exists public cascade; create schema public;");
}

export async function migrateTestDatabase(): Promise<void> {
  await runMigrations({ sql: testSql });
}

export async function resetTestDatabase(): Promise<void> {
  await testSql.unsafe(`
    truncate table
      settlement_block_links,
      settlement_revisions,
      settlements,
      comment_status_transitions,
      comment_revisions,
      comments,
      comment_threads,
      security_events,
      block_edit_revisions,
      block_assets,
      conversion_findings,
      block_revisions,
      document_blocks,
      conversion_jobs,
      document_versions,
      file_objects,
      document_approvals,
      document_sequences,
      outbox_events,
      audit_events,
      document_state_transitions,
      documents,
      sessions,
      login_challenges,
      admin_credentials,
      users,
      organizations
    restart identity cascade
  `);
}

export async function seedOrganization(
  input: { code?: string; name?: string } = {},
): Promise<{ id: string }> {
  const [organization] = await testSql<{ id: string }[]>`
    insert into organizations (code, name)
    values (${input.code ?? `ORG-${crypto.randomUUID()}`}, ${input.name ?? "Testovací jednota"})
    returning id
  `;
  return organization;
}

export async function seedActiveMember(
  input: { email?: string } = {},
): Promise<{ id: string; email: string }> {
  const organization = await seedOrganization();
  const email = input.email ?? `member-${crypto.randomUUID()}@example.cz`;
  const [member] = await testSql<{ id: string; email: string }[]>`
    insert into users (
      organization_id, first_name, last_name, email, role, status, email_verified_at
    ) values (
      ${organization.id}, 'Jan', 'Člen', ${email}, 'member', 'active', now()
    ) returning id, email::text
  `;
  return member;
}

export async function seedActiveAdmin(
  input: { email?: string; role?: "admin" | "superadmin" } = {},
): Promise<{ id: string; email: string }> {
  const organization = await seedOrganization();
  const email = input.email ?? `admin-${crypto.randomUUID()}@example.cz`;
  const role = input.role ?? "admin";
  const [admin] = await testSql<{ id: string; email: string }[]>`
    insert into users (
      organization_id, first_name, last_name, email, role, status, email_verified_at
    ) values (
      ${organization.id}, 'Anna', 'Správce', ${email}, ${role}, 'active', now()
    ) returning id, email::text
  `;
  return admin;
}

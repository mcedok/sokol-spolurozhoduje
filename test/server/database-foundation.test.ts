import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateTestDatabase, resetPublicSchema, testSql } from "./db-test-context";

beforeAll(async () => {
  await resetPublicSchema();
  await migrateTestDatabase();
}, 30_000);
afterAll(() => testSql.end());

describe("foundation migration", () => {
  it("creates the phase A tables and constraints", async () => {
    const rows = await testSql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;

    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "organizations",
        "users",
        "admin_credentials",
        "login_challenges",
        "sessions",
        "documents",
        "document_state_transitions",
        "audit_events",
        "outbox_events",
        "schema_migrations",
      ]),
    );
  });

  it("rejects a document owner who is not an active administrator", async () => {
    const [organization] = await testSql<{ id: string }[]>`
      insert into organizations (code, name)
      values ('TEST', 'Testovací jednota')
      returning id
    `;
    const [member] = await testSql<{ id: string }[]>`
      insert into users (organization_id, first_name, last_name, email, role, status)
      values (${organization.id}, 'Jan', 'Člen', 'member@example.cz', 'member', 'active')
      returning id
    `;

    await expect(
      testSql`
        insert into documents (number, title, owner_admin_id)
        values ('SOKOL-2026-001', 'Test', ${member.id})
      `,
    ).rejects.toThrow(/active administrator/);
  });
});

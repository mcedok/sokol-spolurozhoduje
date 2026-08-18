import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../contracts";
import { createSecretService } from "../../server/modules/identity/secret-service";
import { createSession } from "../../server/modules/identity/session-repository";
import { createUserService } from "../../server/modules/identity/user-service";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  seedActiveMember,
  seedOrganization,
  testSql,
} from "./db-test-context";

const secrets = createSecretService({
  sessionHmacKey: "s".repeat(32),
  otpHmacKey: "o".repeat(32),
  csrfHmacKey: "c".repeat(32),
});
const users = createUserService({ sql: testSql, secrets });

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

async function actorFor(role: "member" | "admin" | "superadmin"): Promise<Actor> {
  const user = role === "member" ? await seedActiveMember() : await seedActiveAdmin({ role });
  return { userId: user.id, role, sessionId: crypto.randomUUID() };
}

const validAdminInput = {
  email: "novy.admin@example.cz",
  firstName: "Nový",
  lastName: "Správce",
  organizationCode: "PRAHA-ADMIN",
  membershipId: null,
  role: "admin" as const,
};

describe("server-side user administration", () => {
  it.each([null, "member", "admin"] as const)(
    "denies user administration to %p",
    async (role) => {
      const actor = role ? await actorFor(role) : null;
      await expect(
        users.createAdministrator(actor, validAdminInput, crypto.randomUUID()),
      ).rejects.toMatchObject({ status: role ? 403 : 401 });
    },
  );

  it("allows superadmin to create an invited admin with no readable password", async () => {
    const actor = await actorFor("superadmin");
    await seedOrganization({ code: "PRAHA-ADMIN", name: "TJ Sokol Praha" });
    const idempotencyKey = crypto.randomUUID();
    const user = await users.createAdministrator(actor, validAdminInput, idempotencyKey);
    expect(user.status).toBe("invited");
    expect(JSON.stringify(user)).not.toMatch(/passwordHash|totpSecret/i);
    await expect(
      users.createAdministrator(actor, validAdminInput, idempotencyKey),
    ).resolves.toEqual(user);
  });

  it("rejects stale row_version and leaves the user unchanged", async () => {
    const actor = await actorFor("superadmin");
    const member = await seedActiveMember();
    await expect(
      users.changeUserStatus(actor, member.id, "blocked", {
        rowVersion: 999,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const [row] = await testSql<{ status: string; row_version: number }[]>`
      select status, row_version from users where id = ${member.id}
    `;
    expect(row).toEqual({ status: "active", row_version: 1 });
  });

  it("cannot block the last active superadmin", async () => {
    const actor = await actorFor("superadmin");
    await expect(
      users.changeUserStatus(actor, actor.userId, "blocked", {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "LAST_ACTIVE_SUPERADMIN" });
    expect((await testSql`select status from users where id = ${actor.userId}`)[0].status).toBe("active");
  });

  it("cannot demote the last active superadmin", async () => {
    const actor = await actorFor("superadmin");
    await expect(
      users.changeUserRole(actor, actor.userId, "admin", {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "LAST_ACTIVE_SUPERADMIN" });
  });

  it("blocking a user revokes sessions and challenges atomically", async () => {
    const actor = await actorFor("superadmin");
    const member = await seedActiveMember();
    const session = await createSession(testSql, secrets, { userId: member.id, ttlMs: 60_000 });
    await testSql`
      insert into login_challenges (user_id, kind, secret_hash, expires_at)
      values (${member.id}, 'member_code', 'hash', now() + interval '10 minutes')
    `;
    await users.changeUserStatus(actor, member.id, "blocked", {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    const [sessionRow] = await testSql<{ revoked_at: Date | null }[]>`
      select revoked_at from sessions where id = ${session.sessionId}
    `;
    const [challenge] = await testSql<{ revoked_at: Date | null }[]>`
      select revoked_at from login_challenges where user_id = ${member.id}
    `;
    expect(sessionRow.revoked_at).not.toBeNull();
    expect(challenge.revoked_at).not.toBeNull();
  });

  it("role reduction revokes privileged sessions", async () => {
    const actor = await actorFor("superadmin");
    const admin = await seedActiveAdmin();
    const session = await createSession(testSql, secrets, { userId: admin.id, ttlMs: 60_000 });
    await users.changeUserRole(actor, admin.id, "member", {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    const [row] = await testSql<{ revoked_at: Date | null }[]>`
      select revoked_at from sessions where id = ${session.sessionId}
    `;
    expect(row.revoked_at).not.toBeNull();
  });

  it("admin with owned documents requires transfer before demotion", async () => {
    const actor = await actorFor("superadmin");
    const admin = await seedActiveAdmin();
    await testSql`
      insert into documents (number, title, owner_admin_id)
      values ('SOKOL-2026-001', 'Norma', ${admin.id})
    `;
    await expect(
      users.changeUserRole(actor, admin.id, "member", {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_REQUIRED", ownedDocumentCount: 1 });
  });

  it("user mutation writes allowed or denied audit", async () => {
    const superadmin = await actorFor("superadmin");
    const member = await seedActiveMember();
    await users.changeUserStatus(superadmin, member.id, "blocked", {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    let events = await testSql<{ outcome: string }[]>`
      select outcome from audit_events where action = 'user.status_changed'
    `;
    expect(events).toEqual([{ outcome: "allowed" }]);

    await testSql`delete from audit_events`;
    const admin = await actorFor("admin");
    await expect(users.listUsers(admin, {})).rejects.toMatchObject({ status: 403 });
    events = await testSql<{ outcome: string }[]>`
      select outcome from audit_events where action = 'user.list_denied'
    `;
    expect(events).toEqual([{ outcome: "denied" }]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { createBrowserRepository } from "../app/data/browser-repository.js";
import { ROLE, USER_STATUS } from "../app/domain/constants.js";
import { createCryptoAdapter } from "../app/security/crypto-adapter.js";
import { createAuditService } from "../app/services/audit-service.js";
import { createAuthService } from "../app/services/auth-service.js";
import { createUserService } from "../app/services/user-service.js";
import { createFakeClock, createMemoryStorage } from "./fakes.js";

const MODEL_CREDENTIALS = {
  superadmin: { email: "superadmin@sokol.demo", password: "SuperSokol!2026" },
  admin: { email: "administrator@sokol.demo", password: "AdminSokol!2026" },
};

function memberProfile(overrides = {}) {
  return {
    firstName: "Jana",
    lastName: "Novakova",
    email: "jana.novakova@example.cz",
    sokolUnit: "TJ Sokol Brno I",
    membershipId: "MEMBER-BRNO-42",
    ...overrides,
  };
}

function privilegedProfile(overrides = {}) {
  return {
    firstName: "Alena",
    lastName: "Spravcova",
    email: "alena.spravcova@example.cz",
    sokolUnit: "COS",
    membershipId: "ADMIN-42",
    role: ROLE.ADMIN,
    ...overrides,
  };
}

async function createHarness() {
  const clock = createFakeClock();
  const repository = createBrowserRepository({ storage: createMemoryStorage() });
  const cryptoAdapter = createCryptoAdapter(globalThis.crypto);
  const audit = createAuditService(repository, clock.now);
  const auth = createAuthService({ repository, audit, cryptoAdapter, now: clock.now });
  const users = createUserService({ repository, auth, audit, now: clock.now });
  await auth.ensureDemoCredentials();
  const superadminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);
  const adminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);
  return { audit, auth, clock, repository, users, superadminSession, adminSession };
}

describe("user service", () => {
  let harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it("filters users case-insensitively across all profile fields and by exact role and status", async () => {
    const { repository, superadminSession, users } = harness;
    repository.update((state) => {
      state.users.push({
        id: "member-searchable",
        ...memberProfile(),
        role: ROLE.MEMBER,
        status: USER_STATUS.ACTIVE,
        emailVerifiedAt: "2026-08-03T10:00:00.000Z",
        passwordHash: "must-not-leak",
        passwordSalt: "must-not-leak",
      });
    });

    for (const query of ["JANA", "novaKOVA", "EXAMPLE.CZ", "brno i", "member-brno-42"]) {
      expect(users.listUsers(superadminSession.id, { query })).toEqual([
        expect.objectContaining({ id: "member-searchable" }),
      ]);
    }
    expect(
      users.listUsers(superadminSession.id, {
        role: ROLE.MEMBER,
        status: USER_STATUS.ACTIVE,
      }).map((user) => user.id),
    ).toEqual(["user-member-demo", "member-searchable"]);
    expect(JSON.stringify(users.getUser(superadminSession.id, "member-searchable"))).not.toContain(
      "must-not-leak",
    );
  });

  it("allows only an active superadministrator to create an invited fixed-role administrator", async () => {
    const { adminSession, repository, superadminSession, users } = harness;

    await expect(
      users.createPrivilegedUser(adminSession.id, privilegedProfile()),
    ).rejects.toMatchObject({ code: "manage_users" });
    await expect(
      users.createPrivilegedUser(
        superadminSession.id,
        privilegedProfile({ role: ROLE.MEMBER, email: "member-role@example.cz" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ROLE" });

    const delivery = await users.createPrivilegedUser(
      superadminSession.id,
      privilegedProfile({ email: "  ALENA.SPRAVCOVA@EXAMPLE.CZ  " }),
    );

    expect(delivery).toMatchObject({ kind: "set_password" });
    expect(repository.read().users.find((user) => user.id === delivery.userId)).toMatchObject({
      email: "alena.spravcova@example.cz",
      role: ROLE.ADMIN,
      status: USER_STATUS.INVITED,
    });
  });

  it("rolls back a newly created administrator when password setup delivery fails", async () => {
    const { audit, auth, clock, repository, superadminSession } = harness;
    const users = createUserService({
      repository,
      audit,
      now: clock.now,
      auth: {
        ...auth,
        async createPasswordSetup() {
          throw new Error("delivery unavailable");
        },
      },
    });
    const before = repository.read();

    await expect(
      users.createPrivilegedUser(
        superadminSession.id,
        privilegedProfile({ email: "rollback-create@example.cz" }),
      ),
    ).rejects.toThrow("delivery unavailable");

    const after = repository.read();
    expect(after.users).toEqual(before.users);
    expect(after.challenges).toEqual(before.challenges);
    expect(after.auditEvents).toEqual(before.auditEvents);
  });

  it("refuses to block or demote the last active superadministrator without changing state", async () => {
    const { repository, superadminSession, users } = harness;

    expect(() =>
      users.setUserStatus(superadminSession.id, superadminSession.userId, USER_STATUS.BLOCKED),
    ).toThrow(expect.objectContaining({ code: "LAST_ACTIVE_SUPERADMIN" }));
    await expect(
      users.changeUserRole(superadminSession.id, superadminSession.userId, ROLE.ADMIN),
    ).rejects.toMatchObject({ code: "LAST_ACTIVE_SUPERADMIN" });

    expect(repository.read().users.find((user) => user.id === superadminSession.userId)).toMatchObject({
      role: ROLE.SUPERADMIN,
      status: USER_STATUS.ACTIVE,
    });
    expect(() => harness.auth.getSession(superadminSession.id)).not.toThrow();
  });

  it("blocks an account and immediately revokes both its sessions and open challenges", async () => {
    const { adminSession, auth, repository, superadminSession, users } = harness;
    const resetDelivery = await auth.requestPasswordReset(MODEL_CREDENTIALS.admin.email);

    users.setUserStatus(superadminSession.id, adminSession.userId, USER_STATUS.BLOCKED);

    const state = repository.read();
    expect(state.users.find((user) => user.id === adminSession.userId).status).toBe(
      USER_STATUS.BLOCKED,
    );
    expect(state.sessions.find((session) => session.id === adminSession.id).revokedAt).not.toBeNull();
    expect(
      state.challenges.find((challenge) => challenge.id === resetDelivery.challengeId).revokedAt,
    ).not.toBeNull();
  });

  it("requires an active administrator target and transfers every owned norm atomically on demotion", async () => {
    const { adminSession, repository, superadminSession, users } = harness;
    repository.update((state) => {
      state.users.find((user) => user.id === adminSession.userId).passwordUpdatedAt =
        "2026-08-03T11:00:00.000Z";
    });

    await expect(
      users.changeUserRole(superadminSession.id, adminSession.userId, ROLE.MEMBER),
    ).rejects.toMatchObject({ code: "TRANSFER_REQUIRED" });
    expect(repository.read().users.find((user) => user.id === adminSession.userId).role).toBe(
      ROLE.ADMIN,
    );
    expect(repository.read().norms.every((norm) => norm.ownerAdminId === adminSession.userId)).toBe(
      true,
    );

    repository.update((state) => {
      state.users.push({
        id: "inactive-admin",
        ...privilegedProfile({ email: "inactive@example.cz" }),
        role: ROLE.ADMIN,
        status: USER_STATUS.BLOCKED,
      });
    });
    await expect(
      users.changeUserRole(
        superadminSession.id,
        adminSession.userId,
        ROLE.MEMBER,
        "inactive-admin",
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSFER_TARGET" });
    expect(repository.read().users.find((user) => user.id === adminSession.userId).role).toBe(
      ROLE.ADMIN,
    );

    users.changeUserRole(
      superadminSession.id,
      adminSession.userId,
      ROLE.MEMBER,
      superadminSession.userId,
    );

    const state = repository.read();
    expect(state.norms.every((norm) => norm.ownerAdminId === superadminSession.userId)).toBe(true);
    expect(state.users.find((user) => user.id === adminSession.userId)).toMatchObject({
      role: ROLE.MEMBER,
      status: USER_STATUS.ACTIVE,
      emailVerifiedAt: expect.anything(),
    });
    expect(state.users.find((user) => user.id === adminSession.userId)).not.toHaveProperty(
      "passwordHash",
    );
    expect(state.users.find((user) => user.id === adminSession.userId)).not.toHaveProperty(
      "passwordSalt",
    );
    expect(state.users.find((user) => user.id === adminSession.userId)).not.toHaveProperty(
      "passwordUpdatedAt",
    );
    expect(state.sessions.find((session) => session.id === adminSession.id).revokedAt).not.toBeNull();
  });

  it("promotes a member by revoking old authentication and issuing a fresh password setup", async () => {
    const { auth, repository, superadminSession, users } = harness;
    const memberCode = await auth.registerMember(memberProfile());
    const memberSession = await auth.verifyMemberCode({
      challengeId: memberCode.challengeId,
      code: memberCode.demoCode,
    });
    const openCode = await auth.requestMemberCode(memberProfile().email);

    const delivery = await users.changeUserRole(
      superadminSession.id,
      memberSession.userId,
      ROLE.ADMIN,
    );

    expect(delivery).toMatchObject({ kind: "set_password", userId: memberSession.userId });
    const state = repository.read();
    expect(state.users.find((user) => user.id === memberSession.userId)).toMatchObject({
      role: ROLE.ADMIN,
      status: USER_STATUS.INVITED,
    });
    expect(state.sessions.find((session) => session.id === memberSession.id).revokedAt).not.toBeNull();
    expect(state.challenges.find((challenge) => challenge.id === openCode.challengeId).revokedAt).not.toBeNull();
    expect(state.challenges.find((challenge) => challenge.id === delivery.challengeId).revokedAt).toBeNull();
  });

  it("audits member promotion role and status changes as separate events", async () => {
    const { auth, repository, superadminSession, users } = harness;
    const memberCode = await auth.registerMember(memberProfile({ email: "audit-promotion@example.cz" }));
    const memberSession = await auth.verifyMemberCode({
      challengeId: memberCode.challengeId,
      code: memberCode.demoCode,
    });

    await users.changeUserRole(superadminSession.id, memberSession.userId, ROLE.ADMIN);

    const events = repository
      .read()
      .auditEvents.filter(
        (event) =>
          event.targetId === memberSession.userId &&
          ["user.role_changed", "user.status_changed"].includes(event.action),
      )
      .map(({ action, metadata }) => ({ action, metadata }));
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          action: "user.role_changed",
          metadata: { oldRole: ROLE.MEMBER, newRole: ROLE.ADMIN },
        },
        {
          action: "user.status_changed",
          metadata: { oldStatus: USER_STATUS.ACTIVE, newStatus: USER_STATUS.INVITED },
        },
      ]),
    );
  });

  it("audits invited administrator demotion role and status changes as separate events", async () => {
    const { repository, superadminSession, users } = harness;
    const invited = await users.createPrivilegedUser(
      superadminSession.id,
      privilegedProfile({ email: "audit-demotion@example.cz" }),
    );

    await users.changeUserRole(superadminSession.id, invited.userId, ROLE.MEMBER);

    const events = repository
      .read()
      .auditEvents.filter(
        (event) =>
          event.targetId === invited.userId &&
          ["user.role_changed", "user.status_changed"].includes(event.action),
      )
      .map(({ action, metadata }) => ({ action, metadata }));
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          action: "user.role_changed",
          metadata: { oldRole: ROLE.ADMIN, newRole: ROLE.MEMBER },
        },
        {
          action: "user.status_changed",
          metadata: { oldStatus: USER_STATUS.INVITED, newStatus: USER_STATUS.PENDING },
        },
      ]),
    );
  });

  it.each([
    { oldRole: ROLE.ADMIN, newRole: ROLE.SUPERADMIN, email: "invited-admin-up@example.cz" },
    { oldRole: ROLE.SUPERADMIN, newRole: ROLE.ADMIN, email: "invited-admin-down@example.cz" },
  ])(
    "rotates password setup when an invited $oldRole changes to $newRole",
    async ({ oldRole, newRole, email }) => {
      const { auth, repository, superadminSession, users } = harness;
      const oldDelivery = await users.createPrivilegedUser(
        superadminSession.id,
        privilegedProfile({ email, role: oldRole }),
      );

      const newDelivery = await users.changeUserRole(
        superadminSession.id,
        oldDelivery.userId,
        newRole,
      );

      expect(newDelivery).toMatchObject({ kind: "set_password", userId: oldDelivery.userId });
      expect(newDelivery.challengeId).not.toBe(oldDelivery.challengeId);
      await expect(
        auth.completePasswordSetup({ token: oldDelivery.demoToken, password: "InvitedOld!2026" }),
      ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
      await auth.completePasswordSetup({
        token: newDelivery.demoToken,
        password: "InvitedNew!2026",
      });
      expect(repository.read().users.find((user) => user.id === oldDelivery.userId)).toMatchObject({
        role: newRole,
        status: USER_STATUS.ACTIVE,
      });
    },
  );

  it("restores a member and prior authentication when promoted password setup delivery fails", async () => {
    const { audit, auth, clock, repository, superadminSession } = harness;
    const memberCode = await auth.registerMember(memberProfile({ email: "rollback-member@example.cz" }));
    const memberSession = await auth.verifyMemberCode({
      challengeId: memberCode.challengeId,
      code: memberCode.demoCode,
    });
    await auth.requestMemberCode("rollback-member@example.cz");
    const before = repository.read();
    const users = createUserService({
      repository,
      audit,
      now: clock.now,
      auth: {
        ...auth,
        async createPasswordSetup() {
          throw new Error("delivery unavailable");
        },
      },
    });

    await expect(
      users.changeUserRole(superadminSession.id, memberSession.userId, ROLE.ADMIN),
    ).rejects.toThrow("delivery unavailable");

    const after = repository.read();
    expect(after.users.find((user) => user.id === memberSession.userId)).toEqual(
      before.users.find((user) => user.id === memberSession.userId),
    );
    expect(after.sessions.filter((session) => session.userId === memberSession.userId)).toEqual(
      before.sessions.filter((session) => session.userId === memberSession.userId),
    );
    expect(after.challenges.filter((challenge) => challenge.userId === memberSession.userId)).toEqual(
      before.challenges.filter((challenge) => challenge.userId === memberSession.userId),
    );
    expect(after.auditEvents).toEqual(before.auditEvents);
  });

  it("audits user changes and ownership transfers with old and new values but no credentials", async () => {
    const { adminSession, repository, superadminSession, users } = harness;
    const delivery = await users.createPrivilegedUser(
      superadminSession.id,
      privilegedProfile({ email: "audit-admin@example.cz" }),
    );
    users.setUserStatus(superadminSession.id, delivery.userId, USER_STATUS.BLOCKED);
    users.changeUserRole(
      superadminSession.id,
      adminSession.userId,
      ROLE.MEMBER,
      superadminSession.userId,
    );

    const events = repository.read().auditEvents.filter((event) =>
      ["user.created", "user.status_changed", "user.role_changed", "norm.ownership_transferred"].includes(
        event.action,
      ),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "user.created",
          metadata: expect.objectContaining({ oldRole: null, newRole: ROLE.ADMIN }),
        }),
        expect.objectContaining({
          action: "user.status_changed",
          metadata: expect.objectContaining({
            oldStatus: USER_STATUS.INVITED,
            newStatus: USER_STATUS.BLOCKED,
          }),
        }),
        expect.objectContaining({
          action: "user.role_changed",
          metadata: expect.objectContaining({ oldRole: ROLE.ADMIN, newRole: ROLE.MEMBER }),
        }),
        expect.objectContaining({
          action: "norm.ownership_transferred",
          metadata: expect.objectContaining({
            oldOwnerAdminId: adminSession.userId,
            newOwnerAdminId: superadminSession.userId,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toMatch(/password|token|secret/i);
  });
});

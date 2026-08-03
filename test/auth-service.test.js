import { beforeEach, describe, expect, it } from "vitest";
import { createBrowserRepository } from "../app/data/browser-repository.js";
import { CHALLENGE_TYPE, LIMITS, ROLE, USER_STATUS } from "../app/domain/constants.js";
import { createCryptoAdapter } from "../app/security/crypto-adapter.js";
import { createAuditService } from "../app/services/audit-service.js";
import { createAuthService } from "../app/services/auth-service.js";
import { createFakeClock, createMemoryStorage } from "./fakes.js";

const MODEL_CREDENTIALS = {
  superadmin: { email: "superadmin@sokol.cz", password: "SuperSokol!2026" },
  admin: { email: "admin@sokol.cz", password: "AdminSokol!2026" },
};

function createHarness() {
  const clock = createFakeClock();
  const repository = createBrowserRepository({ storage: createMemoryStorage() });
  const baseCryptoAdapter = createCryptoAdapter(globalThis.crypto);
  const cryptoAdapter = { ...baseCryptoAdapter, randomDigits: () => "123456" };
  const audit = createAuditService(repository, clock.now);
  const auth = createAuthService({ repository, audit, cryptoAdapter, now: clock.now });
  return { auth, audit, clock, repository };
}

function invitedAdmin() {
  return {
    id: "user-admin-invited",
    firstName: "Anna",
    lastName: "Novakova",
    email: "anna.admin@example.cz",
    role: ROLE.ADMIN,
    status: USER_STATUS.INVITED,
  };
}

describe("auth service", () => {
  let harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("registers a member and exchanges the one-time code for an eight-hour session", async () => {
    const { auth, clock, repository } = harness;
    const delivery = await auth.registerMember({
      firstName: "Jan",
      lastName: "Novak",
      email: "JAN.NOVAK@example.cz",
    });

    expect(delivery.kind).toBe("member_code");
    await expect(auth.verifyMemberCode({ challengeId: delivery.challengeId, code: "000000" }))
      .rejects.toMatchObject({ code: "INVALID_CODE" });
    const session = await auth.verifyMemberCode({
      challengeId: delivery.challengeId,
      code: delivery.demoCode,
    });

    expect(session.expiresAt - clock.now()).toBe(8 * 60 * 60 * 1000);
    expect(auth.getSession(session.id).user).toMatchObject({
      email: "jan.novak@example.cz",
      role: ROLE.MEMBER,
      status: USER_STATUS.ACTIVE,
    });
    await expect(
      auth.verifyMemberCode({ challengeId: delivery.challengeId, code: delivery.demoCode }),
    ).rejects.toMatchObject({ code: "CODE_USED" });

    const persisted = repository.read();
    expect(persisted.challenges[0]).toMatchObject({
      type: CHALLENGE_TYPE.MEMBER_CODE,
      attempts: 1,
    });
    expect(JSON.stringify(persisted)).not.toContain(delivery.demoCode);
  });

  it("expires a member code after ten minutes", async () => {
    const { auth, clock } = harness;
    const delivery = await auth.registerMember({
      firstName: "Jan",
      lastName: "Novak",
      email: "member-expiry@example.cz",
    });
    clock.advance(LIMITS.memberCodeMs + 1);

    await expect(
      auth.verifyMemberCode({ challengeId: delivery.challengeId, code: delivery.demoCode }),
    ).rejects.toMatchObject({ code: "CODE_EXPIRED" });
  });

  it("issues a fresh member code without revealing whether an email exists", async () => {
    const { auth } = harness;
    await auth.registerMember({
      firstName: "Jan",
      lastName: "Novak",
      email: "member-resend@example.cz",
    });

    const neutralDelivery = await auth.requestMemberCode("unknown@example.cz");
    expect(neutralDelivery).toEqual({ kind: "member_code" });
    const delivery = await auth.requestMemberCode("member-resend@example.cz");

    expect(delivery.kind).toBe(neutralDelivery.kind);
    await expect(
      auth.verifyMemberCode({ challengeId: delivery.challengeId, code: delivery.demoCode }),
    ).resolves.toMatchObject({ userId: delivery.userId });
  });

  it("locks a member code on the fifth incorrect attempt", async () => {
    const { auth } = harness;
    const delivery = await auth.registerMember({
      firstName: "Jan",
      lastName: "Novak",
      email: "member-lock@example.cz",
    });

    for (let attempt = 1; attempt < LIMITS.maxCodeAttempts; attempt += 1) {
      await expect(
        auth.verifyMemberCode({ challengeId: delivery.challengeId, code: "000000" }),
      ).rejects.toMatchObject({ code: "INVALID_CODE" });
    }
    await expect(
      auth.verifyMemberCode({ challengeId: delivery.challengeId, code: "000000" }),
    ).rejects.toMatchObject({ code: "CODE_LOCKED" });
    await expect(
      auth.verifyMemberCode({ challengeId: delivery.challengeId, code: delivery.demoCode }),
    ).rejects.toMatchObject({ code: "CODE_LOCKED" });
  });

  it("initializes both model passwords once without replacing a changed password", async () => {
    const { auth, repository } = harness;
    await auth.ensureDemoCredentials();

    await expect(
      auth.loginWithPassword(MODEL_CREDENTIALS.superadmin),
    ).resolves.toMatchObject({ userId: "user-superadmin-demo" });
    const adminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);
    await auth.changePassword({
      sessionId: adminSession.id,
      currentPassword: MODEL_CREDENTIALS.admin.password,
      newPassword: "ChangedSokol!2027",
    });

    const changedHash = repository.read().users.find((user) => user.id === "user-admin-demo").passwordHash;
    await auth.ensureDemoCredentials();

    expect(repository.read().users.find((user) => user.id === "user-admin-demo").passwordHash).toBe(changedHash);
    await expect(auth.loginWithPassword(MODEL_CREDENTIALS.admin)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    await expect(
      auth.loginWithPassword({ email: MODEL_CREDENTIALS.admin.email, password: "ChangedSokol!2027" }),
    ).resolves.toMatchObject({ userId: "user-admin-demo" });
  });

  it("sets an invited administrator password through a 30-minute one-time link", async () => {
    const { auth, repository } = harness;
    repository.update((state) => state.users.push(invitedAdmin()));
    await auth.ensureDemoCredentials();
    const actor = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);

    const delivery = await auth.createPasswordSetup(actor.id, invitedAdmin().id);
    await expect(
      auth.completePasswordSetup({ token: delivery.demoToken, password: "short" }),
    ).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    await auth.completePasswordSetup({ token: delivery.demoToken, password: "InvitedSokol!2026" });

    await expect(
      auth.loginWithPassword({ email: invitedAdmin().email, password: "InvitedSokol!2026" }),
    ).resolves.toMatchObject({ userId: invitedAdmin().id });
    await expect(
      auth.completePasswordSetup({ token: delivery.demoToken, password: "AnotherSokol!2026" }),
    ).rejects.toMatchObject({ code: "TOKEN_USED" });
    const persisted = repository.read();
    expect(JSON.stringify(persisted)).not.toContain(delivery.demoToken);
    expect(persisted.users.find((user) => user.id === invitedAdmin().id)).not.toHaveProperty("password");
  });

  it("expires password links after thirty minutes", async () => {
    const { auth, clock, repository } = harness;
    repository.update((state) => state.users.push(invitedAdmin()));
    await auth.ensureDemoCredentials();
    const actor = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);
    const delivery = await auth.createPasswordSetup(actor.id, invitedAdmin().id);
    clock.advance(LIMITS.passwordLinkMs + 1);

    await expect(
      auth.completePasswordSetup({ token: delivery.demoToken, password: "InvitedSokol!2026" }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("resets a password once, invalidates the old password, and is neutral for an unknown email", async () => {
    const { auth } = harness;
    await auth.ensureDemoCredentials();

    const neutralDelivery = await auth.requestPasswordReset("unknown@example.cz");
    expect(neutralDelivery).toEqual({ kind: "password_reset_requested" });
    const delivery = await auth.requestPasswordReset(MODEL_CREDENTIALS.admin.email);
    expect(delivery.kind).toBe(neutralDelivery.kind);
    await auth.completePasswordReset({ token: delivery.demoToken, password: "ResetSokol!2027" });

    await expect(auth.loginWithPassword(MODEL_CREDENTIALS.admin)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    await expect(
      auth.loginWithPassword({ email: MODEL_CREDENTIALS.admin.email, password: "ResetSokol!2027" }),
    ).resolves.toMatchObject({ userId: "user-admin-demo" });
    await expect(
      auth.completePasswordReset({ token: delivery.demoToken, password: "AnotherSokol!2027" }),
    ).rejects.toMatchObject({ code: "TOKEN_USED" });
  });

  it("rejects expired, logged-out, revoked, and blocked-account sessions", async () => {
    const { auth, clock, repository } = harness;
    await auth.ensureDemoCredentials();
    const expired = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);
    clock.advance(LIMITS.sessionMs + 1);
    expect(() => auth.getSession(expired.id)).toThrow(expect.objectContaining({ code: "SESSION_EXPIRED" }));

    const loggedOut = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);
    auth.logout(loggedOut.id);
    expect(() => auth.getSession(loggedOut.id)).toThrow(expect.objectContaining({ code: "SESSION_REVOKED" }));

    const revoked = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);
    auth.revokeUserSessions(revoked.userId);
    expect(() => auth.getSession(revoked.id)).toThrow(expect.objectContaining({ code: "SESSION_REVOKED" }));

    const blocked = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);
    repository.update((state) => {
      state.users.find((user) => user.id === blocked.userId).status = USER_STATUS.BLOCKED;
    });
    expect(() => auth.getSession(blocked.id)).toThrow(expect.objectContaining({ code: "ACCOUNT_BLOCKED" }));
  });

  it("keeps delivered secrets out of audit metadata", async () => {
    const { auth, audit } = harness;
    const delivery = await auth.registerMember({
      firstName: "Jan",
      lastName: "Novak",
      email: "audit-member@example.cz",
    });

    expect(JSON.stringify(audit.listForTarget("user", delivery.userId))).not.toContain(delivery.demoCode);
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { problemResponse } from "../../server/http/problem-details";
import { createAuthService } from "../../server/modules/identity/auth-service";
import { createSecretService } from "../../server/modules/identity/secret-service";
import { createTotpVault } from "../../server/modules/identity/totp-vault";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  seedActiveMember,
  seedOrganization,
  testSql,
} from "./db-test-context";

const secrets = createSecretService({
  sessionHmacKey: "session-key-".repeat(4),
  otpHmacKey: "otp-key-value-".repeat(4),
  csrfHmacKey: "csrf-key-value-".repeat(4),
});
const totp = createTotpVault({ encryptionKey: "t".repeat(32) });
const auth = createAuthService({ sql: testSql, secrets, totp, exposeTestSecrets: true });

beforeAll(migrateTestDatabase);
beforeEach(async () => {
  await resetTestDatabase();
  await seedOrganization({ code: "PRAHA-1", name: "TJ Sokol Praha 1" });
});

async function seedAdminWithCredentials(input: {
  status?: "active" | "invited" | "blocked";
  password?: string;
  mfa?: boolean;
  role?: "admin" | "superadmin";
} = {}) {
  const admin = await seedActiveAdmin({ role: input.role });
  const status = input.status ?? "active";
  await testSql`update users set status = ${status} where id = ${admin.id}`;
  const passwordHash = await secrets.hashPassword(input.password ?? "Correct-Horse-1!");
  const mfaSecret = totp.newSecret();
  await testSql`
    insert into admin_credentials (
      user_id, password_hash, totp_secret_ciphertext, totp_enabled_at
    ) values (
      ${admin.id}, ${passwordHash},
      ${input.mfa === false ? null : totp.encrypt(mfaSecret)},
      ${input.mfa === false ? null : new Date()}
    )
  `;
  return { ...admin, mfaSecret };
}

describe("production authentication workflows", () => {
  it("registers a member only after a valid six-digit code", async () => {
    const delivery = await auth.requestMemberCode({
      email: "clen@example.cz",
      firstName: "Jan",
      lastName: "Sokol",
      organizationCode: "PRAHA-1",
      membershipId: null,
    });
    expect(delivery.publicResult).toEqual({ accepted: true });
    expect(delivery.testOnlyCode).toMatch(/^\d{6}$/);
    const session = await auth.verifyMemberCode(
      delivery.challengeId,
      delivery.testOnlyCode!,
    );
    expect(session.user.emailVerifiedAt).not.toBeNull();
    expect(await auth.resolveSession(session.token)).toMatchObject({ role: "member" });
  });

  it("does not reveal whether an unknown email exists", async () => {
    const member = await seedActiveMember();
    const known = await auth.requestMemberCode({ email: member.email });
    const unknown = await auth.requestMemberCode({ email: "unknown@example.cz" });
    expect(known.publicResult).toEqual(unknown.publicResult);
  });

  it("creates an ordinary administrator session immediately after a valid password", async () => {
    const admin = await seedAdminWithCredentials({ mfa: false });

    const session = await auth.verifyAdminPassword(admin.email, "Correct-Horse-1!");

    if ("kind" in session) throw new Error("Direct administrator session expected");
    expect(session).toMatchObject({ user: { role: "admin" } });
    expect(await auth.resolveSession(session.token)).toMatchObject({ role: "admin" });
    expect(await testSql`select * from login_challenges where kind='admin_mfa'`).toHaveLength(0);
  });

  it("requires password and TOTP before creating a superadministrator session", async () => {
    const admin = await seedAdminWithCredentials({ role: "superadmin" });
    const pending = await auth.verifyAdminPassword(admin.email, "Correct-Horse-1!");
    if (!("loginAttemptId" in pending)) throw new Error("MFA challenge expected");
    expect(pending.kind).toBe("mfa_required");
    await expect(auth.resolveSession(pending.loginAttemptId)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const session = await auth.verifyAdminMfa(
      pending.loginAttemptId,
      totp.generate(admin.mfaSecret),
    );
    expect(session.user.role).toBe("superadmin");
  });

  it("locks member challenge after fifth invalid code", async () => {
    const member = await seedActiveMember();
    const delivery = await auth.requestMemberCode({ email: member.email });
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await expect(auth.verifyMemberCode(delivery.challengeId, "000000")).rejects.toMatchObject({
        code: "CODE_INVALID",
      });
    }
    await expect(auth.verifyMemberCode(delivery.challengeId, "000000")).rejects.toMatchObject({
      code: "CODE_LOCKED",
    });
    await expect(
      auth.verifyMemberCode(delivery.challengeId, delivery.testOnlyCode!),
    ).rejects.toMatchObject({ code: "CODE_LOCKED" });
  });

  it("rejects expired code", async () => {
    const member = await seedActiveMember();
    const delivery = await auth.requestMemberCode({ email: member.email });
    await testSql`
      update login_challenges set expires_at = now() - interval '1 second'
      where id = ${delivery.challengeId}
    `;
    await expect(
      auth.verifyMemberCode(delivery.challengeId, delivery.testOnlyCode!),
    ).rejects.toMatchObject({ code: "CODE_EXPIRED" });
    expect(await testSql`select * from sessions`).toHaveLength(0);
  });

  it("rejects consumed code", async () => {
    const member = await seedActiveMember();
    const delivery = await auth.requestMemberCode({ email: member.email });
    await auth.verifyMemberCode(delivery.challengeId, delivery.testOnlyCode!);
    await expect(
      auth.verifyMemberCode(delivery.challengeId, delivery.testOnlyCode!),
    ).rejects.toMatchObject({ code: "CODE_USED" });
  });

  it("revokes sibling challenges when issuing a new code", async () => {
    const member = await seedActiveMember();
    const older = await auth.requestMemberCode({ email: member.email });
    const newer = await auth.requestMemberCode({ email: member.email });
    await expect(
      auth.verifyMemberCode(older.challengeId, older.testOnlyCode!),
    ).rejects.toMatchObject({ code: "CODE_REVOKED" });
    await expect(
      auth.verifyMemberCode(newer.challengeId, newer.testOnlyCode!),
    ).resolves.toBeDefined();
  });

  it("blocks both login methods for blocked user", async () => {
    const member = await seedActiveMember();
    await testSql`update users set status = 'blocked' where id = ${member.id}`;
    const delivery = await auth.requestMemberCode({ email: member.email });
    await expect(
      auth.verifyMemberCode(delivery.challengeId, delivery.testOnlyCode!),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const admin = await seedAdminWithCredentials({ status: "blocked" });
    await expect(
      auth.verifyAdminPassword(admin.email, "Correct-Horse-1!"),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await testSql`select * from sessions`).toHaveLength(0);
  });

  it("rotates current session after reauthentication", async () => {
    const member = await seedActiveMember();
    const firstCode = await auth.requestMemberCode({ email: member.email });
    const first = await auth.verifyMemberCode(firstCode.challengeId, firstCode.testOnlyCode!);
    const secondCode = await auth.requestMemberCode({ email: member.email });
    const second = await auth.verifyMemberCode(
      secondCode.challengeId,
      secondCode.testOnlyCode!,
      first.sessionId,
    );
    await expect(auth.resolveSession(first.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(auth.resolveSession(second.token)).resolves.toBeDefined();
  });

  it("logout revokes the current session", async () => {
    const member = await seedActiveMember();
    const delivery = await auth.requestMemberCode({ email: member.email });
    const session = await auth.verifyMemberCode(delivery.challengeId, delivery.testOnlyCode!);
    await auth.logout(session.sessionId);
    await expect(auth.resolveSession(session.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("maps invalid JSON and internal error safely", async () => {
    const malformed = problemResponse(new SyntaxError("Unexpected token secret-password"), crypto.randomUUID());
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toMatch(/secret-password|stack/i);
    const internal = problemResponse(new Error("database secret-password"), crypto.randomUUID());
    expect(internal.status).toBe(500);
    expect(await internal.text()).not.toMatch(/secret-password|stack/i);
  });

  it("activates an invited ordinary administrator immediately after password setup", async () => {
    const admin = await seedAdminWithCredentials({ status: "invited", mfa: false });
    const setupToken = secrets.newSessionToken();
    await testSql`
      insert into login_challenges (user_id, kind, secret_hash, expires_at)
      values (
        ${admin.id}, 'set_password', ${secrets.hashSessionToken(setupToken)},
        now() + interval '30 minutes'
      )
    `;
    const setup = await auth.completeAdminSetup(setupToken, "Correct-Horse-1!");
    expect(setup).toEqual({ kind: "password_ready" });
    expect(await testSql`select status from users where id=${admin.id}`)
      .toEqual([{ status: "active" }]);
    await expect(auth.verifyAdminPassword(admin.email, "Correct-Horse-1!"))
      .resolves.toMatchObject({ user: { role: "admin" } });
  });

  it("activates an invited superadministrator only after password setup and confirmed MFA", async () => {
    const admin = await seedAdminWithCredentials({
      status: "invited",
      mfa: false,
      role: "superadmin",
    });
    const setupToken = secrets.newSessionToken();
    await testSql`
      insert into login_challenges (user_id, kind, secret_hash, expires_at)
      values (
        ${admin.id}, 'set_password', ${secrets.hashSessionToken(setupToken)},
        now() + interval '30 minutes'
      )
    `;

    const setup = await auth.completeAdminSetup(setupToken, "Correct-Horse-1!");
    expect(setup.kind).toBe("mfa_enrollment_required");
    if (setup.kind !== "mfa_enrollment_required") throw new Error("MFA setup expected");
    const enrollment = await auth.beginMfaEnrollment(setup.setupAttemptId);
    expect(enrollment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const session = await auth.confirmMfaEnrollment(
      setup.setupAttemptId,
      totp.generate(enrollment.testOnlySecret!),
    );
    expect(session.user).toMatchObject({ status: "active", role: "superadmin" });
  });

  it("consumes a password-reset token once and revokes all existing sessions", async () => {
    const admin = await seedAdminWithCredentials({ role: "superadmin" });
    const pending = await auth.verifyAdminPassword(admin.email, "Correct-Horse-1!");
    if (!("loginAttemptId" in pending)) throw new Error("MFA challenge expected");
    const oldSession = await auth.verifyAdminMfa(
      pending.loginAttemptId,
      totp.generate(admin.mfaSecret),
    );
    const reset = await auth.requestPasswordReset(admin.email);
    await auth.completePasswordReset(reset.testOnlyToken!, "Different-Horse-2!");
    await expect(auth.resolveSession(oldSession.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(
      auth.completePasswordReset(reset.testOnlyToken!, "Third-Horse-3!"),
    ).rejects.toMatchObject({ code: "TOKEN_USED" });
  });
});

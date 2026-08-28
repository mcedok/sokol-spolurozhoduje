import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertCsrf } from "../../server/http/csrf";
import { sessionCookieOptions } from "../../server/http/session-cookie";
import { createSecretService } from "../../server/modules/identity/secret-service";
import {
  createSession,
  resolveActor,
  revokeSession,
} from "../../server/modules/identity/session-repository";
import * as sessionRepository from "../../server/modules/identity/session-repository";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  testSql,
} from "./db-test-context";

const secrets = createSecretService({
  sessionHmacKey: "s".repeat(32),
  otpHmacKey: "o".repeat(32),
  csrfHmacKey: "c".repeat(32),
});

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

describe("server security primitives", () => {
  it("stores no recoverable OTP or session token", () => {
    const otpHash = secrets.hashOtp("challenge-id", "123456");
    const token = secrets.newSessionToken();
    expect(otpHash).not.toContain("123456");
    expect(secrets.hashSessionToken(token)).not.toContain(token);
    expect(secrets.verifyOtp("challenge-id", "123456", otpHash)).toBe(true);
  });

  it("creates six-digit OTPs and secure password hashes", async () => {
    expect(secrets.newOtp()).toMatch(/^\d{6}$/);
    const encoded = await secrets.hashPassword("Correct Horse Battery Staple");
    expect(encoded).toMatch(/^\$argon2id\$/);
    expect(await secrets.verifyPassword("Correct Horse Battery Staple", encoded)).toBe(true);
    expect(await secrets.verifyPassword("wrong", encoded)).toBe(false);
  });

  it("uses the required host-only secure cookie", () => {
    expect(sessionCookieOptions).toMatchObject({
      name: "__Host-sokol_session",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(sessionCookieOptions).not.toHaveProperty("domain");
  });

  it("creates, resolves, rotates, and revokes a server session", async () => {
    const admin = await seedActiveAdmin();
    const first = await createSession(testSql, secrets, {
      userId: admin.id,
      ttlMs: 60_000,
    });
    expect(await resolveActor(testSql, secrets, first.token)).toMatchObject({
      userId: admin.id,
      role: "admin",
      sessionId: first.sessionId,
    });
    await expect(assertCsrf(testSql, secrets, first.sessionId, first.csrfToken)).resolves.toBeUndefined();

    const second = await createSession(testSql, secrets, {
      userId: admin.id,
      ttlMs: 60_000,
      currentSessionId: first.sessionId,
    });
    expect(await resolveActor(testSql, secrets, first.token)).toBeNull();
    expect(await resolveActor(testSql, secrets, second.token)).not.toBeNull();

    await revokeSession(testSql, second.sessionId);
    expect(await resolveActor(testSql, secrets, second.token)).toBeNull();
  });

  it("rejects a wrong CSRF token", async () => {
    const admin = await seedActiveAdmin();
    const session = await createSession(testSql, secrets, {
      userId: admin.id,
      ttlMs: 60_000,
    });
    await expect(
      assertCsrf(testSql, secrets, session.sessionId, "wrong-token"),
    ).rejects.toThrow(/CSRF/);
  });

  it("renews the CSRF token of an existing authenticated session", async () => {
    const admin = await seedActiveAdmin();
    const session = await createSession(testSql, secrets, {
      userId: admin.id,
      ttlMs: 60_000,
    });
    const renewCsrfToken = (sessionRepository as Record<string, unknown>).renewCsrfToken as
      | ((...args: unknown[]) => Promise<string>)
      | undefined;

    const renewed = await renewCsrfToken?.(testSql, secrets, session.sessionId);

    expect(renewed).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    await expect(assertCsrf(testSql, secrets, session.sessionId, renewed)).resolves.toBeUndefined();
    await expect(assertCsrf(testSql, secrets, session.sessionId, session.csrfToken)).rejects.toThrow(/CSRF/);
  });
});

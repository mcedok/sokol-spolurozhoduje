import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Actor } from "../../contracts";
import { buildBootstrapSnapshot } from "../../server/bootstrap-service";
import { createDocumentService } from "../../server/modules/documents/document-service";
import { createAuthService } from "../../server/modules/identity/auth-service";
import { createSecretService } from "../../server/modules/identity/secret-service";
import { createSession } from "../../server/modules/identity/session-repository";
import { createTotpVault } from "../../server/modules/identity/totp-vault";
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
  sessionHmacKey: "phase-a-session-key-".repeat(2),
  otpHmacKey: "phase-a-otp-key-".repeat(3),
  csrfHmacKey: "phase-a-csrf-key-".repeat(3),
});
const totp = createTotpVault({ encryptionKey: "a".repeat(32) });
const auth = createAuthService({ sql: testSql, secrets, totp, exposeTestSecrets: true });
const users = createUserService({ sql: testSql, secrets });
const documents = createDocumentService({ sql: testSql });

beforeAll(migrateTestDatabase);
beforeEach(async () => {
  await resetTestDatabase();
  await seedOrganization({ code: "PRAHA-1", name: "TJ Sokol Praha 1" });
});

async function seedAdminCredentials(role: "admin" | "superadmin") {
  const user = await seedActiveAdmin({ role });
  const password = "Correct-Horse-1!";
  const mfaSecret = totp.newSecret();
  await testSql`
    insert into admin_credentials (
      user_id, password_hash, totp_secret_ciphertext, totp_enabled_at
    ) values (
      ${user.id}, ${await secrets.hashPassword(password)},
      ${totp.encrypt(mfaSecret)}, now()
    )
  `;
  return { user, password, mfaSecret };
}

function actorFrom(session: { sessionId: string; user: { id: string; role: Actor["role"] } }): Actor {
  return { userId: session.user.id, role: session.user.role, sessionId: session.sessionId };
}

it("completes the approved phase A lifecycle", async () => {
  const seededSuperadmin = await seedAdminCredentials("superadmin");
  const pendingSuperadmin = await auth.verifyAdminPassword(
    seededSuperadmin.user.email,
    seededSuperadmin.password,
  );
  if (!("loginAttemptId" in pendingSuperadmin)) throw new Error("MFA challenge expected");
  const superadminSession = await auth.verifyAdminMfa(
    pendingSuperadmin.loginAttemptId,
    totp.generate(seededSuperadmin.mfaSecret),
  );
  const superadmin = actorFrom(superadminSession);

  const adminInviteKey = crypto.randomUUID();
  const invited = await users.createAdministrator(superadmin, {
    email: "predkladatel@example.cz",
    firstName: "Petr",
    lastName: "Předkladatel",
    organizationCode: "PRAHA-1",
    membershipId: null,
    role: "admin",
  }, adminInviteKey);
  const [inviteEvent] = await testSql<{ payload: { setupToken: string } }[]>`
    select payload from outbox_events where idempotency_key = ${adminInviteKey}
  `;
  const setup = await auth.completeAdminSetup(inviteEvent.payload.setupToken, "Admin-Horse-2!");
  expect(setup).toEqual({ kind: "password_ready" });
  const adminSession = await auth.verifyAdminPassword("predkladatel@example.cz", "Admin-Horse-2!");
  if ("kind" in adminSession) throw new Error("Direct administrator session expected");
  const admin = actorFrom(adminSession);
  expect(admin.userId).toBe(invited.id);

  const documentKey = crypto.randomUUID();
  const document = await documents.createDocument(admin, {
    title: "Návrh směrnice",
    explanatoryReport: "Důvodová zpráva",
    visibilityMode: "public_detail",
    fourEyesRequired: false,
    idempotencyKey: documentKey,
  });
  const retriedDocument = await documents.createDocument(admin, {
    title: "Návrh směrnice",
    explanatoryReport: "Důvodová zpráva",
    visibilityMode: "public_detail",
    fourEyesRequired: false,
    idempotencyKey: documentKey,
  });
  expect(retriedDocument.id).toBe(document.id);

  const otherAdmin = await seedAdminCredentials("admin");
  const otherActor: Actor = {
    userId: otherAdmin.user.id,
    role: "admin",
    sessionId: crypto.randomUUID(),
  };
  await expect(documents.updateDocument(otherActor, document.id, {
    title: "Cizí změna",
    explanatoryReport: document.explanatoryReport,
    visibilityMode: document.visibilityMode,
    fourEyesRequired: document.fourEyesRequired,
    rowVersion: document.rowVersion,
    idempotencyKey: crypto.randomUUID(),
  })).rejects.toMatchObject({ code: "FORBIDDEN" });

  await testSql`
    update documents set status = 'published_open', comments_open = true
    where id = ${document.id}
  `;
  const publicSnapshot = await buildBootstrapSnapshot(testSql, null);
  expect(publicSnapshot.documents[0].title).toBe("Návrh směrnice");
  expect(JSON.stringify(publicSnapshot)).not.toMatch(
    /"(email|membershipId|ownerAdminId|rowVersion)"\s*:/i,
  );

  const transferred = await documents.transferOwnership(
    superadmin,
    document.id,
    otherAdmin.user.id,
    { rowVersion: document.rowVersion, idempotencyKey: crypto.randomUUID() },
  );
  expect([document.rowVersion, transferred.rowVersion]).toEqual([1, 2]);

  const member = await seedActiveMember();
  const oldBlockedUserSession = await createSession(testSql, secrets, {
    userId: member.id,
    ttlMs: 60_000,
  });
  await users.changeUserStatus(superadmin, member.id, "blocked", {
    rowVersion: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  await expect(auth.resolveSession(oldBlockedUserSession.token)).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });

  const auditRows = await testSql<{ action: string; metadata: unknown }[]>`
    select action, metadata from audit_events order by created_at, id
  `;
  expect(auditRows.map((row) => row.action)).toEqual(expect.arrayContaining([
    "auth.admin_login",
    "user.created",
    "document.created",
    "authorization.denied",
    "document.owner_transferred",
  ]));
  expect(JSON.stringify(auditRows)).not.toMatch(/Correct-Horse|Admin-Horse|totp|sessionToken/i);
  const [{ count }] = await testSql<{ count: number }[]>`
    select count(*)::int as count from outbox_events where idempotency_key = ${documentKey}
  `;
  expect(count).toBe(1);
});

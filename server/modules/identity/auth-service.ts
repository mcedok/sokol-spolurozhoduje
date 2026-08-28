import type { Sql } from "postgres";
import type { Role, UserStatus } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { appendOutbox } from "../outbox/outbox-writer";
import {
  findAuthUserByEmail,
  findAuthUserById,
  findChallengeByHashForUpdate,
  findChallengeByIdForUpdate,
  type AuthUserRow,
  type ChallengeRow,
} from "./auth-repository";
import { AuthError, unauthenticated } from "./auth-errors";
import type { SecretService } from "./secret-service";
import {
  createSessionInTransaction,
  resolveActor,
  revokeSession,
  type CreatedSession,
} from "./session-repository";
import type { TotpVault } from "./totp-vault";

export const AUTH_LIMITS = {
  otpLifetimeMs: 10 * 60 * 1000,
  maxOtpAttempts: 5,
  adminLoginAttemptMs: 5 * 60 * 1000,
  passwordLinkMs: 30 * 60 * 1000,
  sessionLifetimeMs: 8 * 60 * 60 * 1000,
} as const;

interface AuthServiceDependencies {
  sql: Sql;
  secrets: SecretService;
  totp: TotpVault;
  exposeTestSecrets?: boolean;
}

interface MemberCodeInput {
  email: string;
  firstName?: string;
  lastName?: string;
  organizationCode?: string;
  membershipId?: string | null;
}

interface SessionUser {
  id: string;
  role: Role;
  status: UserStatus;
  firstName: string;
  lastName: string;
  organizationName: string;
  emailVerifiedAt: string | null;
}

export interface AuthSession extends CreatedSession {
  user: SessionUser;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function challengeError(challenge: ChallengeRow | null, noun = "CODE"): AuthError | null {
  if (!challenge) return unauthenticated();
  if (challenge.locked_at) return new AuthError(`${noun}_LOCKED`, "Ověření bylo uzamčeno.");
  if (challenge.used_at) return new AuthError(`${noun}_USED`, "Ověření již bylo použito.");
  if (challenge.revoked_at) return new AuthError(`${noun}_REVOKED`, "Ověření bylo nahrazeno.");
  if (challenge.expires_at.getTime() <= Date.now()) {
    return new AuthError(`${noun}_EXPIRED`, "Platnost ověření vypršela.");
  }
  return null;
}

function sessionUser(user: AuthUserRow): SessionUser {
  return {
    id: user.id,
    role: user.role,
    status: user.status,
    firstName: user.first_name,
    lastName: user.last_name,
    organizationName: user.organization_name,
    emailVerifiedAt: user.email_verified_at?.toISOString() ?? null,
  };
}

function assertPassword(password: string): void {
  if (password.length < 12) {
    throw new AuthError("PASSWORD_TOO_SHORT", "Heslo musí mít alespoň 12 znaků.");
  }
}

export function createAuthService({
  sql,
  secrets,
  totp,
  exposeTestSecrets = process.env.NODE_ENV === "test",
}: AuthServiceDependencies) {
  const dummyPasswordHash = secrets.hashPassword("Dummy-password-never-valid-1!");

  async function appendPublicDenial(
    action: string,
    correlationId: string,
    targetId?: string,
  ): Promise<void> {
    await appendDeniedAudit(sql, {
      actor: null,
      action,
      targetType: "authentication",
      targetId,
      correlationId,
    });
  }

  async function loadSessionUser(created: CreatedSession): Promise<AuthSession> {
    const userId = (await resolveActor(sql, secrets, created.token))?.userId;
    const user = userId ? await findAuthUserById(sql, userId) : null;
    if (!user) throw unauthenticated();
    return { ...created, user: sessionUser(user) };
  }

  return {
    async requestMemberCode(
      input: MemberCodeInput,
      correlationId = crypto.randomUUID(),
    ) {
      const email = normalizeEmail(input.email);
      const code = secrets.newOtp();
      const challengeId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + AUTH_LIMITS.otpLifetimeMs);

      await withTransaction(sql, async (tx) => {
        let user = await findAuthUserByEmail(tx, email);
        if (
          !user && input.firstName?.trim() && input.lastName?.trim() && input.organizationCode
        ) {
          const [organization] = await tx<{ id: string }[]>`
            select id from organizations where code = ${input.organizationCode} and active = true
          `;
          if (!organization) throw new AuthError("ORGANIZATION_NOT_FOUND", "Jednota nebyla nalezena.", 404);
          const [created] = await tx<{ id: string }[]>`
            insert into users (
              organization_id, first_name, last_name, email, membership_id, role, status
            ) values (
              ${organization.id}, ${input.firstName.trim()}, ${input.lastName.trim()},
              ${email}, ${input.membershipId ?? null}, 'member', 'invited'
            ) returning id
          `;
          user = await findAuthUserById(tx, created.id);
        }

        const eligibleUser =
          user?.role === "member" && user.status !== "blocked" ? user : null;
        const userId = eligibleUser?.id ?? null;
        if (userId) {
          await tx`
            update login_challenges set revoked_at = now()
            where user_id = ${userId} and kind = 'member_code'
              and used_at is null and revoked_at is null
          `;
        } else {
          await tx`
            update login_challenges set revoked_at = now()
            where pending_email = ${email} and kind = 'member_code'
              and used_at is null and revoked_at is null
          `;
        }
        await tx`
          insert into login_challenges (
            id, user_id, pending_email, kind, secret_hash, expires_at
          ) values (
            ${challengeId}, ${userId}, ${userId ? null : email}, 'member_code',
            ${secrets.hashOtp(challengeId, code)}, ${expiresAt}
          )
        `;
        if (eligibleUser) {
          await appendOutbox(tx, {
            eventType: "identity.member_code_requested",
            aggregateType: "login_challenge",
            aggregateId: challengeId,
            idempotencyKey: crypto.randomUUID(),
            payload: { email, code },
          });
        }
        await appendAudit(
          tx,
          {
            actor: null,
            action: "auth.member_code_requested",
            targetType: "login_challenge",
            targetId: challengeId,
            correlationId,
            metadata: { email },
          },
          "allowed",
        );
      });

      return {
        publicResult: { accepted: true as const },
        challengeId,
        ...(exposeTestSecrets ? { testOnlyCode: code } : {}),
      };
    },

    async verifyMemberCode(
      challengeId: string,
      code: string,
      currentSessionId?: string,
      correlationId = crypto.randomUUID(),
    ) {
      const result = await withTransaction(sql, async (tx) => {
        const challenge = await findChallengeByIdForUpdate(tx, challengeId);
        const stateError = challengeError(challenge);
        if (stateError) {
          await appendAudit(tx, {
            actor: null, action: "auth.member_code_denied", targetType: "login_challenge",
            targetId: challengeId, correlationId, metadata: { code },
          }, "denied");
          return { error: stateError } as const;
        }

        if (!secrets.verifyOtp(challengeId, code, challenge!.secret_hash)) {
          const attempts = challenge!.attempts + 1;
          const locked = attempts >= AUTH_LIMITS.maxOtpAttempts;
          await tx`
            update login_challenges
            set attempts = ${attempts}, locked_at = ${locked ? new Date() : null}
            where id = ${challengeId}
          `;
          await appendAudit(tx, {
            actor: null, action: "auth.member_code_denied", targetType: "login_challenge",
            targetId: challengeId, correlationId, metadata: { code },
          }, "denied");
          return {
            error: new AuthError(
              locked ? "CODE_LOCKED" : "CODE_INVALID",
              locked ? "Ověření bylo uzamčeno." : "Kód není správný.",
            ),
          } as const;
        }

        const user = challenge!.user_id
          ? await findAuthUserById(tx, challenge!.user_id)
          : null;
        if (!user || user.role !== "member" || user.status === "blocked") {
          await tx`update login_challenges set used_at = now() where id = ${challengeId}`;
          await appendAudit(tx, {
            actor: null, action: "auth.member_code_denied", targetType: "login_challenge",
            targetId: challengeId, correlationId, metadata: { reason: "ineligible" },
          }, "denied");
          return { error: unauthenticated() } as const;
        }

        await tx`update login_challenges set used_at = now() where id = ${challengeId}`;
        await tx`
          update users set status = 'active', email_verified_at = coalesce(email_verified_at, now())
          where id = ${user.id}
        `;
        const created = await createSessionInTransaction(tx, secrets, {
          userId: user.id,
          ttlMs: AUTH_LIMITS.sessionLifetimeMs,
          currentSessionId,
        });
        await appendAudit(tx, {
          actor: null, action: "auth.member_login", targetType: "user", targetId: user.id,
          correlationId,
        }, "allowed");
        return { created } as const;
      });
      if ("error" in result) throw result.error;
      return loadSessionUser(result.created);
    },

    async verifyAdminPassword(
      emailInput: string,
      password: string,
      correlationId = crypto.randomUUID(),
    ) {
      const email = normalizeEmail(emailInput);
      const user = await findAuthUserByEmail(sql, email);
      const eligible =
        user && (user.role === "admin" || user.role === "superadmin") &&
        user.status === "active" && user.password_hash &&
        (user.role === "admin" || user.totp_enabled_at);
      const passwordHash = eligible ? user.password_hash! : await dummyPasswordHash;
      if (!(await secrets.verifyPassword(password, passwordHash)) || !eligible) {
        await appendPublicDenial("auth.admin_password_denied", correlationId, user?.id);
        throw unauthenticated();
      }

      if (user.role === "admin") {
        const created = await withTransaction(sql, async (tx) => {
          const session = await createSessionInTransaction(tx, secrets, {
            userId: user.id,
            ttlMs: AUTH_LIMITS.sessionLifetimeMs,
          });
          await appendAudit(tx, {
            actor: null,
            action: "auth.admin_login",
            targetType: "user",
            targetId: user.id,
            correlationId,
            metadata: { mfaRequired: false },
          }, "allowed");
          return session;
        });
        return loadSessionUser(created);
      }

      const loginAttemptId = secrets.newSessionToken();
      const challengeId = crypto.randomUUID();
      await withTransaction(sql, async (tx) => {
        await tx`
          update login_challenges set revoked_at = now()
          where user_id = ${user.id} and kind = 'admin_mfa'
            and used_at is null and revoked_at is null
        `;
        await tx`
          insert into login_challenges (id, user_id, kind, secret_hash, expires_at)
          values (
            ${challengeId}, ${user.id}, 'admin_mfa',
            ${secrets.hashSessionToken(loginAttemptId)},
            ${new Date(Date.now() + AUTH_LIMITS.adminLoginAttemptMs)}
          )
        `;
        await appendAudit(tx, {
          actor: null, action: "auth.admin_password_verified", targetType: "user",
          targetId: user.id, correlationId,
        }, "allowed");
      });
      return { kind: "mfa_required" as const, loginAttemptId };
    },

    async verifyAdminMfa(
      loginAttemptId: string,
      token: string,
      currentSessionId?: string,
      correlationId = crypto.randomUUID(),
    ) {
      const result = await withTransaction(sql, async (tx) => {
        const challenge = await findChallengeByHashForUpdate(
          tx, "admin_mfa", secrets.hashSessionToken(loginAttemptId),
        );
        const stateError = challengeError(challenge);
        const user = challenge?.user_id ? await findAuthUserById(tx, challenge.user_id) : null;
        if (
          stateError || !user || user.status !== "active" ||
          (user.role !== "admin" && user.role !== "superadmin") ||
          !user.totp_enabled_at || !user.totp_secret_ciphertext
        ) {
          await appendAudit(tx, {
            actor: null, action: "auth.admin_mfa_denied", targetType: "authentication",
            targetId: challenge?.id, correlationId, metadata: { token },
          }, "denied");
          return { error: stateError ?? unauthenticated() } as const;
        }
        const secret = totp.decrypt(user.totp_secret_ciphertext);
        if (!totp.verify(secret, token)) {
          await appendAudit(tx, {
            actor: null, action: "auth.admin_mfa_denied", targetType: "authentication",
            targetId: challenge!.id, correlationId, metadata: { token },
          }, "denied");
          return { error: unauthenticated() } as const;
        }
        await tx`update login_challenges set used_at = now() where id = ${challenge!.id}`;
        const created = await createSessionInTransaction(tx, secrets, {
          userId: user.id, ttlMs: AUTH_LIMITS.sessionLifetimeMs, currentSessionId,
        });
        await appendAudit(tx, {
          actor: null, action: "auth.admin_login", targetType: "user", targetId: user.id,
          correlationId,
        }, "allowed");
        return { created } as const;
      });
      if ("error" in result) throw result.error;
      return loadSessionUser(result.created);
    },

    async completeAdminSetup(
      rawToken: string,
      password: string,
      correlationId = crypto.randomUUID(),
    ) {
      assertPassword(password);
      const passwordHash = await secrets.hashPassword(password);
      const setupAttemptId = secrets.newSessionToken();
      const result = await withTransaction(sql, async (tx) => {
        const challenge = await findChallengeByHashForUpdate(
          tx, "set_password", secrets.hashSessionToken(rawToken),
        );
        const error = challengeError(challenge, "TOKEN");
        const user = challenge?.user_id ? await findAuthUserById(tx, challenge.user_id) : null;
        if (error || !user || user.status !== "invited" || user.role === "member") {
          return { error: error ?? unauthenticated() } as const;
        }
        await tx`update login_challenges set used_at = now() where id = ${challenge!.id}`;
        await tx`
          update admin_credentials
          set password_hash = ${passwordHash}, password_updated_at = now(),
              totp_secret_ciphertext = null, totp_enabled_at = null
          where user_id = ${user.id}
        `;
        if (user.role === "admin") {
          await tx`
            update users set status='active', email_verified_at=now(), updated_at=now()
            where id=${user.id}
          `;
        } else {
          await tx`
            insert into login_challenges (user_id, kind, secret_hash, expires_at)
            values (
              ${user.id}, 'mfa_enrollment', ${secrets.hashSessionToken(setupAttemptId)},
              ${new Date(Date.now() + AUTH_LIMITS.passwordLinkMs)}
            )
          `;
        }
        await appendAudit(tx, {
          actor: null, action: "auth.admin_password_setup", targetType: "user", targetId: user.id,
          correlationId, metadata: { mfaRequired: user.role === "superadmin" },
        }, "allowed");
        return user.role === "admin"
          ? { kind: "password_ready" as const }
          : { kind: "mfa_enrollment_required" as const, setupAttemptId };
      });
      if ("error" in result) throw result.error;
      return result;
    },

    async beginMfaEnrollment(
      setupAttemptId: string,
      correlationId = crypto.randomUUID(),
    ) {
      const secret = totp.newSecret();
      const result = await withTransaction(sql, async (tx) => {
        const challenge = await findChallengeByHashForUpdate(
          tx, "mfa_enrollment", secrets.hashSessionToken(setupAttemptId),
        );
        const error = challengeError(challenge, "TOKEN");
        const user = challenge?.user_id ? await findAuthUserById(tx, challenge.user_id) : null;
        if (error || !user || user.status !== "invited" || user.role !== "superadmin") {
          return { error: error ?? unauthenticated() } as const;
        }
        await tx`
          update admin_credentials set totp_secret_ciphertext = ${totp.encrypt(secret)}
          where user_id = ${user.id}
        `;
        await appendAudit(tx, {
          actor: null, action: "auth.mfa_enrollment_started", targetType: "user", targetId: user.id,
          correlationId,
        }, "allowed");
        return { email: user.email } as const;
      });
      if ("error" in result) throw result.error;
      return {
        otpauthUri: totp.uri(result.email, secret),
        ...(exposeTestSecrets ? { testOnlySecret: secret } : {}),
      };
    },

    async confirmMfaEnrollment(
      setupAttemptId: string,
      token: string,
      correlationId = crypto.randomUUID(),
    ) {
      const result = await withTransaction(sql, async (tx) => {
        const challenge = await findChallengeByHashForUpdate(
          tx, "mfa_enrollment", secrets.hashSessionToken(setupAttemptId),
        );
        const error = challengeError(challenge, "TOKEN");
        const user = challenge?.user_id ? await findAuthUserById(tx, challenge.user_id) : null;
        if (
          error || !user || user.status !== "invited" || user.role !== "superadmin" ||
          !user.totp_secret_ciphertext
        ) return { error: error ?? unauthenticated() } as const;
        const secret = totp.decrypt(user.totp_secret_ciphertext);
        if (!totp.verify(secret, token)) return { error: unauthenticated() } as const;
        await tx`update login_challenges set used_at = now() where id = ${challenge!.id}`;
        await tx`
          update admin_credentials set totp_enabled_at = now() where user_id = ${user.id}
        `;
        await tx`update users set status = 'active', email_verified_at = now() where id = ${user.id}`;
        const created = await createSessionInTransaction(tx, secrets, {
          userId: user.id, ttlMs: AUTH_LIMITS.sessionLifetimeMs,
        });
        await appendAudit(tx, {
          actor: null, action: "auth.mfa_enrollment_confirmed", targetType: "user", targetId: user.id,
          correlationId,
        }, "allowed");
        return { created } as const;
      });
      if ("error" in result) throw result.error;
      return loadSessionUser(result.created);
    },

    async requestPasswordReset(
      emailInput: string,
      correlationId = crypto.randomUUID(),
    ) {
      const email = normalizeEmail(emailInput);
      const user = await findAuthUserByEmail(sql, email);
      const eligible = Boolean(
        user && user.status !== "blocked" && user.role !== "member" && user.password_hash,
      );
      const token = secrets.newSessionToken();
      const challengeId = crypto.randomUUID();
      await withTransaction(sql, async (tx) => {
        if (eligible) {
          await tx`
            update login_challenges set revoked_at = now()
            where user_id = ${user!.id} and kind = 'reset_password'
              and used_at is null and revoked_at is null
          `;
        } else {
          await tx`
            update login_challenges set revoked_at = now()
            where pending_email = ${email} and kind = 'reset_password'
              and used_at is null and revoked_at is null
          `;
        }
        await tx`
          insert into login_challenges (
            id, user_id, pending_email, kind, secret_hash, expires_at
          ) values (
            ${challengeId}, ${eligible ? user!.id : null}, ${eligible ? null : email},
            'reset_password', ${secrets.hashSessionToken(token)},
            ${new Date(Date.now() + AUTH_LIMITS.passwordLinkMs)}
          )
        `;
        if (eligible) {
          await appendOutbox(tx, {
            eventType: "identity.password_reset_requested",
            aggregateType: "login_challenge",
            aggregateId: challengeId,
            idempotencyKey: crypto.randomUUID(),
            payload: { email, token },
          });
        }
        await appendAudit(tx, {
          actor: null, action: "auth.password_reset_requested", targetType: "login_challenge",
          targetId: challengeId, correlationId, metadata: { email },
        }, "allowed");
      });
      return {
        publicResult: { accepted: true as const },
        ...(exposeTestSecrets ? { testOnlyToken: token } : {}),
      };
    },

    async completePasswordReset(
      rawToken: string,
      password: string,
      correlationId = crypto.randomUUID(),
    ) {
      assertPassword(password);
      const passwordHash = await secrets.hashPassword(password);
      const result = await withTransaction(sql, async (tx) => {
        const challenge = await findChallengeByHashForUpdate(
          tx, "reset_password", secrets.hashSessionToken(rawToken),
        );
        const error = challengeError(challenge, "TOKEN");
        const user = challenge?.user_id ? await findAuthUserById(tx, challenge.user_id) : null;
        if (error || !user || user.role === "member" || user.status === "blocked") {
          return { error: error ?? unauthenticated() } as const;
        }
        await tx`update login_challenges set used_at = now() where id = ${challenge!.id}`;
        await tx`
          update admin_credentials
          set password_hash = ${passwordHash}, password_updated_at = now()
          where user_id = ${user.id}
        `;
        await tx`
          update sessions set revoked_at = coalesce(revoked_at, now()) where user_id = ${user.id}
        `;
        await appendAudit(tx, {
          actor: null, action: "auth.password_reset_completed", targetType: "user", targetId: user.id,
          correlationId,
        }, "allowed");
        return { ok: true } as const;
      });
      if ("error" in result) throw result.error;
      return { completed: true as const };
    },

    async resolveSession(token: string) {
      const actor = await resolveActor(sql, secrets, token);
      if (!actor) throw unauthenticated();
      return actor;
    },

    async logout(sessionId: string, correlationId = crypto.randomUUID()) {
      await withTransaction(sql, async (tx) => {
        const [row] = await tx<{ user_id: string; role: Role }[]>`
          select sessions.user_id, users.role
          from sessions join users on users.id = sessions.user_id
          where sessions.id = ${sessionId}
          for update
        `;
        await revokeSession(tx, sessionId);
        if (row) {
          await appendAudit(tx, {
            actor: { userId: row.user_id, role: row.role, sessionId },
            action: "auth.logout",
            targetType: "session",
            targetId: sessionId,
            correlationId,
          }, "allowed");
        }
      });
      return { completed: true as const };
    },
  };
}

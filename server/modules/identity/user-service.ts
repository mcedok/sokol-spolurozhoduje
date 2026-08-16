import type { Sql } from "postgres";
import type {
  Actor,
  AdminUserView,
  Role,
  UserStatus,
  VersionedCommand,
} from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { appendOutbox } from "../outbox/outbox-writer";
import { AuthError, unauthenticated } from "./auth-errors";
import type { SecretService } from "./secret-service";
import {
  findAdminUserView,
  listAdminUserViews,
  type UserFilters,
} from "./user-repository";

export interface CreateAdministratorInput {
  email: string;
  firstName: string;
  lastName: string;
  organizationCode: string;
  membershipId: string | null;
  role: "admin" | "superadmin";
}

export interface UpdateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  organizationCode: string;
  membershipId: string | null;
}

class UserCommandError extends AuthError {
  constructor(code: string, message: string, status: number, public readonly ownedDocumentCount?: number) {
    super(code, message, status);
  }
}

function roleRank(role: Role): number {
  return { member: 0, admin: 1, superadmin: 2 }[role];
}

export function createUserService({ sql, secrets }: { sql: Sql; secrets: SecretService }) {
  async function requireSuperadmin(
    actor: Actor | null,
    action: string,
    targetId?: string,
    correlationId = crypto.randomUUID(),
  ): Promise<Actor> {
    if (actor?.role === "superadmin") return actor;
    await appendDeniedAudit(sql, {
      actor,
      action,
      targetType: "user",
      targetId,
      correlationId,
    });
    if (!actor) throw unauthenticated();
    throw new AuthError("FORBIDDEN", "Tuto operaci může provést pouze superadministrátor.", 403);
  }

  async function mutationError(
    tx: Sql,
    actor: Actor,
    action: string,
    targetId: string,
    correlationId: string,
    error: AuthError,
  ) {
    await appendAudit(tx, {
      actor, action, targetType: "user", targetId, correlationId,
      metadata: { reason: error.code },
    }, "denied");
    return { error } as const;
  }

  return {
    async listUsers(
      actor: Actor | null,
      filters: UserFilters,
      correlationId = crypto.randomUUID(),
    ): Promise<AdminUserView[]> {
      const authorized = await requireSuperadmin(actor, "user.list_denied", undefined, correlationId);
      return withTransaction(sql, async (tx) => {
        const result = await listAdminUserViews(tx, filters);
        await appendAudit(tx, {
          actor: authorized, action: "user.listed", targetType: "user",
          correlationId, metadata: { resultCount: result.length },
        }, "allowed");
        return result;
      });
    },

    async createAdministrator(
      actor: Actor | null,
      input: CreateAdministratorInput,
      idempotencyKey: string,
      correlationId = crypto.randomUUID(),
    ): Promise<AdminUserView> {
      const authorized = await requireSuperadmin(actor, "user.create_denied", undefined, correlationId);
      const passwordPlaceholder = await secrets.hashPassword(secrets.newSessionToken());
      const setupToken = secrets.newSessionToken();

      const result = await withTransaction(sql, async (tx) => {
        const [existingEvent] = await tx<{ aggregate_id: string; event_type: string }[]>`
          select aggregate_id, event_type from outbox_events where idempotency_key = ${idempotencyKey}
        `;
        if (existingEvent) {
          if (existingEvent.event_type !== "identity.admin_invited") {
            return mutationError(tx, authorized, "user.create_denied", existingEvent.aggregate_id, correlationId,
              new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409));
          }
          const existing = await findAdminUserView(tx, existingEvent.aggregate_id);
          if (!existing) throw new Error("Idempotent user result is missing");
          await appendAudit(tx, {
            actor: authorized, action: "user.created", targetType: "user",
            targetId: existing.id, correlationId, metadata: { idempotentReplay: true },
          }, "allowed");
          return { user: existing } as const;
        }

        const [organization] = await tx<{ id: string }[]>`
          select id from organizations where code = ${input.organizationCode} and active = true
        `;
        if (!organization) {
          return mutationError(tx, authorized, "user.create_denied", authorized.userId, correlationId,
            new AuthError("ORGANIZATION_NOT_FOUND", "Jednota nebyla nalezena.", 404));
        }
        const [duplicate] = await tx<{ id: string }[]>`
          select id from users where email = ${input.email.trim().toLowerCase()}
        `;
        if (duplicate) {
          return mutationError(tx, authorized, "user.create_denied", duplicate.id, correlationId,
            new AuthError("EMAIL_EXISTS", "Uživatel s tímto e-mailem již existuje.", 409));
        }

        const [created] = await tx<{ id: string }[]>`
          insert into users (
            organization_id, first_name, last_name, email, membership_id, role, status
          ) values (
            ${organization.id}, ${input.firstName.trim()}, ${input.lastName.trim()},
            ${input.email.trim().toLowerCase()}, ${input.membershipId}, ${input.role}, 'invited'
          ) returning id
        `;
        await tx`
          insert into admin_credentials (user_id, password_hash)
          values (${created.id}, ${passwordPlaceholder})
        `;
        await tx`
          insert into login_challenges (user_id, kind, secret_hash, expires_at)
          values (
            ${created.id}, 'set_password', ${secrets.hashSessionToken(setupToken)},
            now() + interval '30 minutes'
          )
        `;
        await appendOutbox(tx, {
          eventType: "identity.admin_invited",
          aggregateType: "user",
          aggregateId: created.id,
          idempotencyKey,
          payload: { email: input.email.trim().toLowerCase(), setupToken },
        });
        await appendAudit(tx, {
          actor: authorized, action: "user.created", targetType: "user",
          targetId: created.id, correlationId, metadata: { role: input.role },
        }, "allowed");
        const user = await findAdminUserView(tx, created.id);
        if (!user) throw new Error("Created user is missing");
        return { user } as const;
      });
      if ("error" in result) throw result.error;
      return result.user;
    },

    async updateUserProfile(
      actor: Actor | null,
      userId: string,
      input: UpdateUserInput & VersionedCommand,
      correlationId = crypto.randomUUID(),
    ): Promise<AdminUserView> {
      const authorized = await requireSuperadmin(actor, "user.profile_update_denied", userId, correlationId);
      const result = await withTransaction(sql, async (tx) => {
        const [organization] = await tx<{ id: string }[]>`
          select id from organizations where code = ${input.organizationCode} and active = true
        `;
        if (!organization) return mutationError(tx, authorized, "user.profile_update_denied", userId,
          correlationId, new AuthError("ORGANIZATION_NOT_FOUND", "Jednota nebyla nalezena.", 404));
        const updated = await tx<{ id: string }[]>`
          update users set organization_id = ${organization.id}, first_name = ${input.firstName.trim()},
            last_name = ${input.lastName.trim()}, email = ${input.email.trim().toLowerCase()},
            membership_id = ${input.membershipId}, row_version = row_version + 1, updated_at = now()
          where id = ${userId} and row_version = ${input.rowVersion}
          returning id
        `;
        if (!updated.length) return mutationError(tx, authorized, "user.profile_update_denied", userId,
          correlationId, new AuthError("VERSION_CONFLICT", "Uživatel byl mezitím změněn.", 409));
        await appendAudit(tx, { actor: authorized, action: "user.profile_updated", targetType: "user",
          targetId: userId, correlationId }, "allowed");
        return { user: (await findAdminUserView(tx, userId))! } as const;
      });
      if ("error" in result) throw result.error;
      return result.user;
    },

    async changeUserRole(
      actor: Actor | null,
      userId: string,
      role: Role,
      command: VersionedCommand,
      correlationId = crypto.randomUUID(),
    ): Promise<AdminUserView> {
      const authorized = await requireSuperadmin(actor, "user.role_change_denied", userId, correlationId);
      const result = await withTransaction(sql, async (tx) => {
        const [target] = await tx<{ role: Role; status: UserStatus; row_version: number; email: string }[]>`
          select role, status, row_version, email::text from users where id = ${userId} for update
        `;
        if (!target) return mutationError(tx, authorized, "user.role_change_denied", userId, correlationId,
          new AuthError("NOT_FOUND", "Uživatel nebyl nalezen.", 404));
        if (target.row_version !== command.rowVersion) return mutationError(tx, authorized,
          "user.role_change_denied", userId, correlationId,
          new AuthError("VERSION_CONFLICT", "Uživatel byl mezitím změněn.", 409));

        if (target.role === "superadmin" && role !== "superadmin" && target.status === "active") {
          await tx`select pg_advisory_xact_lock(hashtext('active_superadmin'))`;
          const [{ count }] = await tx<{ count: number }[]>`
            select count(*)::int as count from users where role = 'superadmin' and status = 'active'
          `;
          if (count <= 1) return mutationError(tx, authorized, "user.role_change_denied", userId,
            correlationId, new AuthError("LAST_ACTIVE_SUPERADMIN", "Posledního superadministrátora nelze degradovat.", 409));
        }
        if (role === "member" && target.role !== "member") {
          const [{ count }] = await tx<{ count: number }[]>`
            select count(*)::int as count from documents where owner_admin_id = ${userId}
          `;
          if (count > 0) return mutationError(tx, authorized, "user.role_change_denied", userId,
            correlationId, new UserCommandError("TRANSFER_REQUIRED", "Nejprve převeďte vlastnictví dokumentů.", 409, count));
        }

        const promotingMember = target.role === "member" && role !== "member";
        await tx`
          update users set role = ${role},
            status = ${promotingMember ? "invited" : target.status},
            row_version = row_version + 1, updated_at = now()
          where id = ${userId} and row_version = ${command.rowVersion}
        `;
        if (roleRank(role) !== roleRank(target.role)) {
          await tx`update sessions set revoked_at = coalesce(revoked_at, now()) where user_id = ${userId}`;
          await tx`update login_challenges set revoked_at = coalesce(revoked_at, now())
            where user_id = ${userId} and used_at is null`;
        }
        if (role === "member" && target.role !== "member") {
          await tx`delete from admin_credentials where user_id = ${userId}`;
        }
        if (promotingMember) {
          const setupToken = secrets.newSessionToken();
          const passwordPlaceholder = await secrets.hashPassword(secrets.newSessionToken());
          await tx`
            insert into admin_credentials (user_id, password_hash)
            values (${userId}, ${passwordPlaceholder})
          `;
          await tx`
            insert into login_challenges (user_id, kind, secret_hash, expires_at)
            values (
              ${userId}, 'set_password', ${secrets.hashSessionToken(setupToken)},
              now() + interval '30 minutes'
            )
          `;
          await appendOutbox(tx, {
            eventType: "identity.admin_invited",
            aggregateType: "user",
            aggregateId: userId,
            idempotencyKey: command.idempotencyKey,
            payload: { email: target.email, setupToken },
          });
        }
        await appendAudit(tx, { actor: authorized, action: "user.role_changed", targetType: "user",
          targetId: userId, correlationId, metadata: { from: target.role, to: role } }, "allowed");
        return { user: (await findAdminUserView(tx, userId))! } as const;
      });
      if ("error" in result) throw result.error;
      return result.user;
    },

    async changeUserStatus(
      actor: Actor | null,
      userId: string,
      status: UserStatus,
      command: VersionedCommand,
      correlationId = crypto.randomUUID(),
    ): Promise<AdminUserView> {
      const authorized = await requireSuperadmin(actor, "user.status_change_denied", userId, correlationId);
      const result = await withTransaction(sql, async (tx) => {
        const [target] = await tx<{ role: Role; status: UserStatus; row_version: number }[]>`
          select role, status, row_version from users where id = ${userId} for update
        `;
        if (!target) return mutationError(tx, authorized, "user.status_change_denied", userId,
          correlationId, new AuthError("NOT_FOUND", "Uživatel nebyl nalezen.", 404));
        if (target.row_version !== command.rowVersion) return mutationError(tx, authorized,
          "user.status_change_denied", userId, correlationId,
          new AuthError("VERSION_CONFLICT", "Uživatel byl mezitím změněn.", 409));
        if (target.role === "superadmin" && target.status === "active" && status !== "active") {
          await tx`select pg_advisory_xact_lock(hashtext('active_superadmin'))`;
          const [{ count }] = await tx<{ count: number }[]>`
            select count(*)::int as count from users where role = 'superadmin' and status = 'active'
          `;
          if (count <= 1) return mutationError(tx, authorized, "user.status_change_denied", userId,
            correlationId, new AuthError("LAST_ACTIVE_SUPERADMIN", "Posledního superadministrátora nelze zablokovat.", 409));
        }
        await tx`
          update users set status = ${status}, row_version = row_version + 1, updated_at = now()
          where id = ${userId} and row_version = ${command.rowVersion}
        `;
        if (status === "blocked") {
          await tx`update sessions set revoked_at = coalesce(revoked_at, now()) where user_id = ${userId}`;
          await tx`update login_challenges set revoked_at = coalesce(revoked_at, now())
            where user_id = ${userId} and used_at is null`;
        }
        await appendAudit(tx, { actor: authorized, action: "user.status_changed", targetType: "user",
          targetId: userId, correlationId, metadata: { from: target.status, to: status } }, "allowed");
        return { user: (await findAdminUserView(tx, userId))! } as const;
      });
      if ("error" in result) throw result.error;
      return result.user;
    },
  };
}

import type { Sql } from "postgres";
import type {
  Actor,
  DocumentAdminView,
  DocumentStatus,
  PublicDocumentSummary,
  VersionedCommand,
} from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { AuthError, unauthenticated } from "../identity/auth-errors";
import { appendOutbox } from "../outbox/outbox-writer";
import {
  adminView,
  findDocumentAdminView,
  findDocumentRow,
  findVisibleDocument,
  listPublicDocuments,
} from "./document-repository";
import { canTransition } from "./document-state-machine";

export interface CreateDocumentInput {
  title: string;
  explanatoryReport: string;
  visibilityMode: "public_detail" | "login_required_detail";
  fourEyesRequired: boolean;
  idempotencyKey: string;
}

export interface UpdateDocumentInput {
  title: string;
  explanatoryReport: string;
  visibilityMode: "public_detail" | "login_required_detail";
  fourEyesRequired: boolean;
}

function requiresApproval(status: DocumentStatus): boolean {
  return ["published_open", "approved", "rejected"].includes(status);
}

export function createDocumentService({ sql }: { sql: Sql }) {
  async function requireManager(
    actor: Actor | null,
    action: string,
    targetId?: string,
    correlationId = crypto.randomUUID(),
  ): Promise<Actor> {
    if (actor && (actor.role === "admin" || actor.role === "superadmin")) return actor;
    await appendDeniedAudit(sql, {
      actor, action, targetType: "document", targetId, correlationId,
    });
    if (!actor) throw unauthenticated();
    throw new AuthError("FORBIDDEN", "K dokumentu nemáte oprávnění.", 403);
  }

  async function denied(
    tx: Sql,
    actor: Actor,
    action: string,
    documentId: string,
    correlationId: string,
    error: AuthError,
  ) {
    await appendAudit(tx, {
      actor, action, targetType: "document", targetId: documentId, correlationId,
      metadata: { reason: error.code },
    }, "denied");
    await appendAudit(tx, {
      actor,
      action: "authorization.denied",
      targetType: "document",
      targetId: documentId,
      correlationId,
      metadata: { attemptedAction: action, reason: error.code },
    }, "denied");
    return { error } as const;
  }

  async function classifyMutationFailure(
    tx: Sql,
    actor: Actor,
    documentId: string,
    expectedVersion: number,
  ): Promise<AuthError> {
    const row = await findDocumentRow(tx, documentId);
    if (!row) return new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);
    if (actor.role !== "superadmin" && row.owner_admin_id !== actor.userId) {
      return new AuthError("FORBIDDEN", "Administrátor může spravovat jen vlastní dokumenty.", 403);
    }
    if (row.row_version !== expectedVersion) {
      return new AuthError("VERSION_CONFLICT", "Dokument byl mezitím změněn.", 409);
    }
    return new AuthError("CONFLICT", "Dokument nelze změnit.", 409);
  }

  return {
    async listVisibleDocuments(actor: Actor | null): Promise<PublicDocumentSummary[]> {
      return listPublicDocuments(sql, Boolean(actor));
    },

    async getVisibleDocument(
      actor: Actor | null,
      documentId: string,
    ): Promise<PublicDocumentSummary> {
      const document = await findVisibleDocument(sql, documentId, Boolean(actor));
      if (!document) throw new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);
      return document;
    },

    async getManagedDocument(
      actorInput: Actor | null,
      documentId: string,
      correlationId = crypto.randomUUID(),
    ): Promise<DocumentAdminView> {
      const actor = await requireManager(actorInput, "document.read_denied", documentId, correlationId);
      const document = await findDocumentAdminView(sql, documentId);
      if (!document) throw new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);
      if (actor.role !== "superadmin" && document.ownerAdminId !== actor.userId) {
        await appendDeniedAudit(sql, { actor, action: "document.read_denied", targetType: "document",
          targetId: documentId, correlationId });
        throw new AuthError("FORBIDDEN", "Administrátor může spravovat jen vlastní dokumenty.", 403);
      }
      return document;
    },

    async createDocument(
      actorInput: Actor | null,
      input: CreateDocumentInput,
      correlationId = crypto.randomUUID(),
    ): Promise<DocumentAdminView> {
      const actor = await requireManager(actorInput, "document.create_denied", undefined, correlationId);
      const result = await withTransaction(sql, async (tx) => {
        const [existing] = await tx<{ aggregate_id: string; event_type: string }[]>`
          select aggregate_id, event_type from outbox_events where idempotency_key = ${input.idempotencyKey}
        `;
        if (existing) {
          if (existing.event_type !== "document.created") {
            return denied(tx, actor, "document.create_denied", existing.aggregate_id, correlationId,
              new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409));
          }
          const document = await findDocumentAdminView(tx, existing.aggregate_id);
          if (!document) throw new Error("Idempotent document result is missing");
          await appendAudit(tx, { actor, action: "document.created", targetType: "document",
            targetId: document.id, correlationId, metadata: { idempotentReplay: true } }, "allowed");
          return { document } as const;
        }
        const year = new Date().getUTCFullYear();
        const [{ last_value: sequence }] = await tx<{ last_value: number }[]>`
          insert into document_sequences(year, last_value) values (${year}, 1)
          on conflict (year) do update
          set last_value = document_sequences.last_value + 1
          returning last_value
        `;
        const number = `SOKOL-${year}-${String(sequence).padStart(3, "0")}`;
        const [created] = await tx<{ id: string }[]>`
          insert into documents (
            number, title, explanatory_report, owner_admin_id,
            visibility_mode, four_eyes_required
          ) values (
            ${number}, ${input.title.trim()}, ${input.explanatoryReport}, ${actor.userId},
            ${input.visibilityMode}, ${input.fourEyesRequired}
          ) returning id
        `;
        await appendOutbox(tx, {
          eventType: "document.created", aggregateType: "document", aggregateId: created.id,
          idempotencyKey: input.idempotencyKey, payload: { number },
        });
        await appendAudit(tx, { actor, action: "document.created", targetType: "document",
          targetId: created.id, correlationId, metadata: { number } }, "allowed");
        return { document: (await findDocumentAdminView(tx, created.id))! } as const;
      });
      if ("error" in result) throw result.error;
      return result.document;
    },

    async updateDocument(
      actorInput: Actor | null,
      documentId: string,
      input: UpdateDocumentInput & VersionedCommand,
      correlationId = crypto.randomUUID(),
    ): Promise<DocumentAdminView> {
      const actor = await requireManager(actorInput, "document.update_denied", documentId, correlationId);
      const result = await withTransaction(sql, async (tx) => {
        const updated = await tx<{ id: string }[]>`
          update documents set title = ${input.title.trim()},
            explanatory_report = ${input.explanatoryReport}, visibility_mode = ${input.visibilityMode},
            four_eyes_required = ${input.fourEyesRequired}, row_version = row_version + 1,
            updated_at = now()
          where id = ${documentId} and row_version = ${input.rowVersion}
            and (${actor.role === "superadmin"} or owner_admin_id = ${actor.userId})
          returning id
        `;
        if (!updated.length) return denied(tx, actor, "document.update_denied", documentId,
          correlationId, await classifyMutationFailure(tx, actor, documentId, input.rowVersion));
        await appendAudit(tx, { actor, action: "document.updated", targetType: "document",
          targetId: documentId, correlationId }, "allowed");
        return { document: (await findDocumentAdminView(tx, documentId))! } as const;
      });
      if ("error" in result) throw result.error;
      return result.document;
    },

    async changeDocumentStatus(
      actorInput: Actor | null,
      documentId: string,
      status: DocumentStatus,
      reason: string,
      command: VersionedCommand,
      correlationId = crypto.randomUUID(),
    ): Promise<DocumentAdminView> {
      const actor = await requireManager(actorInput, "document.status_change_denied", documentId, correlationId);
      const result = await withTransaction(sql, async (tx) => {
        const row = await findDocumentRow(tx, documentId);
        if (!row) return denied(tx, actor, "document.status_change_denied", documentId, correlationId,
          new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404));
        if (actor.role !== "superadmin" && row.owner_admin_id !== actor.userId) {
          return denied(tx, actor, "document.status_change_denied", documentId, correlationId,
            new AuthError("FORBIDDEN", "Administrátor může spravovat jen vlastní dokumenty.", 403));
        }
        if (row.row_version !== command.rowVersion) return denied(tx, actor,
          "document.status_change_denied", documentId, correlationId,
          new AuthError("VERSION_CONFLICT", "Dokument byl mezitím změněn.", 409));
        if (status === "comments_closed" && !reason.trim()) return denied(tx, actor,
          "document.status_change_denied", documentId, correlationId,
          new AuthError("CLOSURE_REASON_REQUIRED", "Uzavření připomínek vyžaduje odůvodnění.", 400));
        if (!canTransition(row.status, status)) return denied(tx, actor,
          "document.status_change_denied", documentId, correlationId,
          new AuthError("INVALID_TRANSITION", "Tento stavový přechod není povolen.", 409));

        if (row.four_eyes_required && requiresApproval(status)) {
          await tx`
            insert into document_approvals (
              document_id, requested_by_user_id, requested_status, requested_row_version, reason
            ) values (${documentId}, ${actor.userId}, ${status}, ${command.rowVersion}, ${reason.trim() || null})
            on conflict (document_id, requested_status) where decision is null do nothing
          `;
          await appendAudit(tx, { actor, action: "document.approval_requested", targetType: "document",
            targetId: documentId, correlationId, metadata: { requestedStatus: status } }, "allowed");
          return { document: adminView(row) } as const;
        }

        await tx`
          update documents set status = ${status}, comments_open = ${status === "published_open"},
            closure_reason = case when ${status} = 'comments_closed' then ${reason.trim()} else closure_reason end,
            row_version = row_version + 1, updated_at = now()
          where id = ${documentId} and row_version = ${command.rowVersion}
            and (${actor.role === "superadmin"} or owner_admin_id = ${actor.userId})
        `;
        await tx`
          insert into document_state_transitions (
            document_id, actor_user_id, from_status, to_status, reason
          ) values (${documentId}, ${actor.userId}, ${row.status}, ${status}, ${reason.trim() || null})
        `;
        await appendAudit(tx, { actor, action: "document.status_changed", targetType: "document",
          targetId: documentId, correlationId, metadata: { from: row.status, to: status } }, "allowed");
        return { document: (await findDocumentAdminView(tx, documentId))! } as const;
      });
      if ("error" in result) throw result.error;
      return result.document;
    },

    async transferOwnership(
      actorInput: Actor | null,
      documentId: string,
      ownerAdminId: string,
      command: VersionedCommand,
      correlationId = crypto.randomUUID(),
    ): Promise<DocumentAdminView> {
      const actor = await requireManager(actorInput, "document.owner_transfer_denied", documentId, correlationId);
      if (actor.role !== "superadmin") {
        await appendDeniedAudit(sql, { actor, action: "document.owner_transfer_denied",
          targetType: "document", targetId: documentId, correlationId });
        throw new AuthError("FORBIDDEN", "Vlastnictví může převést jen superadministrátor.", 403);
      }
      const result = await withTransaction(sql, async (tx) => {
        const [owner] = await tx<{ id: string }[]>`
          select id from users where id = ${ownerAdminId} and status = 'active'
            and role in ('admin', 'superadmin')
        `;
        if (!owner) return denied(tx, actor, "document.owner_transfer_denied", documentId,
          correlationId, new AuthError("OWNER_INVALID", "Nový vlastník není aktivní administrátor.", 409));
        const updated = await tx<{ id: string }[]>`
          update documents set owner_admin_id = ${ownerAdminId}, row_version = row_version + 1,
            updated_at = now()
          where id = ${documentId} and row_version = ${command.rowVersion}
          returning id
        `;
        if (!updated.length) return denied(tx, actor, "document.owner_transfer_denied", documentId,
          correlationId, await classifyMutationFailure(tx, actor, documentId, command.rowVersion));
        await appendAudit(tx, { actor, action: "document.owner_transferred", targetType: "document",
          targetId: documentId, correlationId, metadata: { ownerAdminId } }, "allowed");
        return { document: (await findDocumentAdminView(tx, documentId))! } as const;
      });
      if ("error" in result) throw result.error;
      return result.document;
    },

    async decideApproval(
      actorInput: Actor | null,
      approvalId: string,
      decision: "approved" | "rejected",
      reason: string,
      correlationId = crypto.randomUUID(),
    ): Promise<DocumentAdminView> {
      const actor = await requireManager(actorInput, "document.approval_denied", undefined, correlationId);
      if (actor.role !== "superadmin") {
        await appendDeniedAudit(sql, { actor, action: "document.approval_denied",
          targetType: "document_approval", targetId: approvalId, correlationId });
        throw new AuthError("FORBIDDEN", "Schválení může provést jen superadministrátor.", 403);
      }
      const result = await withTransaction(sql, async (tx) => {
        const [approval] = await tx<{
          document_id: string; requested_by_user_id: string; requested_status: DocumentStatus;
          requested_row_version: number; decision: "approved" | "rejected" | null;
        }[]>`select * from document_approvals where id = ${approvalId} for update`;
        if (!approval) return { error: new AuthError("NOT_FOUND", "Schválení nebylo nalezeno.", 404) } as const;
        if (approval.decision) {
          if (approval.decision !== decision) return { error: new AuthError(
            "APPROVAL_ALREADY_DECIDED", "Schválení již bylo rozhodnuto jinak.", 409,
          ) } as const;
          await appendAudit(tx, { actor, action: "document.approval_replayed", targetType: "document",
            targetId: approval.document_id, correlationId, metadata: { decision } }, "allowed");
          return { document: (await findDocumentAdminView(tx, approval.document_id))! } as const;
        }
        if (approval.requested_by_user_id === actor.userId) {
          return denied(tx, actor, "document.approval_denied", approval.document_id, correlationId,
            new AuthError("FOUR_EYES_REQUIRED", "Žadatel nemůže schválit vlastní požadavek.", 403));
        }
        const row = await findDocumentRow(tx, approval.document_id);
        if (!row) throw new Error("Approval document is missing");
        if (decision === "approved" && row.row_version !== approval.requested_row_version) {
          return denied(tx, actor, "document.approval_denied", row.id, correlationId,
            new AuthError("VERSION_CONFLICT", "Dokument byl mezitím změněn.", 409));
        }
        if (decision === "approved" && !canTransition(row.status, approval.requested_status)) {
          return denied(tx, actor, "document.approval_denied", row.id, correlationId,
            new AuthError("INVALID_TRANSITION", "Tento stavový přechod není povolen.", 409));
        }
        await tx`
          update document_approvals set decision = ${decision}, reason = ${reason.trim() || null},
            decided_by_user_id = ${actor.userId}, decided_at = now()
          where id = ${approvalId}
        `;
        if (decision === "approved") {
          await tx`
            update documents set status = ${approval.requested_status},
              comments_open = ${approval.requested_status === "published_open"},
              row_version = row_version + 1, updated_at = now()
            where id = ${row.id} and row_version = ${approval.requested_row_version}
          `;
          await tx`
            insert into document_state_transitions (
              document_id, actor_user_id, from_status, to_status, reason
            ) values (
              ${row.id}, ${actor.userId}, ${row.status}, ${approval.requested_status},
              ${reason.trim() || null}
            )
          `;
        }
        await appendAudit(tx, { actor, action: "document.approval_decided", targetType: "document",
          targetId: row.id, correlationId, metadata: { decision } }, "allowed");
        return { document: (await findDocumentAdminView(tx, row.id))! } as const;
      });
      if ("error" in result) throw result.error;
      return result.document;
    },
  };
}

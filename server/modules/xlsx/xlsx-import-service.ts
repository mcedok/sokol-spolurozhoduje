import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Actor, XlsxImportBatch } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { findDocumentRow } from "../documents/document-repository";
import { AuthError } from "../identity/auth-errors";
import { appendOutbox } from "../outbox/outbox-writer";
import { uuidV7 } from "../shared/uuid-v7";
import { stageAndValidateXlsx, type StagedXlsx, type XlsxUploadInput } from "../files/xlsx-envelope-validator";
import type { FileConfig } from "../files/file-config";
import type { ObjectStorage } from "../files/object-storage";
import type { StoredObject } from "../files/object-storage";
import { xlsxEditableRowSchema, type XlsxEditableRow } from "../../../contracts";
import { xlsxConflictDecisionSchema, type XlsxConflictDecision } from "../../../contracts";
import { classifyXlsxRow } from "./xlsx-three-way-merge";

interface ImportBatchRow {
  id: string;
  document_id: string;
  export_job_id: string;
  status: XlsxImportBatch["status"];
  file_sha256: string;
  row_count: number;
  counts: XlsxImportBatch["counts"];
  row_version: number;
  created_at: Date;
  completed_at: Date | null;
  command_hash?: string;
}

function adaptBatch(row: ImportBatchRow): XlsxImportBatch {
  return {
    id: row.id,
    documentId: row.document_id,
    exportJobId: row.export_job_id,
    status: row.status,
    fileSha256: row.file_sha256,
    rowCount: row.row_count,
    counts: row.counts,
    rowVersion: row.row_version,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export interface XlsxImportCommand extends XlsxUploadInput {
  exportJobId: string;
  idempotencyKey: string;
}

export function createXlsxImportService({ sql }: { sql: Sql }) {
  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]));
    }
    return value;
  }

  function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
  }

  function failureCode(error: unknown): string {
    return error instanceof AuthError ? error.code : "INTERNAL_ERROR";
  }

  function changedFields(before: XlsxEditableRow, after: XlsxEditableRow): string[] {
    return Object.keys(before).filter((key) =>
      JSON.stringify(canonicalize(before[key as keyof XlsxEditableRow]))
        !== JSON.stringify(canonicalize(after[key as keyof XlsxEditableRow])),
    );
  }

  async function validateIncomingSettlement(
    tx: Sql,
    actor: Actor,
    documentId: string,
    incoming: XlsxEditableRow,
  ): Promise<void> {
    const settlementFields = [incoming.outcome, incoming.statement, incoming.targetVersionNumber,
      incoming.responsibleUserId, incoming.declaredSettlementDate];
    if (incoming.status !== "settled") {
      if (settlementFields.some((value) => value !== null)) {
        throw new AuthError("INVALID_IMPORT_ROW", "Nevypořádaný řádek nesmí obsahovat údaje vypořádání.", 422);
      }
      return;
    }
    if (!incoming.outcome || !incoming.statement || !incoming.responsibleUserId
      || !incoming.declaredSettlementDate) {
      throw new AuthError("INVALID_IMPORT_ROW", "Vypořádaná připomínka musí mít výsledek, stanovisko, odpovědnou osobu a datum.", 422);
    }
    if (incoming.declaredSettlementDate > new Date().toISOString().slice(0, 10)) {
      throw new AuthError("INVALID_IMPORT_ROW", "Datum vypořádání nesmí být v budoucnosti.", 422);
    }
    const [document] = await tx<{ owner_admin_id: string }[]>`
      select owner_admin_id from documents where id=${documentId}
    `;
    const allowed = actor.role === "superadmin"
      ? incoming.responsibleUserId === actor.userId || incoming.responsibleUserId === document?.owner_admin_id
      : incoming.responsibleUserId === actor.userId;
    if (!allowed) {
      throw new AuthError("INVALID_RESPONSIBLE_ADMIN", "Odpovědnou osobou smí být administrátor dokumentu nebo superadministrátor.", 422);
    }
  }

  async function requireBatchAccess(actor: Actor | null, batchId: string, correlationId: string) {
    if (!actor || (actor.role !== "admin" && actor.role !== "superadmin")) {
      await appendDeniedAudit(sql, {
        actor, action: "xlsx_import.read_denied", targetType: "xlsx_import_batch", targetId: batchId, correlationId,
      });
      if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
      throw new AuthError("FORBIDDEN", "Import XLSX smí číst jen administrátor.", 403);
    }
    const [row] = await sql<{ document_id: string; owner_admin_id: string }[]>`
      select batch.document_id, document.owner_admin_id
      from xlsx_import_batches batch join documents document on document.id=batch.document_id
      where batch.id=${batchId}
    `;
    if (!row) throw new AuthError("NOT_FOUND", "Importní dávka nebyla nalezena.", 404);
    if (actor.role !== "superadmin" && row.owner_admin_id !== actor.userId) {
      await appendDeniedAudit(sql, {
        actor, action: "xlsx_import.read_denied", targetType: "xlsx_import_batch", targetId: batchId,
        correlationId, metadata: { reason: "FORBIDDEN" },
      });
      throw new AuthError("FORBIDDEN", "Administrátor může číst jen importy vlastních dokumentů.", 403);
    }
    return { actor, documentId: row.document_id };
  }

  async function reauthorizeApply(
    tx: Sql,
    actor: Actor,
    documentId: string,
    requireFreshSession = true,
  ): Promise<void> {
    const [authorization] = await tx<{
      role: Actor["role"]; user_status: string; owner_admin_id: string; document_status: string;
    }[]>`
      select user_account.role::text role, user_account.status::text user_status,
        document.owner_admin_id, document.status::text document_status
      from users user_account cross join documents document
      where user_account.id=${actor.userId} and document.id=${documentId}
      for update of user_account, document
    `;
    const [session] = requireFreshSession
      ? await tx<{ allowed: boolean }[]>`
          select exists(
            select 1 from sessions where id=${actor.sessionId} and user_id=${actor.userId}
              and revoked_at is null and expires_at > now()
              and created_at >= now() - interval '15 minutes'
          ) allowed
        `
      : [{ allowed: true }];
    const allowedStates = new Set(["ready", "published_open", "comments_closed", "settlement", "settled"]);
    if (!authorization || authorization.user_status !== "active"
      || authorization.role !== actor.role
      || (actor.role !== "superadmin" && authorization.owner_admin_id !== actor.userId)
      || !allowedStates.has(authorization.document_status)) {
      throw new AuthError("FORBIDDEN", "Oprávnění k aplikaci XLSX již není platné.", 403);
    }
    if (!session.allowed) {
      throw new AuthError("FRESH_AUTHENTICATION_REQUIRED", "Aplikace XLSX vyžaduje nové přihlášení.", 403);
    }
  }

  return {
    async assertSourceDocument(documentId: string, documentVersionId: string): Promise<void> {
      const [row] = await sql<{ document_id: string }[]>`
        select document_id from document_versions
        where id = ${documentVersionId} and document_id = ${documentId}
      `;
      if (!row) throw new AuthError("IMPORT_SOURCE_MISMATCH", "Importní sešit nepatří vybranému dokumentu.", 409);
    },

    async accept(
      actor: Actor | null,
      documentId: string,
      command: XlsxImportCommand,
      storage: ObjectStorage,
      config: FileConfig,
      correlationId = crypto.randomUUID(),
    ): Promise<XlsxImportBatch> {
      if (!actor || (actor.role !== "admin" && actor.role !== "superadmin")) {
        await appendDeniedAudit(sql, {
          actor,
          action: "xlsx_import.create_denied",
          targetType: "document",
          targetId: documentId,
          correlationId,
        });
        if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
        throw new AuthError("FORBIDDEN", "Import XLSX smí provést jen administrátor.", 403);
      }
      const document = await findDocumentRow(sql, documentId);
      if (!document) throw new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);
      if (actor.role !== "superadmin" && document.owner_admin_id !== actor.userId) {
        await appendDeniedAudit(sql, {
          actor,
          action: "xlsx_import.create_denied",
          targetType: "document",
          targetId: documentId,
          correlationId,
          metadata: { reason: "FORBIDDEN" },
        });
        throw new AuthError("FORBIDDEN", "Administrátor může importovat jen vlastní dokument.", 403);
      }
      const [fresh] = await sql<{ allowed: boolean }[]>`
        select exists(
          select 1 from sessions where id=${actor.sessionId} and user_id=${actor.userId}
            and revoked_at is null and expires_at > now()
            and created_at >= now() - interval '15 minutes'
        ) as allowed
      `;
      if (!fresh.allowed) {
        await appendDeniedAudit(sql, {
          actor, action: "xlsx_import.create_denied", targetType: "document", targetId: documentId,
          correlationId, metadata: { reason: "FRESH_AUTHENTICATION_REQUIRED" },
        });
        throw new AuthError("FRESH_AUTHENTICATION_REQUIRED", "Import XLSX vyžaduje nové přihlášení.", 403);
      }

      const [exportJob] = await sql<{
        id: string; document_id: string; status: string; output_file_id: string | null;
      }[]>`
        select id, document_id, status, output_file_id
        from xlsx_export_jobs where id=${command.exportJobId}
      `;
      if (!exportJob || exportJob.document_id !== documentId) {
        throw new AuthError("IMPORT_SOURCE_MISMATCH", "Importní sešit nepatří vybranému dokumentu.", 409);
      }
      if (exportJob.status !== "completed" || !exportJob.output_file_id) {
        throw new AuthError("EXPORT_NOT_READY", "Zdrojový XLSX export není dokončený.", 409);
      }

      let staged: StagedXlsx | undefined;
      let stored: StoredObject | undefined;
      const batchId = uuidV7();
      const fileId = uuidV7();
      const objectKey = `${documentId}/xlsx-imports/${batchId}/${fileId}.xlsx`;
      try {
        staged = await stageAndValidateXlsx(command, config);
        stored = await storage.putQuarantine({
          objectKey,
          body: createReadStream(staged.path),
          contentType: command.contentType,
        });
        if (stored.sha256 !== staged.sha256 || stored.sizeBytes !== staged.sizeBytes) {
          throw new AuthError("UPLOAD_INTEGRITY_FAILED", "Kontrola uloženého XLSX selhala.", 409);
        }
        const fingerprint = digest({ operation: "createXlsxImport", documentId,
          exportJobId: command.exportJobId, actorUserId: actor.userId, fileSha256: staged.sha256 });
        const result = await withTransaction(sql, async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${command.idempotencyKey}))`;
          const [replay] = await tx<ImportBatchRow[]>`
            select id, document_id, export_job_id, status, file_sha256, row_count, counts,
              row_version, created_at, completed_at, command_hash
            from xlsx_import_batches where idempotency_key=${command.idempotencyKey}
          `;
          if (replay) {
            if (replay.command_hash !== fingerprint) throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
            return { value: adaptBatch(replay), replay: true } as const;
          }
          await tx`
            insert into file_objects (
              id, document_id, data_owner_user_id, purpose, container, object_key,
              original_name, declared_mime, detected_mime, size_bytes, sha256, etag
            ) values (
              ${fileId}, ${documentId}, ${actor.userId}, 'xlsx_import', 'quarantine', ${objectKey},
              ${staged!.fileName}, ${command.contentType}, ${command.contentType},
              ${staged!.sizeBytes}, ${staged!.sha256}, ${stored!.etag ?? null}
            )
          `;
          const [row] = await tx<ImportBatchRow[]>`
            insert into xlsx_import_batches (
              id, document_id, export_job_id, input_file_id, status, file_sha256,
              uploaded_by_user_id, actor_session_id, idempotency_key, command_hash
            ) values (
              ${batchId}, ${documentId}, ${command.exportJobId}, ${fileId}, 'uploaded',
              ${staged!.sha256}, ${actor.userId}, ${actor.sessionId}, ${command.idempotencyKey}, ${fingerprint}
            )
            returning id, document_id, export_job_id, status, file_sha256, row_count,
              counts, row_version, created_at, completed_at
          `;
          await appendOutbox(tx, {
            eventType: "xlsx.import.requested",
            aggregateType: "xlsx_import_batch",
            aggregateId: batchId,
            idempotencyKey: command.idempotencyKey,
            payload: { exportJobId: command.exportJobId, sha256: staged!.sha256 },
          });
          await appendAudit(tx, {
            actor,
            action: "xlsx_import.created",
            targetType: "xlsx_import_batch",
            targetId: batchId,
            correlationId,
            metadata: { documentId, exportJobId: command.exportJobId, sha256: staged!.sha256 },
          }, "allowed");
          return { value: adaptBatch(row), replay: false } as const;
        });
        if (result.replay) await storage.delete("quarantine", objectKey, stored.etag);
        return result.value;
      } catch (error) {
        if (stored) await storage.delete("quarantine", objectKey, stored.etag).catch(() => undefined);
        await appendDeniedAudit(sql, {
          actor,
          action: "xlsx_import.upload_rejected",
          targetType: "document",
          targetId: documentId,
          correlationId,
          metadata: { failureKind: failureCode(error) },
        }).catch(() => undefined);
        throw error;
      } finally {
        await staged?.cleanup();
      }
    },

    async getBatch(actor: Actor | null, batchId: string, correlationId = crypto.randomUUID()): Promise<XlsxImportBatch> {
      await requireBatchAccess(actor, batchId, correlationId);
      const [row] = await sql<ImportBatchRow[]>`
        select id, document_id, export_job_id, status, file_sha256, row_count, counts,
          row_version, created_at, completed_at
        from xlsx_import_batches where id=${batchId}
      `;
      if (!row) throw new AuthError("NOT_FOUND", "Importní dávka nebyla nalezena.", 404);
      return adaptBatch(row);
    },

    async listRows(actor: Actor | null, batchId: string, input: { classification?: string; limit?: number; offset?: number }, correlationId = crypto.randomUUID()) {
      await requireBatchAccess(actor, batchId, correlationId);
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
      const offset = Math.max(input.offset ?? 0, 0);
      const rows = await sql<{
        id: string; source_row_number: number; classification: string; base_values: unknown;
        current_values: unknown; incoming_values: unknown; validation_errors: unknown; row_version: number;
        latest_decision: XlsxConflictDecision | null;
      }[]>`
        select id, source_row_number, classification, base_values, current_values,
          incoming_values, validation_errors, row_version, decision.decision latest_decision
        from xlsx_import_rows row
        left join lateral (
          select saved.decision from xlsx_import_decisions saved
          where saved.import_row_id=row.id order by saved.created_at desc, saved.id desc limit 1
        ) decision on true
        where row.batch_id=${batchId}
          and (${input.classification ?? null}::text is null or row.classification=${input.classification ?? null})
        order by source_row_number
        limit ${limit} offset ${offset}
      `;
      const [summary] = await sql<{ total: number; undecided_total: number }[]>`
        select count(*)::int total,
          count(*) filter (where latest.decision is null)::int undecided_total
        from xlsx_import_rows row
        left join lateral (
          select saved.decision from xlsx_import_decisions saved
          where saved.import_row_id=row.id order by saved.created_at desc, saved.id desc limit 1
        ) latest on true
        where row.batch_id=${batchId}
          and (${input.classification ?? null}::text is null or row.classification=${input.classification ?? null})
      `;
      return { rows: rows.map((row) => ({
        id: row.id,
        sourceRowNumber: row.source_row_number,
        classification: row.classification,
        base: row.base_values,
        current: row.current_values,
        incoming: row.incoming_values,
        validationErrors: row.validation_errors,
        rowVersion: row.row_version,
        latestDecision: row.latest_decision,
      })), total: summary.total, undecidedTotal: summary.undecided_total };
    },

    /** Applies only rows which were classified safe_change and have not changed since comparison. */
    async applySafeRows(
      actor: Actor | null,
      batchId: string,
      input: { expectedBatchRowVersion: number; idempotencyKey: string },
      correlationId = crypto.randomUUID(),
      options: { trustedWorkerCallback?: boolean } = {},
    ) {
      const access = await requireBatchAccess(actor, batchId, correlationId);
      if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
      const fingerprint = digest({ operation: "applySafeRows", batchId,
        expectedBatchRowVersion: input.expectedBatchRowVersion });
      try {
        return await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const [replay] = await tx<{
          command_hash: string; applied_count: number; skipped_count: number; batch_status: XlsxImportBatch["status"];
        }[]>`
          select run.command_hash, run.applied_count, run.skipped_count, batch.status batch_status
          from xlsx_apply_runs run join xlsx_import_batches batch on batch.id=run.batch_id
          where run.idempotency_key=${input.idempotencyKey}
        `;
        if (replay) {
          if (replay.command_hash !== fingerprint) throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
          return { applied: replay.applied_count, skipped: replay.skipped_count, status: replay.batch_status };
        }
        const [batch] = await tx<{ document_id: string; row_version: number; status: XlsxImportBatch["status"] }[]>`
          select document_id, row_version, status from xlsx_import_batches where id=${batchId} for update
        `;
        if (!batch) throw new AuthError("NOT_FOUND", "Importní dávka nebyla nalezena.", 404);
        await reauthorizeApply(tx, actor, batch.document_id, !options.trustedWorkerCallback);
        if (batch.row_version !== input.expectedBatchRowVersion) {
          throw new AuthError("VERSION_CONFLICT", "Importní dávka byla mezitím změněna.", 409);
        }
        if (batch.status !== "comparing") {
          throw new AuthError("IMPORT_NOT_APPLICABLE", "Importní dávka není připravena k bezpečnému použití.", 409);
        }
        const classifications = await tx<{
          comment_id: string; classification: string; base_values: XlsxEditableRow;
          current_values: XlsxEditableRow; incoming_values: XlsxEditableRow;
        }[]>`
          select comment_id, classification, base_values, current_values, incoming_values
          from xlsx_import_rows where batch_id=${batchId} order by source_row_number
        `;
        for (const staged of classifications) {
          await appendAudit(tx, {
            actor, action: "xlsx_import.row_classified", targetType: "comment",
            targetId: staged.comment_id, correlationId,
            metadata: {
              batchId, documentId: batch.document_id, classification: staged.classification,
              changedFields: changedFields(staged.current_values, staged.incoming_values),
              baseHash: digest(staged.base_values), currentHash: digest(staged.current_values),
              incomingHash: digest(staged.incoming_values),
            },
          }, "allowed");
        }
        const [run] = await tx<{ id: string }[]>`
          insert into xlsx_apply_runs (id, batch_id, phase, status, expected_batch_row_version,
            actor_user_id, correlation_id, idempotency_key, command_hash)
          values (${uuidV7()}, ${batchId}, 'safe_changes', 'processing', ${batch.row_version},
            ${actor.userId}, ${correlationId}, ${input.idempotencyKey}, ${fingerprint})
          returning id
        `;
        const rows = await tx<{
          id: string; comment_id: string; source_row_number: number; base_values: XlsxEditableRow;
          current_values: XlsxEditableRow; incoming_values: XlsxEditableRow; row_version: number;
          current_comment_row_version: number; current_settlement_row_version: number | null;
        }[]>`
          select id, comment_id, source_row_number, base_values, current_values, incoming_values, row_version,
            current_comment_row_version, current_settlement_row_version
          from xlsx_import_rows where batch_id=${batchId} and classification='safe_change'
          order by source_row_number for update
        `;
        let applied = 0;
        let skipped = 0;
        for (const row of rows) {
          const [current] = await tx<{
            comment_type: XlsxEditableRow["type"];
            priority: XlsxEditableRow["priority"];
            status: XlsxEditableRow["status"];
            row_version: number;
          }[]>`
            select c.comment_type, c.priority, c.status, c.row_version
            from comments c where c.id=${row.comment_id} for update of c
          `;
          if (!current) throw new AuthError("STALE_IMPORT_ROW", "Připomínka již neexistuje.", 409);
          const [activeSettlement] = await tx<any[]>`
            select s.*, dv.version_number
            from settlements s left join document_versions dv on dv.id=s.target_document_version_id
            where s.comment_id=${row.comment_id} and s.voided_at is null for update of s
          `;
          const currentEditable = {
            type: current.comment_type, priority: current.priority, status: current.status,
            outcome: activeSettlement?.outcome ?? null,
            statement: activeSettlement?.statement ?? null,
            targetVersionNumber: activeSettlement?.version_number ?? null,
            responsibleUserId: activeSettlement?.responsible_user_id ?? null,
            declaredSettlementDate: activeSettlement?.declared_settlement_date instanceof Date
              ? activeSettlement.declared_settlement_date.toISOString().slice(0, 10)
              : activeSettlement?.declared_settlement_date ?? null,
          } satisfies XlsxEditableRow;
          if (current.row_version !== row.current_comment_row_version
            || (activeSettlement?.row_version ?? null) !== row.current_settlement_row_version) {
            throw new AuthError("STALE_IMPORT_ROW", "Verze připomínky se po porovnání změnila; dávka nebyla použita.", 409);
          }
          if (classifyXlsxRow(row.base_values, currentEditable, row.incoming_values) !== "safe_change") {
            throw new AuthError("STALE_IMPORT_ROW", "Připomínka se po porovnání změnila; dávka nebyla použita.", 409);
          }
          const incoming = xlsxEditableRowSchema.parse(row.incoming_values);
          await validateIncomingSettlement(tx, actor, batch.document_id, incoming);
          const domainRevisionIds: string[] = [];
          if (current.comment_type !== incoming.type || current.priority !== incoming.priority) {
            const attributeRevisionId = uuidV7();
            await tx`
              insert into comment_attribute_revisions (
                id, comment_id, previous_type, previous_priority, edited_by_user_id, reason
              ) values (
                ${attributeRevisionId}, ${row.comment_id}, ${current.comment_type}, ${current.priority},
                ${actor.userId}, 'Import pracovní XLSX'
              )
            `;
            domainRevisionIds.push(attributeRevisionId);
          }
          const updatedComments = await tx`
            update comments set comment_type=${incoming.type}, priority=${incoming.priority}, status=${incoming.status},
              row_version=row_version+1, updated_at=now()
            where id=${row.comment_id} and row_version=${row.current_comment_row_version}
            returning id
          `;
          if (updatedComments.length !== 1) throw new AuthError("STALE_IMPORT_ROW", "Verze připomínky se změnila během aplikace.", 409);
          if (current.status !== incoming.status) {
            const statusRevisionId = uuidV7();
            await tx`
              insert into comment_status_transitions (id, comment_id, from_status, to_status, actor_user_id, reason)
              values (${statusRevisionId}, ${row.comment_id}, ${current.status}, ${incoming.status}, ${actor.userId}, 'Import pracovní XLSX')
            `;
            domainRevisionIds.push(statusRevisionId);
          }
          if (incoming.status === "settled") {
            if (!incoming.outcome || !incoming.statement || !incoming.responsibleUserId) {
              throw new AuthError("INVALID_IMPORT_ROW", "Vypořádaná připomínka musí mít výsledek, stanovisko a odpovědnou osobu.", 422);
            }
            const [target] = incoming.targetVersionNumber === null ? [null] : await tx<{ id: string }[]>`
              select id from document_versions where document_id=${batch.document_id} and version_number=${incoming.targetVersionNumber}
            `;
            if (incoming.targetVersionNumber !== null && !target) throw new AuthError("INVALID_IMPORT_ROW", "Cílová verze dokumentu neexistuje.", 422);
            if (activeSettlement) {
              const settlementRevisionId = uuidV7();
              await tx`
                insert into settlement_revisions (
                  id, settlement_id, previous_outcome, previous_statement, previous_internal_note,
                  edited_by_user_id, reason, previous_responsible_user_id, previous_target_document_version_id, previous_declared_settlement_date
                ) values (
                  ${settlementRevisionId}, ${activeSettlement.id}, ${activeSettlement.outcome}, ${activeSettlement.statement}, ${activeSettlement.internal_note},
                  ${actor.userId}, 'Import pracovní XLSX', ${activeSettlement.responsible_user_id}, ${activeSettlement.target_document_version_id}, ${activeSettlement.declared_settlement_date}
                )
              `;
              domainRevisionIds.push(settlementRevisionId);
              const updatedSettlements = await tx`
                update settlements set outcome=${incoming.outcome}, statement=${incoming.statement}, responsible_user_id=${incoming.responsibleUserId},
                  settled_by_user_id=${actor.userId}, target_document_version_id=${target?.id ?? null}, declared_settlement_date=${incoming.declaredSettlementDate},
                  row_version=row_version+1, updated_at=now()
                where id=${activeSettlement.id} and row_version=${row.current_settlement_row_version}
                returning id
              `;
              if (updatedSettlements.length !== 1) throw new AuthError("STALE_IMPORT_ROW", "Verze vypořádání se změnila během aplikace.", 409);
            } else {
              const settlementId = uuidV7();
              await tx`
                insert into settlements (id, comment_id, outcome, statement, responsible_user_id, settled_by_user_id, target_document_version_id, declared_settlement_date)
                values (${settlementId}, ${row.comment_id}, ${incoming.outcome}, ${incoming.statement}, ${incoming.responsibleUserId}, ${actor.userId}, ${target?.id ?? null}, ${incoming.declaredSettlementDate})
              `;
              domainRevisionIds.push(settlementId);
            }
          } else if (activeSettlement) {
            const settlementRevisionId = uuidV7();
            await tx`
              insert into settlement_revisions (
                id, settlement_id, previous_outcome, previous_statement, previous_internal_note,
                edited_by_user_id, reason, previous_responsible_user_id,
                previous_target_document_version_id, previous_declared_settlement_date
              ) values (
                ${settlementRevisionId}, ${activeSettlement.id}, ${activeSettlement.outcome}, ${activeSettlement.statement},
                ${activeSettlement.internal_note}, ${actor.userId}, 'Import pracovní XLSX',
                ${activeSettlement.responsible_user_id}, ${activeSettlement.target_document_version_id},
                ${activeSettlement.declared_settlement_date}
              )
            `;
            domainRevisionIds.push(settlementRevisionId);
            await tx`
              update settlements set voided_at=now(), voided_by_user_id=${actor.userId}, void_reason='Import pracovní XLSX', updated_at=now()
              where id=${activeSettlement.id}
            `;
          }
          await tx`
            insert into xlsx_row_applications (id, apply_run_id, import_row_id, result, before_sha256, after_sha256, domain_revision_ids)
            values (${uuidV7()}, ${run.id}, ${row.id}, 'applied', ${digest(currentEditable)}, ${digest(incoming)}, ${tx.json(domainRevisionIds)})
          `;
          await appendAudit(tx, {
            actor, action: "xlsx_import.row_applied", targetType: "comment", targetId: row.comment_id,
            correlationId, metadata: {
              batchId, documentId: batch.document_id,
              changedFields: changedFields(currentEditable, incoming),
              beforeHash: digest(currentEditable), afterHash: digest(incoming), domainRevisionIds,
            },
          }, "allowed");
          applied++;
        }
        const [remaining] = await tx<{ count: number }[]>`
          select count(*)::int as count from xlsx_import_rows
          where batch_id=${batchId} and classification in ('conflict','invalid','structural_error')
        `;
        const finalStatus = remaining.count > 0 ? "awaiting_resolution" : "completed";
        await tx`
          update xlsx_apply_runs set status='completed', applied_count=${applied}, skipped_count=${skipped}, completed_at=now() where id=${run.id}
        `;
        await tx`
          update xlsx_import_batches set status=${finalStatus}, row_version=row_version+1,
            completed_at=case when ${finalStatus}='completed' then now() else null end, updated_at=now()
          where id=${batchId} and row_version=${batch.row_version}
        `;
        await appendOutbox(tx, { eventType: "xlsx.import.applied", aggregateType: "xlsx_import_batch", aggregateId: batchId,
          idempotencyKey: crypto.randomUUID(), payload: { applied, skipped, expectedBatchRowVersion: batch.row_version } });
        await appendAudit(tx, { actor, action: "xlsx_import.safe_rows_applied", targetType: "xlsx_import_batch", targetId: batchId,
          correlationId, metadata: { documentId: access.documentId, applied, skipped } }, "allowed");
        return { applied, skipped, status: finalStatus };
        });
      } catch (error) {
        await appendDeniedAudit(sql, {
          actor, action: "xlsx_import.safe_apply_failed", targetType: "xlsx_import_batch",
          targetId: batchId, correlationId,
          metadata: { documentId: access.documentId, failureKind: failureCode(error) },
        });
        throw error;
      }
    },

    async decideConflict(actor: Actor | null, batchId: string, rowId: string, input: {
      decision: XlsxConflictDecision;
      expectedRowVersion: number;
      idempotencyKey: string;
      reason?: string;
    }, correlationId = crypto.randomUUID()) {
      const access = await requireBatchAccess(actor, batchId, correlationId);
      if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
      const parsed = xlsxConflictDecisionSchema.parse(input.decision);
      const fingerprint = digest({ operation: "decideConflict", batchId, rowId,
        decision: parsed, expectedRowVersion: input.expectedRowVersion,
        reason: input.reason?.trim() || null });
      return withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const [replay] = await tx<{ decision: XlsxConflictDecision; command_hash: string; classification: string; result_row_version: number }[]>`
          select decision.decision, decision.command_hash, row.classification,
            decision.expected_row_version + 1 result_row_version
          from xlsx_import_decisions decision join xlsx_import_rows row on row.id=decision.import_row_id
          where decision.idempotency_key=${input.idempotencyKey}
        `;
        if (replay) {
          if (replay.command_hash !== fingerprint) throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
          return { rowId, decision: replay.decision, classification: replay.classification,
            rowVersion: replay.result_row_version };
        }
        const [batch] = await tx<{ status: XlsxImportBatch["status"] }[]>`
          select status from xlsx_import_batches where id=${batchId} for update
        `;
        if (!batch) throw new AuthError("NOT_FOUND", "Importní dávka nebyla nalezena.", 404);
        await reauthorizeApply(tx, actor, access.documentId);
        if (batch.status !== "awaiting_resolution") {
          throw new AuthError("IMPORT_NOT_APPLICABLE", "Konflikty lze rozhodovat až po dokončení bezpečné fáze.", 409);
        }
        const [row] = await tx<{ id: string; classification: string; row_version: number }[]>`
          select id, classification, row_version from xlsx_import_rows
          where id=${rowId} and batch_id=${batchId} for update
        `;
        if (!row) throw new AuthError("NOT_FOUND", "Importní řádek nebyl nalezen.", 404);
        if (row.classification !== "conflict") throw new AuthError("CONFLICT_NOT_PENDING", "Řádek již není v konfliktu.", 409);
        if (row.row_version !== input.expectedRowVersion) throw new AuthError("STALE_IMPORT_ROW", "Řádek byl mezitím změněn.", 409);
        await tx`
          insert into xlsx_import_decisions (id, import_row_id, decision, decided_by_user_id,
            expected_row_version, reason, idempotency_key, command_hash)
          values (${uuidV7()}, ${rowId}, ${parsed}, ${actor.userId}, ${input.expectedRowVersion},
            ${input.reason?.trim() || null}, ${input.idempotencyKey}, ${fingerprint})
        `;
        const [updated] = await tx<{ row_version: number }[]>`
          update xlsx_import_rows set row_version=row_version+1, updated_at=now()
          where id=${rowId} and row_version=${input.expectedRowVersion}
          returning row_version
        `;
        if (!updated) throw new AuthError("STALE_IMPORT_ROW", "Řádek byl mezitím změněn.", 409);
        await appendAudit(tx, { actor, action: "xlsx_import.conflict_decided", targetType: "xlsx_import_row", targetId: rowId,
          correlationId, metadata: { batchId, documentId: access.documentId, decision: parsed } }, "allowed");
        return { rowId, decision: parsed, classification: row.classification,
          rowVersion: updated.row_version };
      });
    },

    async applyConflictDecisions(
      actor: Actor | null,
      batchId: string,
      input: { expectedBatchRowVersion: number; idempotencyKey: string },
      correlationId = crypto.randomUUID(),
    ) {
      const access = await requireBatchAccess(actor, batchId, correlationId);
      if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
      const fingerprint = digest({ operation: "applyConflictDecisions", batchId,
        expectedBatchRowVersion: input.expectedBatchRowVersion });
      try {
        return await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const [replay] = await tx<{
          command_hash: string; applied_count: number; skipped_count: number; batch_status: XlsxImportBatch["status"];
        }[]>`
          select run.command_hash, run.applied_count, run.skipped_count, batch.status batch_status
          from xlsx_apply_runs run join xlsx_import_batches batch on batch.id=run.batch_id
          where run.idempotency_key=${input.idempotencyKey}
        `;
        if (replay) {
          if (replay.command_hash !== fingerprint) throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
          return { applied: replay.applied_count, skipped: replay.skipped_count, status: replay.batch_status };
        }
        const [batch] = await tx<{ document_id: string; row_version: number; status: XlsxImportBatch["status"] }[]>`
          select document_id, row_version, status from xlsx_import_batches where id=${batchId} for update
        `;
        if (!batch) throw new AuthError("NOT_FOUND", "Importní dávka nebyla nalezena.", 404);
        await reauthorizeApply(tx, actor, batch.document_id);
        if (batch.row_version !== input.expectedBatchRowVersion) {
          throw new AuthError("VERSION_CONFLICT", "Importní dávka byla mezitím změněna.", 409);
        }
        if (batch.status !== "awaiting_resolution") {
          throw new AuthError("IMPORT_NOT_APPLICABLE", "Importní dávka není připravena k řešení konfliktů.", 409);
        }
        const rows = await tx<{
          id: string; comment_id: string; source_row_number: number;
          current_values: XlsxEditableRow; incoming_values: XlsxEditableRow;
          decision: XlsxConflictDecision | null; current_comment_row_version: number;
          current_settlement_row_version: number | null;
        }[]>`
          select row.id, row.comment_id, row.source_row_number, row.current_values,
            row.incoming_values, decision.decision, row.current_comment_row_version,
            row.current_settlement_row_version
          from xlsx_import_rows row
          left join lateral (
            select d.decision from xlsx_import_decisions d
            where d.import_row_id=row.id order by d.created_at desc, d.id desc limit 1
          ) decision on true
          where row.batch_id=${batchId} and row.classification='conflict'
          order by row.source_row_number for update of row
        `;
        if (rows.some((row) => row.decision === null)) {
          throw new AuthError("CONFLICT_DECISIONS_REQUIRED", "Nejprve rozhodněte všechny konfliktní řádky.", 409);
        }
        const [run] = await tx<{ id: string }[]>`
          insert into xlsx_apply_runs (id, batch_id, phase, status, expected_batch_row_version,
            actor_user_id, correlation_id, idempotency_key, command_hash)
          values (${uuidV7()}, ${batchId}, 'conflict_resolutions', 'processing', ${batch.row_version},
            ${actor.userId}, ${correlationId}, ${input.idempotencyKey}, ${fingerprint})
          returning id
        `;
        let applied = 0;
        let skipped = 0;
        for (const row of rows) {
          const [current] = await tx<{
            comment_type: XlsxEditableRow["type"];
            priority: XlsxEditableRow["priority"];
            status: XlsxEditableRow["status"];
            row_version: number;
          }[]>`
            select c.comment_type, c.priority, c.status, c.row_version from comments c
            where c.id=${row.comment_id} for update of c
          `;
          if (!current) throw new AuthError("STALE_IMPORT_ROW", "Připomínka již neexistuje.", 409);
          const [activeSettlement] = await tx<any[]>`
            select s.*, dv.version_number
            from settlements s left join document_versions dv on dv.id=s.target_document_version_id
            where s.comment_id=${row.comment_id} and s.voided_at is null for update of s
          `;
          const currentEditable = {
            type: current.comment_type,
            priority: current.priority,
            status: current.status,
            outcome: activeSettlement?.outcome ?? null,
            statement: activeSettlement?.statement ?? null,
            targetVersionNumber: activeSettlement?.version_number ?? null,
            responsibleUserId: activeSettlement?.responsible_user_id ?? null,
            declaredSettlementDate: activeSettlement?.declared_settlement_date instanceof Date
              ? activeSettlement.declared_settlement_date.toISOString().slice(0, 10)
              : activeSettlement?.declared_settlement_date ?? null,
          } satisfies XlsxEditableRow;
          if (current.row_version !== row.current_comment_row_version
            || (activeSettlement?.row_version ?? null) !== row.current_settlement_row_version) {
            throw new AuthError("STALE_IMPORT_ROW", "Verze konfliktní připomínky se po porovnání změnila; dávka nebyla použita.", 409);
          }
          if (digest(currentEditable) !== digest(xlsxEditableRowSchema.parse(row.current_values))) {
            throw new AuthError("STALE_IMPORT_ROW", "Konfliktní připomínka se po porovnání změnila; dávka nebyla použita.", 409);
          }
          if (row.decision === "keep_system") {
            await tx`
              insert into xlsx_row_applications (id, apply_run_id, import_row_id, result, before_sha256, after_sha256, domain_revision_ids)
              values (${uuidV7()}, ${run.id}, ${row.id}, 'kept_system', ${digest(currentEditable)},
                ${digest(currentEditable)}, '[]'::jsonb)
            `;
            await appendAudit(tx, {
              actor, action: "xlsx_import.row_kept_system", targetType: "comment", targetId: row.comment_id,
              correlationId, metadata: {
                batchId, documentId: batch.document_id, beforeHash: digest(currentEditable),
                afterHash: digest(currentEditable), changedFields: [],
              },
            }, "allowed");
            skipped++;
            continue;
          }
          const incoming = xlsxEditableRowSchema.parse(row.incoming_values);
          await validateIncomingSettlement(tx, actor, batch.document_id, incoming);
          const domainRevisionIds: string[] = [];
          if (current.comment_type !== incoming.type || current.priority !== incoming.priority) {
            const attributeRevisionId = uuidV7();
            await tx`
              insert into comment_attribute_revisions (
                id, comment_id, previous_type, previous_priority, edited_by_user_id, reason
              ) values (
                ${attributeRevisionId}, ${row.comment_id}, ${current.comment_type}, ${current.priority},
                ${actor.userId}, 'Import pracovní XLSX – rozhodnutí konfliktu'
              )
            `;
            domainRevisionIds.push(attributeRevisionId);
          }
          const updatedComments = await tx`
            update comments set comment_type=${incoming.type}, priority=${incoming.priority}, status=${incoming.status},
              row_version=row_version+1, updated_at=now()
            where id=${row.comment_id} and row_version=${row.current_comment_row_version}
            returning id
          `;
          if (updatedComments.length !== 1) throw new AuthError("STALE_IMPORT_ROW", "Verze konfliktní připomínky se změnila během aplikace.", 409);
          if (current.status !== incoming.status) {
            const statusRevisionId = uuidV7();
            await tx`
              insert into comment_status_transitions (id, comment_id, from_status, to_status, actor_user_id, reason)
              values (${statusRevisionId}, ${row.comment_id}, ${current.status}, ${incoming.status}, ${actor.userId}, 'Import pracovní XLSX – rozhodnutí konfliktu')
            `;
            domainRevisionIds.push(statusRevisionId);
          }
          if (incoming.status === "settled") {
            const [target] = incoming.targetVersionNumber === null ? [null] : await tx<{ id: string }[]>`
              select id from document_versions where document_id=${batch.document_id} and version_number=${incoming.targetVersionNumber}
            `;
            if (incoming.targetVersionNumber !== null && !target) {
              throw new AuthError("INVALID_IMPORT_ROW", "Cílová verze dokumentu neexistuje.", 422);
            }
            if (activeSettlement) {
              const settlementRevisionId = uuidV7();
              await tx`
                insert into settlement_revisions (id, settlement_id, previous_outcome, previous_statement,
                  previous_internal_note, edited_by_user_id, reason, previous_responsible_user_id,
                  previous_target_document_version_id, previous_declared_settlement_date)
                values (${settlementRevisionId}, ${activeSettlement.id}, ${activeSettlement.outcome}, ${activeSettlement.statement},
                  ${activeSettlement.internal_note}, ${actor.userId}, 'Import pracovní XLSX – rozhodnutí konfliktu',
                  ${activeSettlement.responsible_user_id}, ${activeSettlement.target_document_version_id},
                  ${activeSettlement.declared_settlement_date})
              `;
              domainRevisionIds.push(settlementRevisionId);
              const updatedSettlements = await tx`
                update settlements set outcome=${incoming.outcome}, statement=${incoming.statement},
                  responsible_user_id=${incoming.responsibleUserId}, settled_by_user_id=${actor.userId},
                  target_document_version_id=${target?.id ?? null}, declared_settlement_date=${incoming.declaredSettlementDate},
                  row_version=row_version+1, updated_at=now()
                where id=${activeSettlement.id} and row_version=${row.current_settlement_row_version}
                returning id
              `;
              if (updatedSettlements.length !== 1) throw new AuthError("STALE_IMPORT_ROW", "Verze konfliktního vypořádání se změnila během aplikace.", 409);
            } else {
              const settlementId = uuidV7();
              await tx`
                insert into settlements (id, comment_id, outcome, statement, responsible_user_id,
                  settled_by_user_id, target_document_version_id, declared_settlement_date)
                values (${settlementId}, ${row.comment_id}, ${incoming.outcome}, ${incoming.statement},
                  ${incoming.responsibleUserId}, ${actor.userId}, ${target?.id ?? null}, ${incoming.declaredSettlementDate})
              `;
              domainRevisionIds.push(settlementId);
            }
          } else if (activeSettlement) {
            const settlementRevisionId = uuidV7();
            await tx`
              insert into settlement_revisions (id, settlement_id, previous_outcome, previous_statement,
                previous_internal_note, edited_by_user_id, reason, previous_responsible_user_id,
                previous_target_document_version_id, previous_declared_settlement_date)
              values (${settlementRevisionId}, ${activeSettlement.id}, ${activeSettlement.outcome}, ${activeSettlement.statement},
                ${activeSettlement.internal_note}, ${actor.userId}, 'Import pracovní XLSX – rozhodnutí konfliktu',
                ${activeSettlement.responsible_user_id}, ${activeSettlement.target_document_version_id},
                ${activeSettlement.declared_settlement_date})
            `;
            domainRevisionIds.push(settlementRevisionId);
            await tx`
              update settlements set voided_at=now(), voided_by_user_id=${actor.userId},
                void_reason='Import pracovní XLSX – rozhodnutí konfliktu', updated_at=now()
              where id=${activeSettlement.id}
            `;
          }
          await tx`
            insert into xlsx_row_applications (id, apply_run_id, import_row_id, result,
              before_sha256, after_sha256, domain_revision_ids)
            values (${uuidV7()}, ${run.id}, ${row.id}, 'applied', ${digest(currentEditable)},
              ${digest(incoming)}, ${tx.json(domainRevisionIds)})
          `;
          await appendAudit(tx, {
            actor, action: "xlsx_import.row_applied", targetType: "comment", targetId: row.comment_id,
            correlationId, metadata: {
              batchId, documentId: batch.document_id,
              changedFields: changedFields(currentEditable, incoming),
              beforeHash: digest(currentEditable), afterHash: digest(incoming), domainRevisionIds,
            },
          }, "allowed");
          applied++;
        }
        const [unresolved] = await tx<{ count: number }[]>`
          select count(*)::int as count from xlsx_import_rows row
          where row.batch_id=${batchId} and (
            row.classification in ('invalid','structural_error')
            or (
              row.classification in ('safe_change','conflict')
              and not exists (
                select 1 from xlsx_row_applications application
                where application.import_row_id=row.id
              )
            )
          )
        `;
        const status = unresolved.count > 0 ? "awaiting_resolution" : "completed";
        await tx`
          update xlsx_apply_runs set status='completed', applied_count=${applied}, skipped_count=${skipped},
            completed_at=now() where id=${run.id}
        `;
        await tx`
          update xlsx_import_batches set status=${status}, row_version=row_version+1,
            completed_at=case when ${status}='completed' then now() else null end, updated_at=now()
          where id=${batchId} and row_version=${batch.row_version}
        `;
        await appendOutbox(tx, {
          eventType: "xlsx.import.conflicts_applied", aggregateType: "xlsx_import_batch",
          aggregateId: batchId, idempotencyKey: crypto.randomUUID(),
          payload: { applied, skipped },
        });
        await appendAudit(tx, {
          actor, action: "xlsx_import.conflicts_applied", targetType: "xlsx_import_batch",
          targetId: batchId, correlationId,
          metadata: { documentId: access.documentId, applied, skipped },
        }, "allowed");
        return { applied, skipped, status };
        });
      } catch (error) {
        await appendDeniedAudit(sql, {
          actor, action: "xlsx_import.conflict_apply_failed", targetType: "xlsx_import_batch",
          targetId: batchId, correlationId,
          metadata: { documentId: access.documentId, failureKind: failureCode(error) },
        });
        throw error;
      }
    },

    async cancel(actor: Actor | null, batchId: string, input: {
      expectedBatchRowVersion: number;
      idempotencyKey: string;
    }, correlationId = crypto.randomUUID()) {
      const access = await requireBatchAccess(actor, batchId, correlationId);
      if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
      const fingerprint = digest({ operation: "cancelXlsxImport", batchId,
        expectedBatchRowVersion: input.expectedBatchRowVersion });
      await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const [replay] = await tx<{ command_hash: string | null }[]>`
          select payload->>'commandHash' command_hash from outbox_events
          where idempotency_key=${input.idempotencyKey} and event_type='xlsx.import.cancelled'
        `;
        if (replay) {
          if (replay.command_hash !== fingerprint) throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
          return;
        }
        const [batch] = await tx<{ status: XlsxImportBatch["status"]; row_version: number }[]>`
          select status, row_version from xlsx_import_batches where id=${batchId} for update
        `;
        if (!batch) throw new AuthError("NOT_FOUND", "Importní dávka nebyla nalezena.", 404);
        if (batch.row_version !== input.expectedBatchRowVersion) {
          throw new AuthError("VERSION_CONFLICT", "Importní dávka byla mezitím změněna.", 409);
        }
        if (batch.status !== "awaiting_resolution") {
          throw new AuthError("IMPORT_NOT_CANCELLABLE", "Zrušit lze pouze dávku čekající na rozhodnutí.", 409);
        }
        const [row] = await tx<{ status: XlsxImportBatch["status"] }[]>`
          update xlsx_import_batches set status='cancelled', completed_at=coalesce(completed_at, now()), row_version=row_version+1, updated_at=now()
          where id=${batchId} and row_version=${input.expectedBatchRowVersion}
            and status='awaiting_resolution' returning status
        `;
        if (!row) return;
        await appendOutbox(tx, { eventType: "xlsx.import.cancelled", aggregateType: "xlsx_import_batch", aggregateId: batchId,
          idempotencyKey: input.idempotencyKey,
          payload: { documentId: access.documentId, commandHash: fingerprint } });
        await appendAudit(tx, { actor, action: "xlsx_import.cancelled", targetType: "xlsx_import_batch", targetId: batchId,
          correlationId, metadata: { documentId: access.documentId } }, "allowed");
      });
    },

    async retry(actor: Actor | null, batchId: string, input: {
      expectedBatchRowVersion: number;
      idempotencyKey: string;
    }, correlationId = crypto.randomUUID()): Promise<XlsxImportBatch> {
      const access = await requireBatchAccess(actor, batchId, correlationId);
      if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
      const fingerprint = digest({ operation: "retryXlsxImport", batchId,
        expectedBatchRowVersion: input.expectedBatchRowVersion });
      return withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const [replay] = await tx<{ command_hash: string | null }[]>`
          select payload->>'commandHash' command_hash from outbox_events
          where idempotency_key=${input.idempotencyKey} and event_type='xlsx.import.retry_requested'
        `;
        if (replay && replay.command_hash !== fingerprint) {
          throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
        }
        const [batch] = await tx<ImportBatchRow[]>`
          select id, document_id, export_job_id, status, file_sha256, row_count, counts,
            row_version, created_at, completed_at
          from xlsx_import_batches where id=${batchId} for update
        `;
        if (!batch) throw new AuthError("NOT_FOUND", "Importní dávka nebyla nalezena.", 404);
        if (replay) return adaptBatch(batch);
        if (batch.row_version !== input.expectedBatchRowVersion) {
          throw new AuthError("VERSION_CONFLICT", "Importní dávka byla mezitím změněna.", 409);
        }
        if (batch.status !== "failed") {
          throw new AuthError("IMPORT_NOT_RETRYABLE", "Opakovat lze pouze selhanou importní dávku.", 409);
        }
        await reauthorizeApply(tx, actor, access.documentId);
        const [hasAppliedRows] = await tx<{ exists: boolean }[]>`
          select exists(
            select 1 from xlsx_row_applications application
            join xlsx_apply_runs run on run.id=application.apply_run_id
            where run.batch_id=${batchId}
          ) exists
        `;
        if (hasAppliedRows.exists) {
          throw new AuthError("IMPORT_NOT_RETRYABLE", "Dávku s již aplikovanými řádky nelze bezpečně opakovat.", 409);
        }
        await tx`delete from xlsx_import_rows where batch_id=${batchId}`;
        const [updated] = await tx<ImportBatchRow[]>`
          update xlsx_import_batches set status='uploaded', actor_session_id=${actor.sessionId},
            row_count=0, counts='{"unchanged":0,"safeChange":0,"alreadyCurrent":0,"conflict":0,"invalid":0}'::jsonb,
            manifest_sha256=null, signing_key_id=null, error_code=null, error_detail=null,
            started_at=null, completed_at=null, lease_expires_at=null, lease_token=null,
            safe_apply_correlation_id=null, safe_apply_idempotency_key=null,
            safe_apply_lease_token=null, safe_apply_next_attempt_at=null,
            safe_apply_attempt_count=0,
            attempt_count=0,
            row_version=row_version+1, updated_at=now()
          where id=${batchId} and status='failed' and row_version=${input.expectedBatchRowVersion}
          returning id, document_id, export_job_id, status, file_sha256, row_count, counts,
            row_version, created_at, completed_at
        `;
        if (!updated) throw new AuthError("VERSION_CONFLICT", "Importní dávka byla mezitím změněna.", 409);
        await appendOutbox(tx, {
          eventType: "xlsx.import.retry_requested", aggregateType: "xlsx_import_batch",
          aggregateId: batchId, idempotencyKey: input.idempotencyKey,
          payload: { documentId: access.documentId, commandHash: fingerprint },
        });
        await appendAudit(tx, {
          actor, action: "xlsx_import.retry_requested", targetType: "xlsx_import_batch",
          targetId: batchId, correlationId, metadata: { documentId: access.documentId },
        }, "allowed");
        return adaptBatch(updated);
      });
    },
  };
}

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
  function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
      if (!fresh.allowed) throw new AuthError("FRESH_AUTHENTICATION_REQUIRED", "Import XLSX vyžaduje nové přihlášení.", 403);

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
        const result = await withTransaction(sql, async (tx) => {
          const [replay] = await tx<ImportBatchRow[]>`
            select id, document_id, export_job_id, status, file_sha256, row_count, counts,
              row_version, created_at, completed_at
            from xlsx_import_batches where idempotency_key=${command.idempotencyKey}
          `;
          if (replay) {
            if (replay.file_sha256 !== staged!.sha256) throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
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
              uploaded_by_user_id, idempotency_key
            ) values (
              ${batchId}, ${documentId}, ${command.exportJobId}, ${fileId}, 'uploaded',
              ${staged!.sha256}, ${actor.userId}, ${command.idempotencyKey}
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
      }[]>`
        select id, source_row_number, classification, base_values, current_values,
          incoming_values, validation_errors, row_version
        from xlsx_import_rows
        where batch_id=${batchId}
          and (${input.classification ?? null}::text is null or classification=${input.classification ?? null})
        order by source_row_number
        limit ${limit} offset ${offset}
      `;
      return rows.map((row) => ({
        id: row.id,
        sourceRowNumber: row.source_row_number,
        classification: row.classification,
        base: row.base_values,
        current: row.current_values,
        incoming: row.incoming_values,
        validationErrors: row.validation_errors,
        rowVersion: row.row_version,
      }));
    },

    /** Applies only rows which were classified safe_change and have not changed since comparison. */
    async applySafeRows(actor: Actor | null, batchId: string, correlationId = crypto.randomUUID()) {
      const access = await requireBatchAccess(actor, batchId, correlationId);
      if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
      return withTransaction(sql, async (tx) => {
        const [batch] = await tx<{ document_id: string; row_version: number; status: XlsxImportBatch["status"] }[]>`
          select document_id, row_version, status from xlsx_import_batches where id=${batchId} for update
        `;
        if (!batch) throw new AuthError("NOT_FOUND", "Importní dávka nebyla nalezena.", 404);
        if (batch.status !== "awaiting_resolution" && batch.status !== "comparing") {
          throw new AuthError("IMPORT_NOT_APPLICABLE", "Importní dávka není připravena k bezpečnému použití.", 409);
        }
        const [run] = await tx<{ id: string }[]>`
          insert into xlsx_apply_runs (id, batch_id, phase, status, expected_batch_row_version, actor_user_id, correlation_id)
          values (${uuidV7()}, ${batchId}, 'safe_changes', 'processing', ${batch.row_version}, ${actor.userId}, ${correlationId})
          returning id
        `;
        const rows = await tx<{
          id: string; comment_id: string; source_row_number: number; base_values: XlsxEditableRow;
          current_values: XlsxEditableRow; incoming_values: XlsxEditableRow; row_version: number;
        }[]>`
          select id, comment_id, source_row_number, base_values, current_values, incoming_values, row_version
          from xlsx_import_rows where batch_id=${batchId} and classification='safe_change'
          order by source_row_number for update
        `;
        let applied = 0;
        let skipped = 0;
        for (const row of rows) {
          const [current] = await tx<{ comment_type: XlsxEditableRow["type"]; priority: XlsxEditableRow["priority"]; status: XlsxEditableRow["status"]; settlement: XlsxEditableRow["outcome"] extends never ? never : unknown }[]>`
            select c.comment_type, c.priority, c.status,
              jsonb_build_object('outcome', s.outcome, 'statement', s.statement,
                'targetVersionNumber', dv.version_number, 'responsibleUserId', s.responsible_user_id,
                'declaredSettlementDate', s.declared_settlement_date) as settlement
            from comments c left join settlements s on s.comment_id=c.id and s.voided_at is null
              left join document_versions dv on dv.id=s.target_document_version_id
            where c.id=${row.comment_id} for update
          `;
          if (!current) { skipped++; continue; }
          const currentEditable = {
            type: current.comment_type, priority: current.priority, status: current.status,
            outcome: (current as any).settlement?.outcome ?? null,
            statement: (current as any).settlement?.statement ?? null,
            targetVersionNumber: (current as any).settlement?.targetVersionNumber ?? null,
            responsibleUserId: (current as any).settlement?.responsibleUserId ?? null,
            declaredSettlementDate: (current as any).settlement?.declaredSettlementDate ?? null,
          } satisfies XlsxEditableRow;
          if (classifyXlsxRow(row.base_values, currentEditable, row.incoming_values) !== "safe_change") {
            skipped++; continue;
          }
          const incoming = xlsxEditableRowSchema.parse(row.incoming_values);
          const [comment] = await tx<{ status: XlsxEditableRow["status"] }[]>`
            update comments set comment_type=${incoming.type}, priority=${incoming.priority}, status=${incoming.status},
              row_version=row_version+1, updated_at=now() where id=${row.comment_id} returning status
          `;
          if (current.status !== incoming.status) {
            await tx`
              insert into comment_status_transitions (id, comment_id, from_status, to_status, actor_user_id, reason)
              values (${uuidV7()}, ${row.comment_id}, ${current.status}, ${incoming.status}, ${actor.userId}, 'Import pracovní XLSX')
            `;
          }
          const [activeSettlement] = await tx<any[]>`
            select s.* from settlements s where s.comment_id=${row.comment_id} and s.voided_at is null for update
          `;
          if (incoming.status === "settled") {
            if (!incoming.outcome || !incoming.statement || !incoming.responsibleUserId) {
              throw new AuthError("INVALID_IMPORT_ROW", "Vypořádaná připomínka musí mít výsledek, stanovisko a odpovědnou osobu.", 422);
            }
            const [target] = incoming.targetVersionNumber === null ? [null] : await tx<{ id: string }[]>`
              select id from document_versions where document_id=${batch.document_id} and version_number=${incoming.targetVersionNumber}
            `;
            if (incoming.targetVersionNumber !== null && !target) throw new AuthError("INVALID_IMPORT_ROW", "Cílová verze dokumentu neexistuje.", 422);
            if (activeSettlement) {
              await tx`
                insert into settlement_revisions (
                  id, settlement_id, previous_outcome, previous_statement, previous_internal_note,
                  edited_by_user_id, reason, previous_responsible_user_id, previous_target_document_version_id, previous_declared_settlement_date
                ) values (
                  ${uuidV7()}, ${activeSettlement.id}, ${activeSettlement.outcome}, ${activeSettlement.statement}, ${activeSettlement.internal_note},
                  ${actor.userId}, 'Import pracovní XLSX', ${activeSettlement.responsible_user_id}, ${activeSettlement.target_document_version_id}, ${activeSettlement.declared_settlement_date}
                )
              `;
              await tx`
                update settlements set outcome=${incoming.outcome}, statement=${incoming.statement}, responsible_user_id=${incoming.responsibleUserId},
                  settled_by_user_id=${actor.userId}, target_document_version_id=${target?.id ?? null}, declared_settlement_date=${incoming.declaredSettlementDate},
                  row_version=row_version+1, updated_at=now() where id=${activeSettlement.id}
              `;
            } else {
              await tx`
                insert into settlements (id, comment_id, outcome, statement, responsible_user_id, settled_by_user_id, target_document_version_id, declared_settlement_date)
                values (${uuidV7()}, ${row.comment_id}, ${incoming.outcome}, ${incoming.statement}, ${incoming.responsibleUserId}, ${actor.userId}, ${target?.id ?? null}, ${incoming.declaredSettlementDate})
              `;
            }
          } else if (activeSettlement) {
            await tx`
              update settlements set voided_at=now(), voided_by_user_id=${actor.userId}, void_reason='Import pracovní XLSX', updated_at=now()
              where id=${activeSettlement.id}
            `;
          }
          await tx`
            insert into xlsx_row_applications (id, apply_run_id, import_row_id, result, before_sha256, after_sha256, domain_revision_ids)
            values (${uuidV7()}, ${run.id}, ${row.id}, 'applied', ${digest(currentEditable)}, ${digest(incoming)}, '[]'::jsonb)
          `;
          applied++;
        }
        const finalStatus = skipped > 0 ? "awaiting_resolution" : "completed";
        await tx`
          update xlsx_apply_runs set status='completed', applied_count=${applied}, skipped_count=${skipped}, completed_at=now() where id=${run.id}
        `;
        await tx`
          update xlsx_import_batches set status=${finalStatus}, row_version=row_version+1,
            completed_at=case when ${finalStatus}='completed' then now() else null end, updated_at=now()
          where id=${batchId} and row_version=${batch.row_version}
        `;
        await appendOutbox(tx, { eventType: "xlsx.import.applied", aggregateType: "xlsx_import_batch", aggregateId: batchId,
          idempotencyKey: `${batchId}:${batch.row_version}:safe`, payload: { applied, skipped } });
        await appendAudit(tx, { actor, action: "xlsx_import.safe_rows_applied", targetType: "xlsx_import_batch", targetId: batchId,
          correlationId, metadata: { documentId: access.documentId, applied, skipped } }, "allowed");
        return { applied, skipped, status: finalStatus };
      });
    },

    async decideConflict(actor: Actor | null, batchId: string, rowId: string, decision: XlsxConflictDecision,
      expectedRowVersion: number, reason?: string, correlationId = crypto.randomUUID()) {
      const access = await requireBatchAccess(actor, batchId, correlationId);
      if (!actor) throw new AuthError("UNAUTHENTICATED", "Přihlášení je vyžadováno.", 401);
      const parsed = xlsxConflictDecisionSchema.parse(decision);
      return withTransaction(sql, async (tx) => {
        const [row] = await tx<{ id: string; classification: string; row_version: number }[]>`
          select id, classification, row_version from xlsx_import_rows
          where id=${rowId} and batch_id=${batchId} for update
        `;
        if (!row) throw new AuthError("NOT_FOUND", "Importní řádek nebyl nalezen.", 404);
        if (row.classification !== "conflict") throw new AuthError("CONFLICT_NOT_PENDING", "Řádek již není v konfliktu.", 409);
        if (row.row_version !== expectedRowVersion) throw new AuthError("STALE_IMPORT_ROW", "Řádek byl mezitím změněn.", 409);
        await tx`
          insert into xlsx_import_decisions (id, import_row_id, decision, decided_by_user_id, expected_row_version, reason)
          values (${uuidV7()}, ${rowId}, ${parsed}, ${actor.userId}, ${expectedRowVersion}, ${reason?.trim() || null})
        `;
        const nextClassification = parsed === "keep_system" ? "already_current" : "safe_change";
        await tx`
          update xlsx_import_rows set classification=${nextClassification}, row_version=row_version+1, updated_at=now()
          where id=${rowId} and row_version=${expectedRowVersion}
        `;
        await appendAudit(tx, { actor, action: "xlsx_import.conflict_decided", targetType: "xlsx_import_row", targetId: rowId,
          correlationId, metadata: { batchId, documentId: access.documentId, decision: parsed } }, "allowed");
        return { rowId, decision: parsed, classification: nextClassification };
      });
    },
  };
}

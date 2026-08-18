import { createReadStream } from "node:fs";
import type { Sql } from "postgres";
import type { Actor } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { findDocumentRow } from "../documents/document-repository";
import { AuthError, unauthenticated } from "../identity/auth-errors";
import { appendOutbox } from "../outbox/outbox-writer";
import { uuidV7 } from "../shared/uuid-v7";
import { stageAndValidateDocx, type DocxUploadInput } from "./docx-envelope-validator";
import type { FileConfig } from "./file-config";
import { findUploadByIdempotencyKey } from "./file-repository";
import type { ObjectStorage } from "./object-storage";

export interface UploadCommand extends DocxUploadInput {
  rowVersion: number;
  idempotencyKey: string;
}

export interface AcceptedUpload {
  versionId: string;
  jobId: string;
  fileId: string;
  status: "file_check";
}

export function createUploadService({
  sql,
  storage,
  config,
}: {
  sql: Sql;
  storage: ObjectStorage;
  config: FileConfig;
}) {
  async function requireOwner(actor: Actor | null, documentId: string, correlationId: string) {
    if (!actor) {
      await appendDeniedAudit(sql, {
        actor, action: "document.upload_denied", targetType: "document", targetId: documentId, correlationId,
      });
      throw unauthenticated();
    }
    if (actor.role !== "admin" && actor.role !== "superadmin") {
      await appendDeniedAudit(sql, {
        actor, action: "document.upload_denied", targetType: "document", targetId: documentId, correlationId,
      });
      throw new AuthError("FORBIDDEN", "K dokumentu nemáte oprávnění.", 403);
    }
    const document = await findDocumentRow(sql, documentId);
    if (!document) throw new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);
    if (actor.role !== "superadmin" && document.owner_admin_id !== actor.userId) {
      await appendDeniedAudit(sql, {
        actor, action: "document.upload_denied", targetType: "document", targetId: documentId, correlationId,
      });
      throw new AuthError("FORBIDDEN", "Administrátor může spravovat jen vlastní dokumenty.", 403);
    }
    return { actor, document };
  }

  return {
    async accept(
      actorInput: Actor | null,
      documentId: string,
      command: UploadCommand,
      correlationId = crypto.randomUUID(),
    ): Promise<AcceptedUpload> {
      const { actor } = await requireOwner(actorInput, documentId, correlationId);
      let staged;
      try {
        staged = await stageAndValidateDocx(command, config);
      } catch (error) {
        await appendDeniedAudit(sql, {
          actor,
          action: "document.upload_rejected",
          targetType: "document",
          targetId: documentId,
          correlationId,
          metadata: { reason: error instanceof AuthError ? error.code : "INVALID_DOCX" },
        });
        throw error;
      }

      const versionId = uuidV7();
      const jobId = uuidV7();
      const fileId = uuidV7();
      const objectKey = `${documentId}/${versionId}/${fileId}.docx`;
      let stored = false;
      try {
        const uploaded = await storage.putQuarantine({
          objectKey,
          body: createReadStream(staged.path),
          contentType: command.contentType,
        });
        stored = true;
        if (uploaded.sha256 !== staged.sha256 || uploaded.sizeBytes !== staged.sizeBytes) {
          throw new AuthError("UPLOAD_INTEGRITY_FAILED", "Kontrola uloženého souboru selhala.", 409);
        }

        const result = await withTransaction(sql, async (tx): Promise<AcceptedUpload> => {
          const existing = await findUploadByIdempotencyKey(tx, command.idempotencyKey);
          if (existing) {
            if (existing.sha256 !== staged.sha256) {
              throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
            }
            return {
              versionId: existing.versionId,
              jobId: existing.jobId,
              fileId: existing.fileId,
              status: existing.status,
            };
          }

          const rows = await tx<{ owner_admin_id: string; row_version: number }[]>`
            select owner_admin_id, row_version from documents where id = ${documentId} for update
          `;
          const document = rows[0];
          if (!document) throw new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);
          if (actor.role !== "superadmin" && document.owner_admin_id !== actor.userId) {
            throw new AuthError("FORBIDDEN", "Administrátor může spravovat jen vlastní dokumenty.", 403);
          }
          if (document.row_version !== command.rowVersion) {
            throw new AuthError("VERSION_CONFLICT", "Dokument byl mezitím změněn.", 409);
          }
          const [{ version_number: versionNumber }] = await tx<{ version_number: number }[]>`
            select coalesce(max(version_number), 0)::int + 1 as version_number
            from document_versions where document_id = ${documentId}
          `;
          await tx`
            insert into file_objects (
              id, document_id, data_owner_user_id, purpose, container, object_key,
              original_name, declared_mime, detected_mime, size_bytes, sha256, etag
            ) values (
              ${fileId}, ${documentId}, ${actor.userId}, 'original_docx', 'quarantine', ${objectKey},
              ${staged.fileName}, ${command.contentType}, ${command.contentType},
              ${staged.sizeBytes}, ${staged.sha256}, ${uploaded.etag ?? null}
            )
          `;
          await tx`
            insert into document_versions (
              id, document_id, version_number, status, original_file_id,
              conversion_profile, created_by_user_id
            ) values (
              ${versionId}, ${documentId}, ${versionNumber}, 'file_check', ${fileId},
              'docx-web-v1', ${actor.userId}
            )
          `;
          await tx`
            insert into conversion_jobs (
              id, document_version_id, status, current_step, profile_version,
              input_sha256, idempotency_key, correlation_id
            ) values (
              ${jobId}, ${versionId}, 'queued', 'file_check', 'docx-web-v1',
              ${staged.sha256}, ${command.idempotencyKey}, ${correlationId}
            )
          `;
          await tx`
            update document_versions set current_conversion_job_id = ${jobId} where id = ${versionId}
          `;
          await tx`
            update documents set status = 'file_check', row_version = row_version + 1, updated_at = now()
            where id = ${documentId}
          `;
          const accepted = { versionId, jobId, fileId, status: "file_check" as const };
          await appendOutbox(tx, {
            eventType: "document.conversion_queued",
            aggregateType: "document_version",
            aggregateId: versionId,
            idempotencyKey: command.idempotencyKey,
            payload: { jobId, fileId, sha256: staged.sha256, status: accepted.status },
          });
          await appendAudit(tx, {
            actor,
            action: "document.uploaded",
            targetType: "document_version",
            targetId: versionId,
            correlationId,
            metadata: { documentId, sizeBytes: staged.sizeBytes },
          }, "allowed");
          return accepted;
        });

        if (result.versionId !== versionId) {
          await storage.delete("quarantine", objectKey, uploaded.etag);
          stored = false;
        }
        return result;
      } catch (error) {
        if (stored) await storage.delete("quarantine", objectKey).catch(() => undefined);
        throw error;
      } finally {
        await staged.cleanup();
      }
    },
  };
}

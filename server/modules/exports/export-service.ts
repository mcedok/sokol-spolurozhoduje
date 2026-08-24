import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type {
  Actor,
  PdfExportFilters,
  PdfExportInternalOptions,
  PdfExportJob,
} from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { AuthError, unauthenticated } from "../identity/auth-errors";
import { appendOutbox } from "../outbox/outbox-writer";
import { uuidV7 } from "../shared/uuid-v7";
import {
  findExportByIdempotencyKey,
  findExportForAccess,
  insertPdfExportJob,
  loadPdfExportSource,
} from "./export-repository";
import { buildPdfExportSnapshot, snapshotChecksum } from "./export-snapshot";

function commandHash(input: object): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createExportService({ sql }: { sql: Sql }) {
  return {
    async getDownloadFileId(
      actor: Actor | null,
      exportJobId: string,
      correlationId = crypto.randomUUID(),
    ): Promise<string> {
      if (!actor || (actor.role !== "admin" && actor.role !== "superadmin")) {
        await appendDeniedAudit(sql, {
          actor,
          action: "pdf_export.download_denied",
          targetType: "export_job",
          targetId: exportJobId,
          correlationId,
        });
        if (!actor) throw unauthenticated();
        throw new AuthError("FORBIDDEN", "PDF export je dostupný pouze administrátorům.", 403);
      }
      const loaded = await findExportForAccess(sql, exportJobId);
      if (!loaded) throw new AuthError("NOT_FOUND", "PDF export nebyl nalezen.", 404);
      if (actor.role !== "superadmin" && loaded.ownerAdminId !== actor.userId) {
        await appendDeniedAudit(sql, {
          actor,
          action: "pdf_export.download_denied",
          targetType: "export_job",
          targetId: exportJobId,
          correlationId,
          metadata: { reason: "FORBIDDEN" },
        });
        throw new AuthError("FORBIDDEN", "Administrátor může stahovat jen vlastní exporty.", 403);
      }
      if (loaded.job.visibility === "internal") {
        const [fresh] = await sql<{ allowed: boolean }[]>`
          select exists(
            select 1 from sessions where id=${actor.sessionId} and user_id=${actor.userId}
              and revoked_at is null and expires_at > now()
              and created_at >= now() - interval '15 minutes'
          ) as allowed
        `;
        if (!fresh.allowed) {
          await appendDeniedAudit(sql, {
            actor,
            action: "pdf_export.download_denied",
            targetType: "export_job",
            targetId: exportJobId,
            correlationId,
            metadata: { reason: "FRESH_AUTHENTICATION_REQUIRED" },
          });
          throw new AuthError(
            "FRESH_AUTHENTICATION_REQUIRED",
            "Stažení interního exportu vyžaduje nové přihlášení.",
            403,
          );
        }
      }
      if (loaded.job.status !== "completed" || !loaded.job.outputFileId) {
        throw new AuthError("EXPORT_NOT_READY", "PDF export zatím není připraven ke stažení.", 409);
      }
      return loaded.job.outputFileId;
    },
    async getExport(
      actor: Actor | null,
      exportJobId: string,
      correlationId = crypto.randomUUID(),
    ): Promise<PdfExportJob> {
      if (!actor || (actor.role !== "admin" && actor.role !== "superadmin")) {
        await appendDeniedAudit(sql, {
          actor,
          action: "pdf_export.read_denied",
          targetType: "export_job",
          targetId: exportJobId,
          correlationId,
        });
        if (!actor) throw unauthenticated();
        throw new AuthError("FORBIDDEN", "PDF export je dostupný pouze administrátorům.", 403);
      }
      const loaded = await findExportForAccess(sql, exportJobId);
      if (!loaded) throw new AuthError("NOT_FOUND", "PDF export nebyl nalezen.", 404);
      if (actor.role !== "superadmin" && loaded.ownerAdminId !== actor.userId) {
        await appendDeniedAudit(sql, {
          actor,
          action: "pdf_export.read_denied",
          targetType: "export_job",
          targetId: exportJobId,
          correlationId,
          metadata: { reason: "FORBIDDEN" },
        });
        throw new AuthError("FORBIDDEN", "Administrátor může číst jen exporty vlastních dokumentů.", 403);
      }
      return loaded.job;
    },
    async createExport(
      actor: Actor | null,
      documentId: string,
      input: {
        documentVersionId: string;
        visibility: "public" | "internal";
        filters?: Partial<PdfExportFilters>;
        options?: Partial<PdfExportInternalOptions>;
        idempotencyKey: string;
      },
      correlationId = crypto.randomUUID(),
    ): Promise<PdfExportJob> {
      if (!actor) {
        await appendDeniedAudit(sql, {
          actor,
          action: "pdf_export.create_denied",
          targetType: "document",
          targetId: documentId,
          correlationId,
        });
        throw unauthenticated();
      }
      if (actor.role !== "admin" && actor.role !== "superadmin") {
        await appendDeniedAudit(sql, {
          actor,
          action: "pdf_export.create_denied",
          targetType: "document",
          targetId: documentId,
          correlationId,
        });
        throw new AuthError("FORBIDDEN", "PDF export smí vytvořit jen administrátor.", 403);
      }
      const filters: PdfExportFilters = {
        statuses: input.filters?.statuses ?? [],
        priorities: input.filters?.priorities ?? [],
        types: input.filters?.types ?? [],
      };
      const options: PdfExportInternalOptions = {
        includeAuthorEmail: input.options?.includeAuthorEmail ?? false,
        includeMembershipId: input.options?.includeMembershipId ?? false,
        includeInternalNote: input.options?.includeInternalNote ?? false,
      };
      const fingerprint = commandHash({
        operation: "createPdfExport",
        documentId,
        documentVersionId: input.documentVersionId,
        visibility: input.visibility,
        filters,
        options,
      });
      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const replay = await findExportByIdempotencyKey(tx, input.idempotencyKey);
        if (replay) {
          if (replay.commandHash !== fingerprint) return {
            error: new AuthError(
              "IDEMPOTENCY_CONFLICT",
              "Identifikátor požadavku již byl použit pro jiný export.",
              409,
            ),
          } as const;
          const { commandHash: _commandHash, ...job } = replay;
          return { value: job } as const;
        }
        const loaded = await loadPdfExportSource(tx, documentId, input.documentVersionId);
        if (!loaded) return {
          error: new AuthError(
            "DOCUMENT_VERSION_NOT_READY",
            "Dokument nebo připravená verze nebyla nalezena.",
            409,
          ),
        } as const;
        if (actor.role !== "superadmin" && loaded.ownerAdminId !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "pdf_export.create_denied",
            targetType: "document",
            targetId: documentId,
            correlationId,
            metadata: { reason: "FORBIDDEN" },
          }, "denied");
          return { error: new AuthError(
            "FORBIDDEN",
            "Administrátor může exportovat jen vlastní dokument.",
            403,
          ) } as const;
        }
        if (input.visibility === "internal") {
          const [fresh] = await tx<{ allowed: boolean }[]>`
            select exists(
              select 1 from sessions
              where id = ${actor.sessionId} and user_id = ${actor.userId}
                and revoked_at is null and expires_at > now()
                and created_at >= now() - interval '15 minutes'
            ) as allowed
          `;
          if (!fresh.allowed) {
            await appendAudit(tx, {
              actor,
              action: "pdf_export.create_denied",
              targetType: "document",
              targetId: documentId,
              correlationId,
              metadata: { reason: "FRESH_AUTHENTICATION_REQUIRED" },
            }, "denied");
            return { error: new AuthError(
              "FRESH_AUTHENTICATION_REQUIRED",
              "Interní export vyžaduje nové přihlášení.",
              403,
            ) } as const;
          }
        }
        const snapshot = buildPdfExportSnapshot({
          visibility: input.visibility,
          generatedAt: new Date().toISOString(),
          filters,
          options,
          source: loaded.source,
        });
        const checksum = snapshotChecksum(snapshot);
        const jobId = uuidV7();
        const job = await insertPdfExportJob(tx, {
          id: jobId,
          documentId,
          documentVersionId: input.documentVersionId,
          visibility: input.visibility,
          filters,
          options: snapshot.options,
          snapshot,
          snapshotSha256: checksum,
          requestedByUserId: actor.userId,
          idempotencyKey: input.idempotencyKey,
          commandHash: fingerprint,
        });
        await appendOutbox(tx, {
          eventType: "pdf.export.requested",
          aggregateType: "export_job",
          aggregateId: jobId,
          idempotencyKey: input.idempotencyKey,
          payload: { snapshotSha256: checksum, visibility: input.visibility },
        });
        await appendAudit(tx, {
          actor,
          action: "pdf_export.created",
          targetType: "export_job",
          targetId: jobId,
          correlationId,
          metadata: { documentId, visibility: input.visibility, snapshotSha256: checksum },
        }, "allowed");
        return { value: job } as const;
      });
      if ("error" in result) throw result.error;
      return result.value;
    },
  };
}

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Actor, XlsxExportJob } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { AuthError, unauthenticated } from "../identity/auth-errors";
import { appendOutbox } from "../outbox/outbox-writer";
import { uuidV7 } from "../shared/uuid-v7";
import {
  findXlsxExportByIdempotencyKey,
  findXlsxExportForAccess,
  insertXlsxExportJob,
  loadXlsxExportSource,
} from "./xlsx-export-repository";
import { buildXlsxExportSnapshot, xlsxSnapshotChecksum } from "./xlsx-export-snapshot";

function commandHash(input: object): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function hasFreshAuthentication(sql: Sql, actor: Actor): Promise<boolean> {
  const [row] = await sql<{ allowed: boolean }[]>`
    select exists(
      select 1 from sessions
      where id = ${actor.sessionId} and user_id = ${actor.userId}
        and revoked_at is null and expires_at > now()
        and created_at >= now() - interval '15 minutes'
    ) as allowed
  `;
  return row?.allowed === true;
}

function requireManager(actor: Actor | null): asserts actor is Actor {
  if (!actor) throw unauthenticated();
  if (actor.role !== "admin" && actor.role !== "superadmin") {
    throw new AuthError("FORBIDDEN", "Pracovní XLSX je dostupné pouze administrátorům.", 403);
  }
}

export function createXlsxExportService({ sql }: { sql: Sql }) {
  async function deny(actor: Actor | null, action: string, targetType: string, targetId: string, correlationId: string, reason?: string) {
    await appendDeniedAudit(sql, {
      actor,
      action,
      targetType,
      targetId,
      correlationId,
      metadata: reason ? { reason } : undefined,
    });
  }

  return {
    async createExport(
      actorInput: Actor | null,
      documentId: string,
      input: { documentVersionId: string; idempotencyKey: string },
      correlationId = crypto.randomUUID(),
    ): Promise<XlsxExportJob> {
      try {
        requireManager(actorInput);
      } catch (error) {
        await deny(actorInput, "xlsx_export.create_denied", "document", documentId, correlationId);
        throw error;
      }
      const actor = actorInput;
      const fingerprint = commandHash({
        operation: "createXlsxExport",
        documentId,
        documentVersionId: input.documentVersionId,
      });

      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const replay = await findXlsxExportByIdempotencyKey(tx, input.idempotencyKey);
        if (replay) {
          if (replay.commandHash !== fingerprint) {
            return { error: new AuthError("IDEMPOTENCY_CONFLICT", "Identifikátor požadavku již byl použit pro jiný export.", 409) } as const;
          }
          const access = await findXlsxExportForAccess(tx, replay.id);
          if (!access || (actor.role !== "superadmin" && access.ownerAdminId !== actor.userId)) {
            return { error: new AuthError("FORBIDDEN", "Administrátor může exportovat jen vlastní dokument.", 403) } as const;
          }
          if (!await hasFreshAuthentication(tx, actor)) {
            return { error: new AuthError("FRESH_AUTHENTICATION_REQUIRED", "Pracovní XLSX vyžaduje nové přihlášení.", 403) } as const;
          }
          const { commandHash: _commandHash, ...job } = replay;
          return { value: job } as const;
        }

        const loaded = await loadXlsxExportSource(tx, documentId, input.documentVersionId);
        if (!loaded) {
          return { error: new AuthError("DOCUMENT_VERSION_NOT_READY", "Dokument nebo připravená verze nebyla nalezena.", 409) } as const;
        }
        if (actor.role !== "superadmin" && loaded.ownerAdminId !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "xlsx_export.create_denied",
            targetType: "document",
            targetId: documentId,
            correlationId,
            metadata: { reason: "FORBIDDEN" },
          }, "denied");
          return { error: new AuthError("FORBIDDEN", "Administrátor může exportovat jen vlastní dokument.", 403) } as const;
        }
        if (!await hasFreshAuthentication(tx, actor)) {
          await appendAudit(tx, {
            actor,
            action: "xlsx_export.create_denied",
            targetType: "document",
            targetId: documentId,
            correlationId,
            metadata: { reason: "FRESH_AUTHENTICATION_REQUIRED" },
          }, "denied");
          return { error: new AuthError("FRESH_AUTHENTICATION_REQUIRED", "Pracovní XLSX vyžaduje nové přihlášení.", 403) } as const;
        }

        const signingKeyId = process.env.XLSX_MANIFEST_KEY_ID;
        if (!signingKeyId) {
          throw new AuthError("XLSX_SIGNING_NOT_CONFIGURED", "Podpis pracovního XLSX není nakonfigurován.", 503);
        }
        const snapshot = buildXlsxExportSnapshot(loaded.source, new Date().toISOString());
        const checksum = xlsxSnapshotChecksum(snapshot);
        const jobId = uuidV7();
        const job = await insertXlsxExportJob(tx, {
          id: jobId,
          documentId,
          documentVersionId: input.documentVersionId,
          schemaVersion: snapshot.schemaVersion,
          snapshot,
          snapshotSha256: checksum,
          rowCount: snapshot.rowCount,
          requestedByUserId: actor.userId,
          idempotencyKey: input.idempotencyKey,
          commandHash: fingerprint,
          signingKeyId,
        });
        await appendOutbox(tx, {
          eventType: "xlsx.export.requested",
          aggregateType: "xlsx_export_job",
          aggregateId: jobId,
          idempotencyKey: input.idempotencyKey,
          payload: { snapshotSha256: checksum, rowCount: snapshot.rowCount },
        });
        await appendAudit(tx, {
          actor,
          action: "xlsx_export.created",
          targetType: "xlsx_export_job",
          targetId: jobId,
          correlationId,
          metadata: { documentId, snapshotSha256: checksum, rowCount: snapshot.rowCount },
        }, "allowed");
        return { value: job } as const;
      });
      if ("error" in result) throw result.error;
      return result.value;
    },

    async getExport(actorInput: Actor | null, exportJobId: string, correlationId = crypto.randomUUID()): Promise<XlsxExportJob> {
      try {
        requireManager(actorInput);
      } catch (error) {
        await deny(actorInput, "xlsx_export.read_denied", "xlsx_export_job", exportJobId, correlationId);
        throw error;
      }
      const loaded = await findXlsxExportForAccess(sql, exportJobId);
      if (!loaded) throw new AuthError("NOT_FOUND", "XLSX export nebyl nalezen.", 404);
      if (actorInput.role !== "superadmin" && loaded.ownerAdminId !== actorInput.userId) {
        await deny(actorInput, "xlsx_export.read_denied", "xlsx_export_job", exportJobId, correlationId, "FORBIDDEN");
        throw new AuthError("FORBIDDEN", "Administrátor může číst jen exporty vlastních dokumentů.", 403);
      }
      return loaded.job;
    },

    async getDownloadFileId(actorInput: Actor | null, exportJobId: string, correlationId = crypto.randomUUID()): Promise<string> {
      try {
        requireManager(actorInput);
      } catch (error) {
        await deny(actorInput, "xlsx_export.download_denied", "xlsx_export_job", exportJobId, correlationId);
        throw error;
      }
      const loaded = await findXlsxExportForAccess(sql, exportJobId);
      if (!loaded) throw new AuthError("NOT_FOUND", "XLSX export nebyl nalezen.", 404);
      if (actorInput.role !== "superadmin" && loaded.ownerAdminId !== actorInput.userId) {
        await deny(actorInput, "xlsx_export.download_denied", "xlsx_export_job", exportJobId, correlationId, "FORBIDDEN");
        throw new AuthError("FORBIDDEN", "Administrátor může stahovat jen vlastní exporty.", 403);
      }
      if (!await hasFreshAuthentication(sql, actorInput)) {
        await deny(actorInput, "xlsx_export.download_denied", "xlsx_export_job", exportJobId, correlationId, "FRESH_AUTHENTICATION_REQUIRED");
        throw new AuthError("FRESH_AUTHENTICATION_REQUIRED", "Stažení pracovního XLSX vyžaduje nové přihlášení.", 403);
      }
      if (loaded.job.status !== "completed" || !loaded.job.outputFileId) {
        throw new AuthError("EXPORT_NOT_READY", "XLSX export zatím není připraven ke stažení.", 409);
      }
      return loaded.job.outputFileId;
    },
  };
}

import type { Sql } from "postgres";
import type { Actor } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { AuthError, unauthenticated } from "../identity/auth-errors";
import type { ObjectContainer, ObjectStorage } from "./object-storage";

export function createFileDownloadService({
  sql,
  storage,
  ttlSeconds,
}: {
  sql: Sql;
  storage: ObjectStorage;
  ttlSeconds: number;
}) {
  return {
    async createReadLink(
      actor: Actor | null,
      fileId: string,
      correlationId = crypto.randomUUID(),
    ) {
      if (!actor || (actor.role !== "admin" && actor.role !== "superadmin")) {
        await appendDeniedAudit(sql, {
          actor,
          action: "file.download_link_denied",
          targetType: "file_object",
          targetId: fileId,
          correlationId,
        });
        if (!actor) throw unauthenticated();
        throw new AuthError("FORBIDDEN", "Soubor je dostupný pouze správci dokumentu.", 403);
      }

      const [file] = await sql<{
        id: string;
        owner_admin_id: string;
        purpose: "original_docx" | "reference_render" | "table_image" | "attachment";
        container: ObjectContainer;
        object_key: string;
        av_status: string;
        object_status: string;
      }[]>`
        select file.id, document.owner_admin_id, file.purpose, file.container,
          file.object_key, file.av_status, file.object_status
        from file_objects file
        join documents document on document.id=file.document_id
        where file.id=${fileId} and file.deleted_at is null
      `;
      if (!file) throw new AuthError("NOT_FOUND", "Soubor nebyl nalezen.", 404);
      if (actor.role !== "superadmin" && file.owner_admin_id !== actor.userId) {
        await appendDeniedAudit(sql, {
          actor,
          action: "file.download_link_denied",
          targetType: "file_object",
          targetId: fileId,
          correlationId,
          metadata: { reason: "FORBIDDEN" },
        });
        throw new AuthError("FORBIDDEN", "Administrátor může stahovat jen soubory vlastních dokumentů.", 403);
      }
      if (file.av_status !== "clean") {
        await appendDeniedAudit(sql, {
          actor,
          action: "file.download_link_denied",
          targetType: "file_object",
          targetId: fileId,
          correlationId,
          metadata: { reason: "FILE_NOT_CLEAN" },
        });
        throw new AuthError("FILE_NOT_CLEAN", "Soubor není bezpečnostně ověřen.", 409);
      }
      const isArchivedOriginal = file.purpose === "original_docx"
        && file.container === "originals"
        && file.object_status === "archived";
      const isReadyDerivative = file.purpose !== "original_docx"
        && file.container === "derivatives"
        && file.object_status === "derivative";
      if (!isArchivedOriginal && !isReadyDerivative) {
        await appendDeniedAudit(sql, {
          actor,
          action: "file.download_link_denied",
          targetType: "file_object",
          targetId: fileId,
          correlationId,
          metadata: { reason: "FILE_NOT_DOWNLOADABLE" },
        });
        throw new AuthError(
          "FILE_NOT_DOWNLOADABLE",
          "Soubor zatím není připraven ke stažení.",
          409,
        );
      }
      if (![
        "original_docx", "reference_render", "table_image", "attachment",
      ].includes(file.purpose)) {
        throw new AuthError("FILE_PURPOSE_NOT_DOWNLOADABLE", "Tento typ souboru nelze stáhnout.", 403);
      }

      const signed = await storage.createReadUrl(file.container, file.object_key, ttlSeconds);
      await withTransaction(sql, async (tx) => appendAudit(tx, {
        actor,
        action: "file.download_link_created",
        targetType: "file_object",
        targetId: fileId,
        correlationId,
        metadata: { purpose: file.purpose, expiresAt: signed.expiresAt },
      }, "allowed"));
      return { url: signed.url, expiresAt: signed.expiresAt };
    },
  };
}

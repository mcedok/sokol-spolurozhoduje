import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Actor, BlockType, VersionedCommand } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { AuthError, unauthenticated } from "../identity/auth-errors";
import { appendOutbox } from "../outbox/outbox-writer";
import { findConversionReview } from "./conversion-repository";
import { readinessFailures } from "./readiness-policy";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(
    value as Record<string, unknown>,
  )
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createConversionService({ sql }: { sql: Sql }) {
  type TableRepresentation = "html" | "image_with_attachment" | "attachment_only";
  const blockTypes = new Set<BlockType>([
    "heading", "paragraph", "list_item", "table", "table_image",
    "attachment_reference", "quote", "callout", "technical_separator",
  ]);
  const normalized = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
  async function requireManager(
    actor: Actor | null,
    action: string,
    targetId: string,
    correlationId: string,
  ): Promise<Actor> {
    if (actor && (actor.role === "admin" || actor.role === "superadmin")) return actor;
    await appendDeniedAudit(sql, {
      actor, action, targetType: "document_version", targetId, correlationId,
    });
    if (!actor) throw unauthenticated();
    throw new AuthError("FORBIDDEN", "Ke kontrole převodu nemáte oprávnění.", 403);
  }

  return {
    async getProcessing(
      actorInput: Actor | null,
      versionId: string,
      correlationId = crypto.randomUUID(),
    ) {
      const actor = await requireManager(
        actorInput, "conversion.processing_read_denied", versionId, correlationId,
      );
      const [row] = await sql<{
        version_id: string;
        owner_admin_id: string;
        version_status: string;
        row_version: number;
        job_id: string;
        job_status: string;
        current_step: string;
        attempt_count: number;
        error_code: string | null;
        started_at: Date | null;
        completed_at: Date | null;
      }[]>`
        select version.id as version_id, document.owner_admin_id,
          version.status::text as version_status, version.row_version, job.id as job_id,
          job.status as job_status, job.current_step, job.attempt_count,
          job.error_code, job.started_at, job.completed_at
        from document_versions version
        join documents document on document.id=version.document_id
        join conversion_jobs job on job.id=version.current_conversion_job_id
        where version.id=${versionId}
      `;
      if (!row) throw new AuthError("NOT_FOUND", "Převod nebyl nalezen.", 404);
      if (actor.role !== "superadmin" && row.owner_admin_id !== actor.userId) {
        await appendDeniedAudit(sql, {
          actor,
          action: "conversion.processing_read_denied",
          targetType: "document_version",
          targetId: versionId,
          correlationId,
        });
        throw new AuthError("FORBIDDEN", "Administrátor může číst jen vlastní dokumenty.", 403);
      }
      return {
        versionId: row.version_id,
        jobId: row.job_id,
        jobStatus: row.job_status,
        versionStatus: row.version_status,
        rowVersion: row.row_version,
        step: row.current_step,
        attemptCount: row.attempt_count,
        errorCode: row.error_code,
        startedAt: row.started_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null,
      };
    },

    async getPreview(
      actorInput: Actor | null,
      versionId: string,
      correlationId = crypto.randomUUID(),
    ) {
      const actor = await requireManager(
        actorInput, "conversion.preview_read_denied", versionId, correlationId,
      );
      const result = await withTransaction(sql, async (tx) => {
      await tx`set transaction isolation level repeatable read`;
      const [version] = await tx<{
        id: string;
        document_id: string;
        owner_admin_id: string;
        status: string;
        row_version: number;
        review_completed_at: Date | null;
      }[]>`
        select version.id, version.document_id, document.owner_admin_id,
          version.status::text as status, version.row_version, version.review_completed_at
        from document_versions version
        join documents document on document.id=version.document_id
        where version.id=${versionId}
      `;
      if (!version) return { error: new AuthError("NOT_FOUND", "Náhled nebyl nalezen.", 404) };
      if (actor.role !== "superadmin" && version.owner_admin_id !== actor.userId) {
        await appendAudit(tx, {
          actor,
          action: "conversion.preview_read_denied",
          targetType: "document_version",
          targetId: versionId,
          correlationId,
        }, "denied");
        return { error: new AuthError(
          "FORBIDDEN", "Administrátor může číst jen vlastní dokumenty.", 403,
        ) };
      }
      const blocks = await tx<{
        block_uid: string;
        block_revision_id: string;
        block_type: BlockType;
        block_order: number;
        commentable: boolean;
        plain_text: string;
        structured_content: Record<string, unknown>;
        source_range: Record<string, unknown> | null;
      }[]>`
        select revision.block_uid, revision.block_revision_id, revision.block_type,
          revision.block_order, revision.commentable, revision.plain_text,
          revision.structured_content, revision.source_range
        from block_revisions revision
        where revision.document_version_id=${versionId} and revision.superseded_at is null
        order by revision.block_order
      `;
      const assets = await tx<{
        block_revision_id: string;
        id: string;
        purpose: "table_image" | "reference_page" | "attachment";
        alternative_text: string | null;
      }[]>`
        select asset.block_revision_id, asset.id, asset.purpose, asset.alternative_text
        from block_assets asset
        join block_revisions revision on revision.block_revision_id=asset.block_revision_id
        where revision.document_version_id=${versionId} and revision.superseded_at is null
        order by asset.asset_order
      `;
      const findings = await tx<{
        id: string;
        conversion_job_id: string;
        block_uid: string | null;
        code: string;
        severity: string;
        status: string;
        message: string;
        decision_reason: string | null;
      }[]>`
        select finding.id, finding.conversion_job_id, finding.block_uid, finding.code,
          finding.severity, finding.status, finding.message, finding.decision_reason
        from conversion_findings finding
        join conversion_jobs job on job.id=finding.conversion_job_id
        where job.document_version_id=${versionId}
        order by finding.created_at, finding.id
      `;
      const [referenceFile] = await tx<{ id: string }[]>`
        select id from file_objects
        where document_id=${version.document_id}
          and purpose='reference_render'
          and container='derivatives'
          and av_status='clean'
          and object_status='derivative'
          and object_key like ${`${version.document_id}/${versionId}/reference/%`}
        order by created_at desc, id desc
        limit 1
      `;
      return { value: {
        id: version.id,
        documentId: version.document_id,
        status: version.status,
        rowVersion: version.row_version,
        reviewCompletedAt: version.review_completed_at?.toISOString() ?? null,
        referenceFileId: referenceFile?.id ?? null,
        blocks: blocks.map((block) => ({
          blockUid: block.block_uid,
          blockRevisionId: block.block_revision_id,
          type: block.block_type,
          order: block.block_order,
          commentable: block.commentable,
          text: block.plain_text,
          structuredContent: block.structured_content,
          sourceRange: block.source_range,
          tableRepresentation: typeof block.structured_content.confirmedRepresentation === "string"
            ? block.structured_content.confirmedRepresentation
            : null,
          alternativeText: assets.find(
            (asset) => asset.block_revision_id === block.block_revision_id
              && asset.alternative_text,
          )?.alternative_text ?? null,
          assets: assets.filter((asset) => asset.block_revision_id === block.block_revision_id)
            .map((asset) => ({
              id: asset.id,
              purpose: asset.purpose,
              alternativeText: asset.alternative_text,
            })),
        })),
        findings: findings.map((finding) => ({
          id: finding.id,
          jobId: finding.conversion_job_id,
          blockUid: finding.block_uid,
          code: finding.code,
          severity: finding.severity,
          status: finding.status,
          message: finding.message,
          decisionReason: finding.decision_reason,
        })),
      } };
      });
      if ("error" in result) throw result.error;
      return result.value;
    },

    async retry(
      actorInput: Actor | null,
      jobId: string,
      command: VersionedCommand,
      correlationId = crypto.randomUUID(),
    ) {
      const actor = await requireManager(
        actorInput, "conversion.retry_denied", jobId, correlationId,
      );
      const commandHash = fingerprint({ operation: "retry", jobId, rowVersion: command.rowVersion });
      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${command.idempotencyKey}))`;
        const [job] = await tx<{
          id: string;
          version_id: string;
          document_id: string;
          owner_admin_id: string;
          job_status: string;
          attempt_count: number;
          row_version: number;
          is_latest: boolean;
        }[]>`
          select job.id, version.id as version_id, version.document_id,
            document.owner_admin_id, job.status as job_status, job.attempt_count,
            version.row_version,
            not exists (
              select 1 from document_versions newer
              where newer.document_id=version.document_id
                and newer.version_number>version.version_number
            ) as is_latest
          from conversion_jobs job
          join document_versions version on version.id=job.document_version_id
          join documents document on document.id=version.document_id
          where job.id=${jobId}
          for update of job, version, document
        `;
        if (!job) return { error: new AuthError("NOT_FOUND", "Převodní úloha nebyla nalezena.", 404) };
        if (actor.role !== "superadmin" && job.owner_admin_id !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "conversion.retry_denied",
            targetType: "conversion_job",
            targetId: jobId,
            correlationId,
            metadata: { reason: "FORBIDDEN", versionId: job.version_id },
          }, "denied");
          return {
            error: new AuthError("FORBIDDEN", "Administrátor může opakovat jen vlastní převody.", 403),
          };
        }
        const [prior] = await tx<{ event_type: string; aggregate_id: string; payload: {
          commandHash?: string;
          versionId?: string;
          jobId?: string;
          jobStatus?: "queued";
          rowVersion?: number;
        } }[]>`
          select event_type, aggregate_id::text as aggregate_id, payload
          from outbox_events where idempotency_key=${command.idempotencyKey}
        `;
        if (prior) {
          if (
            prior.event_type === "document.conversion.retry_requested"
            && prior.aggregate_id === job.version_id
            && prior.payload.commandHash === commandHash
            && prior.payload.versionId && prior.payload.jobId
            && prior.payload.jobStatus === "queued"
            && typeof prior.payload.rowVersion === "number"
          ) return { value: {
            versionId: prior.payload.versionId,
            jobId: prior.payload.jobId,
            jobStatus: prior.payload.jobStatus,
            rowVersion: prior.payload.rowVersion,
          } };
          return { error: new AuthError(
            "IDEMPOTENCY_CONFLICT",
            "Tento identifikátor požadavku již byl použit pro jiný příkaz.",
            409,
          ) };
        }
        if (job.row_version !== command.rowVersion) return {
          error: new AuthError("VERSION_CONFLICT", "Verze byla mezitím změněna.", 409),
        };
        if (!job.is_latest) return {
          error: new AuthError(
            "STALE_DOCUMENT_VERSION",
            "Opakovat lze pouze převod nejnovější verze dokumentu.",
            409,
          ),
        };
        if (!new Set(["failed", "retry_wait"]).has(job.job_status)) return {
          error: new AuthError("INVALID_TRANSITION", "Tuto převodní úlohu nelze opakovat.", 409),
        };
        if (job.attempt_count >= 4) return {
          error: new AuthError("RETRY_LIMIT_REACHED", "Převod vyčerpal povolený počet pokusů.", 409),
        };
        await tx`
          update conversion_findings set status='resolved', decided_by_user_id=${actor.userId},
            decision_reason='Nahrazeno opakováním převodu', decided_at=now()
          where conversion_job_id=${jobId} and status='open'
        `;
        const [version] = await tx<{ row_version: number }[]>`
          update document_versions set status='file_check', row_version=row_version+1,
            updated_at=now() where id=${job.version_id} and row_version=${command.rowVersion}
          returning row_version
        `;
        if (!version) throw new AuthError("VERSION_CONFLICT", "Verze byla mezitím změněna.", 409);
        await tx`
          update documents set status='file_check', row_version=row_version+1, updated_at=now()
          where id=${job.document_id}
        `;
        await tx`
          update conversion_jobs set status='queued', current_step='file_check', error_code=null,
            next_attempt_at=now(), lease_owner=null, lease_expires_at=null, heartbeat_at=null,
            started_at=null, completed_at=null, updated_at=now()
          where id=${jobId}
        `;
        const value = {
          versionId: job.version_id,
          jobId,
          jobStatus: "queued" as const,
          rowVersion: version.row_version,
        };
        await appendAudit(tx, {
          actor,
          action: "conversion.retry_requested",
          targetType: "conversion_job",
          targetId: jobId,
          correlationId,
          metadata: { versionId: job.version_id },
        }, "allowed");
        await appendOutbox(tx, {
          eventType: "document.conversion.retry_requested",
          aggregateType: "document_version",
          aggregateId: job.version_id,
          idempotencyKey: command.idempotencyKey,
          payload: { ...value, commandHash },
        });
        return { value };
      });
      if ("error" in result) throw result.error;
      return result.value;
    },

    async editBlockStructure(
      actorInput: Actor | null,
      versionId: string,
      blockUid: string,
      input: {
        rowVersion: number;
        idempotencyKey: string;
        reason: string;
        type: BlockType;
        commentable: boolean;
        text: string;
        order?: number;
        sourceRange?: Record<string, unknown> | null;
        tableRepresentation?: TableRepresentation;
        alternativeText?: string;
      },
      correlationId = crypto.randomUUID(),
    ) {
      const actor = await requireManager(
        actorInput, "conversion.block_edit_denied", versionId, correlationId,
      );
      if (!input.reason.trim()) throw new AuthError(
        "EDIT_REASON_REQUIRED", "Strukturální oprava vyžaduje odůvodnění.", 400,
      );
      if (!blockTypes.has(input.type)) throw new AuthError(
        "BLOCK_TYPE_INVALID", "Typ bloku není podporován.", 400,
      );
      const commandHash = fingerprint({
        operation: "editBlockStructure",
        versionId,
        blockUid,
        rowVersion: input.rowVersion,
        reason: input.reason.trim(),
        type: input.type,
        commentable: input.commentable,
        text: normalized(input.text),
        tableRepresentation: input.tableRepresentation,
        alternativeText: input.alternativeText?.trim(),
        order: input.order,
        sourceRange: input.sourceRange,
      });
      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const [row] = await tx<{
          document_id: string;
          owner_admin_id: string;
          version_status: string;
          row_version: number;
          block_revision_id: string;
          block_order: number;
          block_type: BlockType;
          structured_content: Record<string, unknown>;
          plain_text: string;
          parser_version: string;
          commentable: boolean;
          table_representation: TableRepresentation | null;
          alternative_text: string | null;
          source_range: Record<string, unknown> | null;
          has_table_image: boolean;
          has_attachment: boolean;
        }[]>`
          select version.document_id, document.owner_admin_id,
            version.status::text as version_status, version.row_version,
            revision.block_revision_id, revision.block_order, revision.block_type,
            revision.structured_content, revision.plain_text, revision.parser_version,
            revision.commentable, revision.source_range,
            (select asset.table_representation from block_assets asset
              where asset.block_revision_id=revision.block_revision_id
                and asset.purpose='table_image' order by asset.asset_order limit 1
            ) as table_representation,
            (select asset.alternative_text from block_assets asset
              where asset.block_revision_id=revision.block_revision_id
                and asset.purpose='table_image' order by asset.asset_order limit 1
            ) as alternative_text
            ,exists(select 1 from block_assets asset
              where asset.block_revision_id=revision.block_revision_id
                and asset.purpose='table_image') as has_table_image
            ,exists(select 1 from block_assets asset
              where asset.block_revision_id=revision.block_revision_id
                and asset.purpose='attachment') as has_attachment
          from document_versions version
          join documents document on document.id=version.document_id
          join block_revisions revision on revision.document_version_id=version.id
            and revision.block_uid=${blockUid} and revision.superseded_at is null
          where version.id=${versionId}
          for update of version, revision, document
        `;
        if (!row) return { error: new AuthError("NOT_FOUND", "Blok nebyl nalezen.", 404) };
        if (actor.role !== "superadmin" && row.owner_admin_id !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "conversion.block_edit_denied",
            targetType: "document_version",
            targetId: versionId,
            correlationId,
            metadata: { reason: "FORBIDDEN", blockUid },
          }, "denied");
          return {
            error: new AuthError("FORBIDDEN", "Administrátor může upravit jen vlastní dokumenty.", 403),
          };
        }
        const [prior] = await tx<{ event_type: string; aggregate_id: string; payload: {
          commandHash?: string;
          blockUid?: string;
          blockRevisionId?: string;
          type?: BlockType;
          commentable?: boolean;
          rowVersion?: number;
          order?: number;
          sourceRange?: Record<string, unknown> | null;
        } }[]>`
          select event_type, aggregate_id::text as aggregate_id, payload
          from outbox_events where idempotency_key=${input.idempotencyKey}
        `;
        if (prior) {
          if (
            prior.event_type === "document.conversion.block_structure_edited"
            && prior.aggregate_id === versionId
            && prior.payload.commandHash === commandHash
            && prior.payload.blockUid === blockUid
            && prior.payload.blockRevisionId
            && prior.payload.type
            && typeof prior.payload.commentable === "boolean"
            && typeof prior.payload.rowVersion === "number"
            && typeof prior.payload.order === "number"
          ) return { value: {
            blockUid: prior.payload.blockUid,
            blockRevisionId: prior.payload.blockRevisionId,
            type: prior.payload.type,
            commentable: prior.payload.commentable,
            rowVersion: prior.payload.rowVersion,
            order: prior.payload.order,
            sourceRange: prior.payload.sourceRange ?? null,
          } };
          return { error: new AuthError(
            "IDEMPOTENCY_CONFLICT",
            "Tento identifikátor požadavku již byl použit pro jinou operaci.",
            409,
          ) };
        }
        if (row.version_status !== "conversion_review") return {
          error: new AuthError("INVALID_TRANSITION", "Verze není ve stavu kontroly převodu.", 409),
        };
        if (row.row_version !== input.rowVersion) return {
          error: new AuthError("VERSION_CONFLICT", "Verze byla mezitím změněna.", 409),
        };
        if (normalized(row.plain_text) !== normalized(input.text)) return {
          error: new AuthError(
            "TEXT_CHANGE_REQUIRES_DOCX",
            "Text dokumentu lze změnit pouze nahráním nové verze DOCX.",
            409,
          ),
        };
        if (input.type === "technical_separator" && normalized(input.text).length > 0) return {
          error: new AuthError(
            "SEPARATOR_MUST_BE_EMPTY",
            "Technický oddělovač nesmí skrývat text dokumentu.",
            409,
          ),
        };
        if (input.order !== undefined && (!Number.isInteger(input.order) || input.order < 0)) return {
          error: new AuthError("BLOCK_ORDER_INVALID", "Pořadí bloku musí být nezáporné celé číslo.", 400),
        };
        const nextOrder = input.order ?? row.block_order;
        const shiftedRows = nextOrder === row.block_order ? [] : await tx<{
          block_revision_id: string;
          block_uid: string;
          block_order: number;
          block_type: BlockType;
          structured_content: Record<string, unknown>;
          plain_text: string;
          normalized_hash: string;
          commentable: boolean;
          source_range: Record<string, unknown> | null;
          parser_version: string;
        }[]>`
          select block_revision_id,block_uid,block_order,block_type,structured_content,
            plain_text,normalized_hash,commentable,source_range,parser_version
          from block_revisions
          where document_version_id=${versionId} and superseded_at is null
            and block_uid<>${blockUid}
            and block_order between ${Math.min(row.block_order, nextOrder)}
              and ${Math.max(row.block_order, nextOrder)}
          order by block_uid
          for update
        `;
        if (input.tableRepresentation && input.type !== "table") return {
          error: new AuthError(
            "TABLE_REPRESENTATION_INVALID",
            "Způsob zobrazení lze nastavit pouze pro tabulku.",
            400,
          ),
        };
        if (
          input.tableRepresentation === "image_with_attachment"
          && !input.alternativeText?.trim()
        ) return {
          error: new AuthError(
            "ALT_TEXT_REQUIRED",
            "Obrazové zobrazení tabulky vyžaduje alternativní popis.",
            400,
          ),
        };
        if (
          (input.tableRepresentation === "image_with_attachment"
            && (!row.has_table_image || !row.has_attachment))
          || (input.tableRepresentation === "attachment_only" && !row.has_attachment)
        ) return {
          error: new AuthError(
            "TABLE_ASSET_REQUIRED",
            "Pro zvolený způsob zobrazení tabulky chybí povinný soubor.",
            409,
          ),
        };
        const currentRepresentation = typeof row.structured_content.confirmedRepresentation === "string"
          ? row.structured_content.confirmedRepresentation
          : null;
        const nextRepresentation = input.type === "table"
          ? input.tableRepresentation ?? currentRepresentation
          : null;
        const nextAlternativeText = input.alternativeText?.trim() ?? row.alternative_text;
        const nextSourceRange = input.sourceRange === undefined ? row.source_range : input.sourceRange;
        const changes: Array<
          "type" | "commentable" | "table_representation" | "alternative_text"
          | "boundaries" | "order" | "separator"
        > = [];
        if (row.block_type !== input.type) changes.push(
          row.block_type === "technical_separator" || input.type === "technical_separator"
            ? "separator"
            : "type",
        );
        if (row.commentable !== input.commentable) changes.push("commentable");
        if (row.block_order !== nextOrder) changes.push("order");
        if (canonicalJson(row.source_range) !== canonicalJson(nextSourceRange)) changes.push("boundaries");
        if (currentRepresentation !== nextRepresentation) changes.push("table_representation");
        if (row.alternative_text !== nextAlternativeText) changes.push("alternative_text");
        if (!changes.length) return {
          error: new AuthError("NO_CHANGES", "Nebyla zadána žádná změna struktury.", 400),
        };
        const newRevisionId = crypto.randomUUID();
        const hash = createHash("sha256").update(normalized(input.text)).digest("hex");
        const structuredContent = { ...row.structured_content };
        if (nextRepresentation) structuredContent.confirmedRepresentation = nextRepresentation;
        else delete structuredContent.confirmedRepresentation;
        if (shiftedRows.length) await tx`
            update block_revisions set superseded_at=now()
            where block_revision_id=${row.block_revision_id}
              or block_revision_id in ${tx(shiftedRows.map((shifted) => shifted.block_revision_id))}
          `;
        else await tx`
            update block_revisions set superseded_at=now()
            where block_revision_id=${row.block_revision_id}
          `;
        for (const shifted of shiftedRows) {
          const shiftedRevisionId = crypto.randomUUID();
          const shiftedOrder = shifted.block_order + (nextOrder < row.block_order ? 1 : -1);
          await tx`
            insert into block_revisions(
              block_revision_id,block_uid,document_version_id,block_order,block_type,
              structured_content,plain_text,normalized_hash,commentable,source_range,
              parser_version,revision_origin,created_by_user_id
            ) values (
              ${shiftedRevisionId},${shifted.block_uid},${versionId},${shiftedOrder},
              ${shifted.block_type},${tx.json(shifted.structured_content as never)},
              ${shifted.plain_text},${shifted.normalized_hash},${shifted.commentable},
              ${shifted.source_range ? tx.json(shifted.source_range as never) : null},
              ${shifted.parser_version},'admin_structure_edit',${actor.userId}
            )
          `;
          await tx`
            insert into block_assets(
              id,block_revision_id,file_object_id,purpose,asset_order,alternative_text,
              width,height,checksum,table_representation
            ) select gen_random_uuid(),${shiftedRevisionId},file_object_id,purpose,asset_order,
              alternative_text,width,height,checksum,table_representation
            from block_assets where block_revision_id=${shifted.block_revision_id}
          `;
          await tx`
            insert into block_edit_revisions(
              id,document_version_id,block_uid,previous_block_revision_id,new_block_revision_id,
              change_type,before_structure,after_structure,actor_user_id,reason
            ) values (
              ${crypto.randomUUID()},${versionId},${shifted.block_uid},
              ${shifted.block_revision_id},${shiftedRevisionId},'order',
              ${tx.json({ order: shifted.block_order })},${tx.json({ order: shiftedOrder })},
              ${actor.userId},${input.reason.trim()}
            )
          `;
        }
        await tx`
          insert into block_revisions(
            block_revision_id, block_uid, document_version_id, block_order, block_type,
            structured_content, plain_text, normalized_hash, commentable, parser_version,
            revision_origin, created_by_user_id, source_range
          ) values (
            ${newRevisionId}, ${blockUid}, ${versionId}, ${nextOrder}, ${input.type},
            ${tx.json(structuredContent as never)}, ${input.text}, ${hash},
            ${input.commentable}, ${row.parser_version}, 'admin_structure_edit', ${actor.userId},
            ${nextSourceRange ? tx.json(nextSourceRange as never) : null}
          )
        `;
        await tx`
          insert into block_assets(
            id, block_revision_id, file_object_id, purpose, asset_order, alternative_text,
            width, height, checksum, table_representation
          ) select gen_random_uuid(), ${newRevisionId}, file_object_id, purpose, asset_order,
            case when purpose='table_image' then ${nextAlternativeText} else alternative_text end,
            width, height, checksum,
            case when purpose='table_image' then ${nextRepresentation} else table_representation end
          from block_assets where block_revision_id=${row.block_revision_id}
        `;
        for (const changeType of changes) await tx`
            insert into block_edit_revisions(
              id, document_version_id, block_uid, previous_block_revision_id, new_block_revision_id,
              change_type, before_structure, after_structure, actor_user_id, reason
            ) values (
              ${crypto.randomUUID()}, ${versionId}, ${blockUid}, ${row.block_revision_id},
              ${newRevisionId}, ${changeType},
              ${tx.json({
                type: row.block_type,
                commentable: row.commentable,
                order: row.block_order,
                sourceRange: row.source_range,
                tableRepresentation: currentRepresentation,
                alternativeText: row.alternative_text,
              } as never)},
              ${tx.json({
                type: input.type,
                commentable: input.commentable,
                order: nextOrder,
                sourceRange: nextSourceRange,
                tableRepresentation: nextRepresentation,
                alternativeText: nextAlternativeText,
              } as never)},
              ${actor.userId}, ${input.reason.trim()}
            )
          `;
        const [version] = await tx<{ row_version: number }[]>`
          update document_versions set row_version=row_version+1, updated_at=now()
          where id=${versionId} and row_version=${input.rowVersion}
          returning row_version
        `;
        await appendAudit(tx, {
          actor,
          action: "conversion.block_structure_edited",
          targetType: "document_version",
          targetId: versionId,
          correlationId,
          metadata: { blockUid, changeTypes: changes, reason: input.reason.trim() },
        }, "allowed");
        const value = {
          blockUid,
          blockRevisionId: newRevisionId,
          type: input.type,
          commentable: input.commentable,
          order: nextOrder,
          sourceRange: nextSourceRange,
          rowVersion: version.row_version,
        };
        await appendOutbox(tx, {
          eventType: "document.conversion.block_structure_edited",
          aggregateType: "document_version",
          aggregateId: versionId,
          idempotencyKey: input.idempotencyKey,
          payload: { ...value, commandHash },
        });
        return { value };
      });
      if ("error" in result) throw result.error;
      return result.value;
    },

    async editBlockBoundary(
      actorInput: Actor | null,
      versionId: string,
      leftBlockUid: string,
      rightBlockUid: string,
      input: {
        rowVersion: number;
        idempotencyKey: string;
        reason: string;
        leftText: string;
        rightText: string;
      },
      correlationId = crypto.randomUUID(),
    ) {
      const actor = await requireManager(
        actorInput, "conversion.block_boundary_denied", versionId, correlationId,
      );
      if (!input.reason.trim()) throw new AuthError(
        "EDIT_REASON_REQUIRED", "Oprava hranice vyžaduje odůvodnění.", 400,
      );
      if (!input.leftText.trim() || !input.rightText.trim()) throw new AuthError(
        "BOUNDARY_EMPTY_BLOCK", "Oprava hranice nesmí vytvořit prázdný textový blok.", 400,
      );
      const commandHash = fingerprint({
        operation: "editBlockBoundary",
        versionId,
        leftBlockUid,
        rightBlockUid,
        rowVersion: input.rowVersion,
        reason: input.reason.trim(),
        leftText: input.leftText.normalize("NFC").trim(),
        rightText: input.rightText.normalize("NFC").trim(),
      });
      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const rows = await tx<{
          document_id: string;
          owner_admin_id: string;
          version_status: string;
          row_version: number;
          block_revision_id: string;
          block_uid: string;
          block_order: number;
          block_type: BlockType;
          structured_content: Record<string, unknown>;
          plain_text: string;
          normalized_hash: string;
          commentable: boolean;
          source_range: Record<string, unknown> | null;
          parser_version: string;
          has_assets: boolean;
        }[]>`
          select version.document_id,document.owner_admin_id,
            version.status::text as version_status,version.row_version,
            revision.block_revision_id,revision.block_uid,revision.block_order,
            revision.block_type,revision.structured_content,revision.plain_text,
            revision.normalized_hash,revision.commentable,revision.source_range,
            revision.parser_version,
            exists(select 1 from block_assets asset
              where asset.block_revision_id=revision.block_revision_id) as has_assets
          from document_versions version
          join documents document on document.id=version.document_id
          join block_revisions revision on revision.document_version_id=version.id
            and revision.block_uid in (${leftBlockUid},${rightBlockUid})
            and revision.superseded_at is null
          where version.id=${versionId}
          order by revision.block_uid
          for update of version,document,revision
        `;
        if (rows.length !== 2) return {
          error: new AuthError("NOT_FOUND", "Oba bloky hranice nebyly nalezeny.", 404),
        };
        const left = rows.find((row) => row.block_uid === leftBlockUid)!;
        const right = rows.find((row) => row.block_uid === rightBlockUid)!;
        if (actor.role !== "superadmin" && left.owner_admin_id !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "conversion.block_boundary_denied",
            targetType: "document_version",
            targetId: versionId,
            correlationId,
            metadata: { reason: "FORBIDDEN", leftBlockUid, rightBlockUid },
          }, "denied");
          return { error: new AuthError(
            "FORBIDDEN", "Administrátor může upravit jen vlastní dokumenty.", 403,
          ) };
        }
        const [prior] = await tx<{ event_type: string; aggregate_id: string; payload: {
          commandHash?: string;
          leftBlockUid?: string;
          rightBlockUid?: string;
          leftBlockRevisionId?: string;
          rightBlockRevisionId?: string;
          rowVersion?: number;
        } }[]>`
          select event_type,aggregate_id::text as aggregate_id,payload
          from outbox_events where idempotency_key=${input.idempotencyKey}
        `;
        if (prior) {
          if (
            prior.event_type === "document.conversion.block_boundary_edited"
            && prior.aggregate_id === versionId
            && prior.payload.commandHash === commandHash
            && prior.payload.leftBlockUid && prior.payload.rightBlockUid
            && prior.payload.leftBlockRevisionId && prior.payload.rightBlockRevisionId
            && typeof prior.payload.rowVersion === "number"
          ) return { value: {
            leftBlockUid: prior.payload.leftBlockUid,
            rightBlockUid: prior.payload.rightBlockUid,
            leftBlockRevisionId: prior.payload.leftBlockRevisionId,
            rightBlockRevisionId: prior.payload.rightBlockRevisionId,
            rowVersion: prior.payload.rowVersion,
          } };
          return { error: new AuthError(
            "IDEMPOTENCY_CONFLICT",
            "Tento identifikátor požadavku již byl použit pro jinou operaci.",
            409,
          ) };
        }
        if (left.version_status !== "conversion_review") return {
          error: new AuthError("INVALID_TRANSITION", "Verze není ve stavu kontroly převodu.", 409),
        };
        if (left.row_version !== input.rowVersion) return {
          error: new AuthError("VERSION_CONFLICT", "Verze byla mezitím změněna.", 409),
        };
        if (right.block_order !== left.block_order + 1) return {
          error: new AuthError("BLOCKS_NOT_ADJACENT", "Hranici lze měnit jen mezi sousedními bloky.", 409),
        };
        if (left.has_assets || right.has_assets || left.block_type === "table" || right.block_type === "table") {
          return { error: new AuthError(
            "BOUNDARY_ASSET_CONFLICT",
            "Hranici bloků s tabulkou nebo přílohou nelze měnit.",
            409,
          ) };
        }
        const oldCombined = `${left.plain_text.normalize("NFC").trim()} ${right.plain_text.normalize("NFC").trim()}`;
        const newLeftText = input.leftText.normalize("NFC").trim();
        const newRightText = input.rightText.normalize("NFC").trim();
        if (oldCombined !== `${newLeftText} ${newRightText}`) return {
          error: new AuthError(
            "TEXT_CHANGE_REQUIRES_DOCX",
            "Oprava hranice musí zachovat přesné pořadí všech znaků.",
            409,
          ),
        };
        type Run = Record<string, unknown> & { text: string };
        const runs = (block: typeof left): Run[] => {
          const candidate = block.structured_content.runs;
          if (
            Array.isArray(candidate)
            && candidate.every((run) => run && typeof run === "object"
              && typeof (run as { text?: unknown }).text === "string")
            && candidate.map((run) => (run as { text: string }).text).join("") === block.plain_text
          ) return candidate as Run[];
          return [{ type: "text", text: block.plain_text }];
        };
        const combinedRuns: Run[] = [...runs(left), { type: "text", text: " " }, ...runs(right)];
        const takeRuns = (start: number, end: number): Run[] => {
          const result: Run[] = [];
          let offset = 0;
          for (const run of combinedRuns) {
            const runEnd = offset + run.text.length;
            const from = Math.max(start, offset);
            const to = Math.min(end, runEnd);
            if (from < to) result.push({ ...run, text: run.text.slice(from - offset, to - offset) });
            offset = runEnd;
          }
          return result;
        };
        const updated = [
          {
            row: left,
            text: newLeftText,
            structured: { ...left.structured_content, runs: takeRuns(0, newLeftText.length) },
          },
          {
            row: right,
            text: newRightText,
            structured: {
              ...right.structured_content,
              runs: takeRuns(newLeftText.length + 1, oldCombined.length),
            },
          },
        ];
        await tx`
          update block_revisions set superseded_at=now()
          where block_revision_id in ${tx(rows.map((row) => row.block_revision_id))}
        `;
        const revisionIds = new Map<string, string>();
        for (const item of updated) {
          const revisionId = crypto.randomUUID();
          revisionIds.set(item.row.block_uid, revisionId);
          await tx`
            insert into block_revisions(
              block_revision_id,block_uid,document_version_id,block_order,block_type,
              structured_content,plain_text,normalized_hash,commentable,source_range,
              parser_version,revision_origin,created_by_user_id
            ) values (
              ${revisionId},${item.row.block_uid},${versionId},${item.row.block_order},
              ${item.row.block_type},${tx.json(item.structured as never)},${item.text},
              ${createHash("sha256").update(normalized(item.text)).digest("hex")},
              ${item.row.commentable},
              ${item.row.source_range ? tx.json(item.row.source_range as never) : null},
              ${item.row.parser_version},'admin_structure_edit',${actor.userId}
            )
          `;
          await tx`
            insert into block_edit_revisions(
              id,document_version_id,block_uid,previous_block_revision_id,new_block_revision_id,
              change_type,before_structure,after_structure,actor_user_id,reason
            ) values (
              ${crypto.randomUUID()},${versionId},${item.row.block_uid},
              ${item.row.block_revision_id},${revisionId},'boundaries',
              ${tx.json({ text: item.row.plain_text })},${tx.json({ text: item.text })},
              ${actor.userId},${input.reason.trim()}
            )
          `;
        }
        const [version] = await tx<{ row_version: number }[]>`
          update document_versions set row_version=row_version+1,updated_at=now()
          where id=${versionId} and row_version=${input.rowVersion}
          returning row_version
        `;
        if (!version) throw new AuthError("VERSION_CONFLICT", "Verze byla mezitím změněna.", 409);
        const value = {
          leftBlockUid,
          rightBlockUid,
          leftBlockRevisionId: revisionIds.get(leftBlockUid)!,
          rightBlockRevisionId: revisionIds.get(rightBlockUid)!,
          rowVersion: version.row_version,
        };
        await appendAudit(tx, {
          actor,
          action: "conversion.block_boundary_edited",
          targetType: "document_version",
          targetId: versionId,
          correlationId,
          metadata: { leftBlockUid, rightBlockUid, reason: input.reason.trim() },
        }, "allowed");
        await appendOutbox(tx, {
          eventType: "document.conversion.block_boundary_edited",
          aggregateType: "document_version",
          aggregateId: versionId,
          idempotencyKey: input.idempotencyKey,
          payload: { ...value, commandHash },
        });
        return { value };
      });
      if ("error" in result) throw result.error;
      return result.value;
    },

    async decideFinding(
      actorInput: Actor | null,
      findingId: string,
      status: "accepted" | "resolved",
      reason: string,
      command: VersionedCommand,
      correlationId = crypto.randomUUID(),
    ) {
      const actor = await requireManager(
        actorInput, "conversion.finding_decision_denied", findingId, correlationId,
      );
      if (!reason.trim()) throw new AuthError(
        "DECISION_REASON_REQUIRED", "Rozhodnutí nálezu vyžaduje odůvodnění.", 400,
      );
      const commandHash = fingerprint({
        operation: "decideFinding",
        findingId,
        status,
        reason: reason.trim(),
        rowVersion: command.rowVersion,
      });
      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${command.idempotencyKey}))`;
        const [finding] = await tx<{
          id: string;
          severity: "info" | "warning" | "blocking";
          current_status: "open" | "accepted" | "resolved";
          version_id: string;
          document_id: string;
          owner_admin_id: string;
          version_status: string;
          row_version: number;
        }[]>`
          select finding.id, finding.severity, finding.status as current_status,
            version.id as version_id, version.document_id, document.owner_admin_id,
            version.status::text as version_status, version.row_version
          from conversion_findings finding
          join conversion_jobs job on job.id=finding.conversion_job_id
          join document_versions version on version.id=job.document_version_id
          join documents document on document.id=version.document_id
          where finding.id=${findingId}
          for update of finding, version, document
        `;
        if (!finding) return { error: new AuthError("NOT_FOUND", "Nález nebyl nalezen.", 404) };
        if (actor.role !== "superadmin" && finding.owner_admin_id !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "conversion.finding_decision_denied",
            targetType: "conversion_finding",
            targetId: findingId,
            correlationId,
            metadata: { reason: "FORBIDDEN" },
          }, "denied");
          return { error: new AuthError(
            "FORBIDDEN", "Administrátor může vypořádat jen nálezy vlastního dokumentu.", 403,
          ) };
        }
        const [prior] = await tx<{ event_type: string; aggregate_id: string; payload: {
          commandHash?: string;
          id?: string;
          status?: "accepted" | "resolved";
          decisionReason?: string;
          rowVersion?: number;
        } }[]>`
          select event_type, aggregate_id::text as aggregate_id, payload
          from outbox_events where idempotency_key=${command.idempotencyKey}
        `;
        if (prior) {
          if (
            prior.event_type === "document.conversion.finding_decided"
            && prior.aggregate_id === finding.version_id
            && prior.payload.commandHash === commandHash
            && prior.payload.id === findingId
            && prior.payload.status
            && prior.payload.decisionReason
            && typeof prior.payload.rowVersion === "number"
          ) return { value: {
            id: prior.payload.id,
            status: prior.payload.status,
            decisionReason: prior.payload.decisionReason,
            rowVersion: prior.payload.rowVersion,
          } };
          return { error: new AuthError(
            "IDEMPOTENCY_CONFLICT",
            "Tento identifikátor požadavku již byl použit pro jinou operaci.",
            409,
          ) };
        }
        if (finding.version_status !== "conversion_review") return {
          error: new AuthError("INVALID_TRANSITION", "Verze není ve stavu kontroly převodu.", 409),
        };
        if (finding.row_version !== command.rowVersion) return {
          error: new AuthError("VERSION_CONFLICT", "Verze byla mezitím změněna.", 409),
        };
        if (finding.severity === "blocking" && status === "accepted") return {
          error: new AuthError(
            "BLOCKING_FINDING_CANNOT_BE_ACCEPTED",
            "Blokující nález musí být vyřešen.",
            409,
          ),
        };
        if (finding.current_status !== "open") return {
          error: new AuthError("FINDING_ALREADY_DECIDED", "Nález již byl vypořádán.", 409),
        };
        await tx`
          update conversion_findings set status=${status}, decided_by_user_id=${actor.userId},
            decision_reason=${reason.trim()}, decided_at=now()
          where id=${findingId} and status='open'
        `;
        const [version] = await tx<{ row_version: number }[]>`
          update document_versions set row_version=row_version+1, updated_at=now()
          where id=${finding.version_id} and row_version=${command.rowVersion}
            and status='conversion_review'
          returning row_version
        `;
        if (!version) throw new AuthError(
          "VERSION_CONFLICT", "Verze byla mezitím změněna.", 409,
        );
        await appendAudit(tx, {
          actor,
          action: "conversion.finding_decided",
          targetType: "conversion_finding",
          targetId: findingId,
          correlationId,
          metadata: { status, versionId: finding.version_id },
        }, "allowed");
        const value = {
          id: findingId,
          status,
          decisionReason: reason.trim(),
          rowVersion: version.row_version,
        };
        await appendOutbox(tx, {
          eventType: "document.conversion.finding_decided",
          aggregateType: "document_version",
          aggregateId: finding.version_id,
          idempotencyKey: command.idempotencyKey,
          payload: { ...value, commandHash },
        });
        return { value };
      });
      if ("error" in result) throw result.error;
      return result.value;
    },

    async completeReview(
      actorInput: Actor | null,
      versionId: string,
      command: VersionedCommand,
      correlationId = crypto.randomUUID(),
    ) {
      const actor = await requireManager(
        actorInput, "conversion.review_completion_denied", versionId, correlationId,
      );
      const commandHash = fingerprint({
        operation: "completeReview",
        versionId,
        rowVersion: command.rowVersion,
      });
      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${command.idempotencyKey}))`;
        const review = await findConversionReview(tx, versionId, true);
        if (!review) return { error: new AuthError("NOT_FOUND", "Verze nebyla nalezena.", 404) };
        if (actor.role !== "superadmin" && review.ownerAdminId !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "conversion.review_completion_denied",
            targetType: "document_version",
            targetId: versionId,
            correlationId,
            metadata: { reason: "FORBIDDEN" },
          }, "denied");
          return { error: new AuthError(
            "FORBIDDEN", "Administrátor může kontrolovat jen vlastní dokumenty.", 403,
          ) };
        }
        const [prior] = await tx<{
          event_type: string;
          aggregate_id: string;
          payload: { commandHash?: string };
        }[]>`
          select event_type, aggregate_id::text as aggregate_id, payload
          from outbox_events where idempotency_key=${command.idempotencyKey}
        `;
        if (prior) {
          if (
            prior.event_type === "document.conversion.ready"
            && prior.aggregate_id === versionId
            && prior.payload.commandHash === commandHash
            && review.versionStatus === "ready"
            && review.reviewCompletedAt
          ) {
            return { value: {
              id: versionId,
              documentId: review.documentId,
              status: "ready" as const,
              rowVersion: review.rowVersion,
              reviewCompletedAt: review.reviewCompletedAt,
            } };
          }
          return { error: new AuthError(
            "IDEMPOTENCY_CONFLICT",
            "Tento identifikátor požadavku již byl použit pro jinou operaci.",
            409,
          ) };
        }
        if (review.rowVersion !== command.rowVersion) return {
          error: new AuthError("VERSION_CONFLICT", "Verze byla mezitím změněna.", 409),
        };
        if (
          review.versionStatus !== "conversion_review"
          || review.documentStatus !== "conversion_review"
        ) return {
          error: new AuthError("INVALID_TRANSITION", "Verze není ve stavu kontroly převodu.", 409),
        };
        const failures = readinessFailures(review.readiness);
        if (failures.length) return {
          error: new AuthError(
            "VERSION_NOT_READY",
            failures.map((failure) => failure.message).join(" "),
            409,
          ),
        };
        const [updatedDocument] = await tx<{ id: string }[]>`
          update documents set status='ready', row_version=row_version+1, updated_at=now()
          where id=${review.documentId} and status='conversion_review'
          returning id
        `;
        if (!updatedDocument) return {
          error: new AuthError("INVALID_TRANSITION", "Dokument již není ve stavu kontroly převodu.", 409),
        };
        const [updated] = await tx<{ row_version: number; review_completed_at: Date }[]>`
          update document_versions set status='ready', review_completed_by_user_id=${actor.userId},
            review_completed_at=now(), row_version=row_version+1, updated_at=now()
          where id=${versionId} and row_version=${command.rowVersion} and status='conversion_review'
          returning row_version, review_completed_at
        `;
        if (!updated) throw new AuthError(
          "VERSION_CONFLICT", "Verze byla mezitím změněna.", 409,
        );
        await appendAudit(tx, {
          actor,
          action: "conversion.review_completed",
          targetType: "document_version",
          targetId: versionId,
          correlationId,
          metadata: { documentId: review.documentId },
        }, "allowed");
        await appendOutbox(tx, {
          eventType: "document.conversion.ready",
          aggregateType: "document_version",
          aggregateId: versionId,
          idempotencyKey: command.idempotencyKey,
          payload: { documentId: review.documentId, versionId, commandHash },
        });
        return {
          value: {
            id: versionId,
            documentId: review.documentId,
            status: "ready" as const,
            rowVersion: updated.row_version,
            reviewCompletedAt: updated.review_completed_at.toISOString(),
          },
        };
      });
      if ("error" in result) throw result.error;
      return result.value;
    },
  };
}

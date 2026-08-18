import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Actor, BlockMappingRun } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { AuthError, unauthenticated } from "../identity/auth-errors";
import { appendOutbox } from "../outbox/outbox-writer";
import { uuidV7 } from "../shared/uuid-v7";
import { matchBlocks } from "./block-matcher";
import {
  findMappingRun,
  findMappingForDecision,
  findLatestRunForTarget,
  findPreviousReadyVersion,
  findRunByIdempotencyKey,
  findRunByVersionPair,
  findVersionPair,
  listMatchableBlocks,
} from "./versioning-repository";

function commandHash(input: object): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createVersioningService({ sql }: { sql: Sql }) {
  return {
    async getMappings(
      actor: Actor | null,
      targetVersionId: string,
      correlationId = crypto.randomUUID(),
    ): Promise<BlockMappingRun> {
      if (!actor) {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_read_denied",
          targetType: "document_version",
          targetId: targetVersionId,
          correlationId,
        });
        throw unauthenticated();
      }
      if (actor.role !== "admin" && actor.role !== "superadmin") {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_read_denied",
          targetType: "document_version",
          targetId: targetVersionId,
          correlationId,
        });
        throw new AuthError("FORBIDDEN", "Mapování verzí smí číst jen administrátor.", 403);
      }
      const run = await findLatestRunForTarget(sql, targetVersionId);
      if (!run) throw new AuthError("NOT_FOUND", "Mapování verze nebylo nalezeno.", 404);
      if (actor.role !== "superadmin" && run.owner_admin_id !== actor.userId) {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_read_denied",
          targetType: "document_version",
          targetId: targetVersionId,
          correlationId,
        });
        throw new AuthError(
          "FORBIDDEN",
          "Administrátor může číst jen mapování vlastního dokumentu.",
          403,
        );
      }
      const view = await findMappingRun(sql, run.id);
      if (!view) throw new Error("Mapping run disappeared during read");
      return view;
    },

    async generateMappings(
      actor: Actor | null,
      input: {
        sourceVersionId: string;
        targetVersionId: string;
        idempotencyKey: string;
      },
      correlationId = crypto.randomUUID(),
    ): Promise<BlockMappingRun> {
      if (!actor) {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_generation_denied",
          targetType: "document_version",
          targetId: input.targetVersionId,
          correlationId,
        });
        throw unauthenticated();
      }
      if (actor.role !== "admin" && actor.role !== "superadmin") {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_generation_denied",
          targetType: "document_version",
          targetId: input.targetVersionId,
          correlationId,
        });
        throw new AuthError("FORBIDDEN", "Mapování verzí smí spravovat jen administrátor.", 403);
      }

      const fingerprint = commandHash({
        operation: "generateMappings",
        sourceVersionId: input.sourceVersionId,
        targetVersionId: input.targetVersionId,
      });
      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const pair = await findVersionPair(tx, input.sourceVersionId, input.targetVersionId);
        if (!pair) {
          await appendAudit(tx, {
            actor,
            action: "versioning.mapping_generation_denied",
            targetType: "document_version",
            targetId: input.targetVersionId,
            correlationId,
            metadata: { reason: "VERSION_PAIR_INVALID" },
          }, "denied");
          return { error: new AuthError(
            "VERSION_PAIR_INVALID",
            "Zdrojová a cílová verze musí patřit stejnému dokumentu.",
            409,
          ) } as const;
        }
        if (actor.role !== "superadmin" && pair.owner_admin_id !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "versioning.mapping_generation_denied",
            targetType: "document_version",
            targetId: input.targetVersionId,
            correlationId,
            metadata: { reason: "FORBIDDEN" },
          }, "denied");
          return { error: new AuthError(
            "FORBIDDEN",
            "Administrátor může mapovat jen verze vlastního dokumentu.",
            403,
          ) } as const;
        }
        if (pair.source_version_number >= pair.target_version_number) return {
          error: new AuthError(
            "VERSION_ORDER_INVALID",
            "Cílová verze musí být novější než zdrojová.",
            409,
          ),
        } as const;
        if (pair.source_status !== "ready") return {
          error: new AuthError(
            "SOURCE_VERSION_NOT_READY",
            "Zdrojová verze není připravena k mapování.",
            409,
          ),
        } as const;
        if (pair.target_status !== "ready") return {
          error: new AuthError(
            "TARGET_VERSION_NOT_READY",
            "Cílová verze není připravena k mapování.",
            409,
          ),
        } as const;

        const prior = await findRunByIdempotencyKey(tx, input.idempotencyKey);
        if (prior) {
          if (prior.command_hash !== fingerprint) return {
            error: new AuthError(
              "IDEMPOTENCY_CONFLICT",
              "Identifikátor požadavku již byl použit pro jinou operaci.",
              409,
            ),
          } as const;
          const replay = await findMappingRun(tx, prior.id);
          if (!replay) throw new Error("Idempotent mapping run is missing");
          await appendAudit(tx, {
            actor,
            action: "versioning.mapping_generated",
            targetType: "block_mapping_run",
            targetId: prior.id,
            correlationId,
            metadata: { idempotentReplay: true },
          }, "allowed");
          return { value: replay } as const;
        }

        await tx`select pg_advisory_xact_lock(hashtext(
          ${`${input.sourceVersionId}:${input.targetVersionId}:block-map-v1`}
        ))`;
        const equivalent = await findRunByVersionPair(
          tx,
          input.sourceVersionId,
          input.targetVersionId,
          "block-map-v1",
        );
        if (equivalent) {
          const replay = await findMappingRun(tx, equivalent.id);
          if (!replay) throw new Error("Equivalent mapping run is missing");
          await appendAudit(tx, {
            actor,
            action: "versioning.mapping_generated",
            targetType: "block_mapping_run",
            targetId: equivalent.id,
            correlationId,
            metadata: { equivalentReplay: true },
          }, "allowed");
          return { value: replay } as const;
        }

        const [source, target] = await Promise.all([
          listMatchableBlocks(tx, input.sourceVersionId),
          listMatchableBlocks(tx, input.targetVersionId),
        ]);
        const matched = matchBlocks({ source, target });
        const runId = uuidV7();
        const status = matched.mappings.some((mapping) => mapping.reviewStatus === "needs_review")
          ? "review_required"
          : "confirmed";
        await tx`
          insert into block_mapping_runs (
            id, document_id, source_version_id, target_version_id,
            algorithm_version, status, idempotency_key, command_hash,
            created_by_user_id
          ) values (
            ${runId}, ${pair.document_id}, ${input.sourceVersionId}, ${input.targetVersionId},
            ${matched.algorithmVersion}, ${status}, ${input.idempotencyKey},
            ${fingerprint}, ${actor.userId}
          )
        `;
        for (const mapping of matched.mappings) {
          const mappingId = uuidV7();
          await tx`
            insert into block_mappings (
              id, run_id, source_block_revision_id, target_block_revision_id,
              relation, confidence, method, review_status
            ) values (
              ${mappingId}, ${runId}, ${mapping.sourceRevisionIds[0] ?? null},
              ${mapping.targetRevisionIds[0] ?? null}, ${mapping.relation},
              ${mapping.confidence}, ${mapping.method}, ${mapping.reviewStatus}
            )
          `;
          const sourceRevisionId = mapping.sourceRevisionIds[0];
          if (sourceRevisionId) {
            const threads = await tx<{ id: string }[]>`
              select id from comment_threads
              where target_block_revision_id = ${sourceRevisionId}
              order by id
            `;
            const projectionStatus = mapping.reviewStatus === "needs_review"
              ? "needs_review"
              : mapping.relation === "removed" ? "no_target" : "auto_projected";
            const targetRevisionId = projectionStatus === "no_target"
              ? null
              : mapping.targetRevisionIds[0] ?? null;
            for (const thread of threads) {
              await tx`
                insert into thread_version_projections (
                  id, thread_id, mapping_id, source_block_revision_id,
                  target_document_version_id, target_block_revision_id, status
                ) values (
                  ${uuidV7()}, ${thread.id}, ${mappingId}, ${sourceRevisionId},
                  ${input.targetVersionId}, ${targetRevisionId}, ${projectionStatus}
                )
              `;
            }
          }
        }
        await appendOutbox(tx, {
          eventType: "document.version_mappings.generated",
          aggregateType: "document_version",
          aggregateId: input.targetVersionId,
          idempotencyKey: input.idempotencyKey,
          payload: { runId, sourceVersionId: input.sourceVersionId, algorithmVersion: matched.algorithmVersion },
        });
        await appendAudit(tx, {
          actor,
          action: "versioning.mapping_generated",
          targetType: "block_mapping_run",
          targetId: runId,
          correlationId,
          metadata: { documentId: pair.document_id, status, mappingCount: matched.mappings.length },
        }, "allowed");
        const view = await findMappingRun(tx, runId);
        if (!view) throw new Error("Created mapping run is missing");
        return { value: view } as const;
      });
      if ("error" in result) throw result.error;
      return result.value;
    },

    async generateMappingsFromPreviousVersion(
      actor: Actor | null,
      targetVersionId: string,
      idempotencyKey: string,
      correlationId = crypto.randomUUID(),
    ): Promise<BlockMappingRun | null> {
      if (!actor) {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_generation_denied",
          targetType: "document_version",
          targetId: targetVersionId,
          correlationId,
        });
        throw unauthenticated();
      }
      if (actor.role !== "admin" && actor.role !== "superadmin") {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_generation_denied",
          targetType: "document_version",
          targetId: targetVersionId,
          correlationId,
        });
        throw new AuthError("FORBIDDEN", "Mapování verzí smí spravovat jen administrátor.", 403);
      }
      const previous = await findPreviousReadyVersion(sql, targetVersionId);
      if (!previous) throw new AuthError("NOT_FOUND", "Cílová verze nebyla nalezena.", 404);
      if (actor.role !== "superadmin" && previous.owner_admin_id !== actor.userId) {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_generation_denied",
          targetType: "document_version",
          targetId: targetVersionId,
          correlationId,
        });
        throw new AuthError(
          "FORBIDDEN",
          "Administrátor může mapovat jen verze vlastního dokumentu.",
          403,
        );
      }
      if (previous.target_status !== "ready") throw new AuthError(
        "TARGET_VERSION_NOT_READY",
        "Cílová verze není připravena k mapování.",
        409,
      );
      if (!previous.source_version_id) {
        await appendAudit(sql, {
          actor,
          action: "versioning.mapping_skipped",
          targetType: "document_version",
          targetId: targetVersionId,
          correlationId,
          metadata: { reason: "FIRST_READY_VERSION" },
        }, "allowed");
        return null;
      }
      return this.generateMappings(actor, {
        sourceVersionId: previous.source_version_id,
        targetVersionId,
        idempotencyKey,
      }, correlationId);
    },

    async decideMapping(
      actor: Actor | null,
      mappingId: string,
      input: {
        decision: "confirm" | "reject";
        reason: string;
        rowVersion: number;
        idempotencyKey: string;
      },
      correlationId = crypto.randomUUID(),
    ): Promise<BlockMappingRun> {
      if (!actor) {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_decision_denied",
          targetType: "block_mapping",
          targetId: mappingId,
          correlationId,
        });
        throw unauthenticated();
      }
      if (actor.role !== "admin" && actor.role !== "superadmin") {
        await appendDeniedAudit(sql, {
          actor,
          action: "versioning.mapping_decision_denied",
          targetType: "block_mapping",
          targetId: mappingId,
          correlationId,
        });
        throw new AuthError("FORBIDDEN", "Mapování smí potvrdit jen administrátor.", 403);
      }
      if (!input.reason.trim()) throw new AuthError(
        "DECISION_REASON_REQUIRED",
        "Rozhodnutí mapování vyžaduje odůvodnění.",
        400,
      );
      const fingerprint = commandHash({
        operation: "decideMapping",
        mappingId,
        decision: input.decision,
        reason: input.reason.trim(),
        rowVersion: input.rowVersion,
      });
      const result = await withTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`;
        const [prior] = await tx<{
          event_type: string;
          aggregate_id: string;
          payload: { commandHash?: string; runId?: string };
        }[]>`
          select event_type, aggregate_id::text as aggregate_id, payload
          from outbox_events where idempotency_key = ${input.idempotencyKey}
        `;
        if (prior) {
          if (
            prior.event_type !== "document.version_mapping.decided"
            || prior.aggregate_id !== mappingId
            || prior.payload.commandHash !== fingerprint
            || !prior.payload.runId
          ) return { error: new AuthError(
            "IDEMPOTENCY_CONFLICT",
            "Identifikátor požadavku již byl použit pro jinou operaci.",
            409,
          ) } as const;
          const replay = await findMappingRun(tx, prior.payload.runId);
          if (!replay) throw new Error("Idempotent mapping decision is missing");
          return { value: replay } as const;
        }

        const mapping = await findMappingForDecision(tx, mappingId);
        if (!mapping) return {
          error: new AuthError("NOT_FOUND", "Mapování nebylo nalezeno.", 404),
        } as const;
        if (actor.role !== "superadmin" && mapping.owner_admin_id !== actor.userId) {
          await appendAudit(tx, {
            actor,
            action: "versioning.mapping_decision_denied",
            targetType: "block_mapping",
            targetId: mappingId,
            correlationId,
            metadata: { reason: "FORBIDDEN" },
          }, "denied");
          return { error: new AuthError(
            "FORBIDDEN",
            "Administrátor může rozhodnout jen mapování vlastního dokumentu.",
            403,
          ) } as const;
        }
        if (mapping.row_version !== input.rowVersion) return {
          error: new AuthError("VERSION_CONFLICT", "Mapování bylo mezitím změněno.", 409),
        } as const;
        if (mapping.review_status !== "needs_review") return {
          error: new AuthError("MAPPING_ALREADY_DECIDED", "Mapování již bylo rozhodnuto.", 409),
        } as const;

        const nextStatus = input.decision === "confirm" ? "confirmed" : "rejected";
        await tx`
          update block_mappings set review_status = ${nextStatus},
            confirmed_by_user_id = ${actor.userId}, decision_reason = ${input.reason.trim()},
            decided_at = now(), row_version = row_version + 1, updated_at = now()
          where id = ${mappingId} and row_version = ${input.rowVersion}
        `;

        if (mapping.source_block_revision_id) {
          const threads = await tx<{ id: string }[]>`
            select id from comment_threads
            where target_block_revision_id = ${mapping.source_block_revision_id}
            order by id
          `;
          for (const thread of threads) {
            await tx`
              update thread_version_projections set superseded_at = now(),
                row_version = row_version + 1, updated_at = now()
              where thread_id = ${thread.id}
                and target_document_version_id = ${mapping.target_version_id}
                and superseded_at is null
            `;
            await tx`
              insert into thread_version_projections (
                id, thread_id, mapping_id, source_block_revision_id,
                target_document_version_id, target_block_revision_id, status,
                decided_by_user_id, decision_reason, decided_at
              ) values (
                ${uuidV7()}, ${thread.id}, ${mappingId}, ${mapping.source_block_revision_id},
                ${mapping.target_version_id},
                ${input.decision === "confirm" ? mapping.target_block_revision_id : null},
                ${input.decision === "confirm" ? "confirmed" : "no_target"},
                ${actor.userId}, ${input.reason.trim()}, now()
              )
            `;
          }
        }

        const [{ pending }] = await tx<{ pending: boolean }[]>`
          select exists(
            select 1 from block_mappings
            where run_id = ${mapping.run_id} and review_status = 'needs_review'
          ) as pending
        `;
        const [updatedRun] = await tx<{ row_version: number }[]>`
          update block_mapping_runs set status = ${pending ? "review_required" : "confirmed"},
            row_version = row_version + 1, updated_at = now()
          where id = ${mapping.run_id} and row_version = ${mapping.run_row_version}
          returning row_version
        `;
        if (!updatedRun) throw new AuthError(
          "VERSION_CONFLICT",
          "Mapovací běh byl mezitím změněn.",
          409,
        );
        await appendAudit(tx, {
          actor,
          action: "versioning.mapping_decided",
          targetType: "block_mapping",
          targetId: mappingId,
          correlationId,
          metadata: { decision: input.decision, runId: mapping.run_id },
        }, "allowed");
        await appendOutbox(tx, {
          eventType: "document.version_mapping.decided",
          aggregateType: "block_mapping",
          aggregateId: mappingId,
          idempotencyKey: input.idempotencyKey,
          payload: { commandHash: fingerprint, runId: mapping.run_id, decision: input.decision },
        });
        const view = await findMappingRun(tx, mapping.run_id);
        if (!view) throw new Error("Updated mapping run is missing");
        return { value: view } as const;
      });
      if ("error" in result) throw result.error;
      return result.value;
    },
  };
}

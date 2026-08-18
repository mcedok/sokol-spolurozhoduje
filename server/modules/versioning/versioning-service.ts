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
          await tx`
            insert into block_mappings (
              id, run_id, source_block_revision_id, target_block_revision_id,
              relation, confidence, method, review_status
            ) values (
              ${uuidV7()}, ${runId}, ${mapping.sourceRevisionIds[0] ?? null},
              ${mapping.targetRevisionIds[0] ?? null}, ${mapping.relation},
              ${mapping.confidence}, ${mapping.method}, ${mapping.reviewStatus}
            )
          `;
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
  };
}

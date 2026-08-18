import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../contracts";
import * as contracts from "../../contracts";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  seedActiveMember,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase, 30_000);

async function loadService() {
  const modulePath = "../../server/modules/versioning/versioning-service";
  return import(modulePath) as Promise<{
    createVersioningService(input: { sql: typeof testSql }): {
      decideMapping(
        actor: Actor | null,
        mappingId: string,
        input: {
          decision: "confirm" | "reject";
          reason: string;
          rowVersion: number;
          idempotencyKey: string;
        },
        correlationId?: string,
      ): Promise<{
        id: string;
        status: string;
        rowVersion: number;
        mappings: Array<{ id: string; reviewStatus: string }>;
      }>;
    };
  }>;
}

async function seedReviewRequiredMapping(relation = "modified") {
  const admin = await seedActiveAdmin();
  const member = await seedActiveMember();
  const documentId = crypto.randomUUID();
  const sourceVersionId = crypto.randomUUID();
  const targetVersionId = crypto.randomUUID();
  const sourceBlockUid = crypto.randomUUID();
  const targetBlockUid = crypto.randomUUID();
  const sourceRevisionId = crypto.randomUUID();
  const targetRevisionId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();

  await testSql`
    insert into documents (id, number, title, owner_admin_id, status)
    values (${documentId}, 'SOKOL-2026-920', 'Norma s připomínkou', ${admin.id}, 'ready')
  `;
  await testSql`
    insert into document_versions (
      id, document_id, version_number, status, created_by_user_id, review_completed_at
    ) values
      (${sourceVersionId}, ${documentId}, 1, 'ready', ${admin.id}, now()),
      (${targetVersionId}, ${documentId}, 2, 'ready', ${admin.id}, now())
  `;
  await testSql`
    insert into document_blocks (block_uid, document_id)
    values (${sourceBlockUid}, ${documentId}), (${targetBlockUid}, ${documentId})
  `;
  await testSql`
    insert into block_revisions (
      block_revision_id, block_uid, document_version_id, block_order,
      block_type, structured_content, plain_text, normalized_hash,
      parser_version, revision_origin
    ) values
      (${sourceRevisionId}, ${sourceBlockUid}, ${sourceVersionId}, 0,
        'paragraph', '{}', 'Původní text.', ${"a".repeat(64)}, 'test', 'converted'),
      (${targetRevisionId}, ${targetBlockUid}, ${targetVersionId}, 0,
        'paragraph', '{}', 'Možný nový text.', ${"b".repeat(64)}, 'test', 'converted')
  `;
  await testSql`
    insert into comment_threads (
      id, public_id, document_id, block_uid, target_block_revision_id,
      created_by_user_id
    ) values (
      ${threadId}, 'VLAK-2026-000920', ${documentId}, ${sourceBlockUid},
      ${sourceRevisionId}, ${member.id}
    )
  `;
  await testSql`
    insert into comments (
      id, public_id, thread_id, author_user_id, author_name_snapshot,
      organization_name_snapshot, body, comment_type
    ) values (
      ${commentId}, 'PRIP-2026-000920', ${threadId}, ${member.id},
      'Jan Člen', 'TJ Sokol Test', 'Připomínka ke znění.', 'comment'
    )
  `;
  await testSql`
    insert into block_mapping_runs (
      id, document_id, source_version_id, target_version_id, algorithm_version,
      status, idempotency_key, command_hash, created_by_user_id
    ) values (
      ${runId}, ${documentId}, ${sourceVersionId}, ${targetVersionId}, 'block-map-v1',
      'review_required', ${crypto.randomUUID()}, ${"d".repeat(64)}, ${admin.id}
    )
  `;
  await testSql`
    insert into block_mappings (
      id, run_id, source_block_revision_id, target_block_revision_id,
      relation, confidence, method, review_status
    ) values (
      ${mappingId}, ${runId}, ${sourceRevisionId}, ${targetRevisionId},
      ${relation}, 0.75, 'text_similarity', 'needs_review'
    )
  `;

  return {
    admin,
    documentId,
    sourceVersionId,
    targetVersionId,
    sourceRevisionId,
    targetRevisionId,
    threadId,
    commentId,
    runId,
    mappingId,
  };
}

describe("version mapping review and comment projection", () => {
  it("publishes a strict projection contract and creates its table", async () => {
    expect(contracts).toHaveProperty("threadVersionProjectionSchema");
    const expected = ["thread_version_projections"];
    const rows = await testSql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = any(${expected})
    `;
    expect(rows.map((row) => row.table_name)).toEqual(expected);
  });

  it("confirms an unclear mapping and projects the thread without changing its source", async () => {
    const seeded = await seedReviewRequiredMapping();
    const actor: Actor = {
      userId: seeded.admin.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    };
    const { createVersioningService } = await loadService();
    const service = createVersioningService({ sql: testSql });

    const run = await service.decideMapping(actor, seeded.mappingId, {
      decision: "confirm",
      reason: "Obsahově jde o pokračování stejného ustanovení.",
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(run).toMatchObject({
      id: seeded.runId,
      status: "confirmed",
      rowVersion: 2,
      mappings: [{ id: seeded.mappingId, reviewStatus: "confirmed" }],
    });
    const [projection] = await testSql<{
      thread_id: string;
      source_block_revision_id: string;
      target_document_version_id: string;
      target_block_revision_id: string;
      status: string;
    }[]>`
      select thread_id, source_block_revision_id, target_document_version_id,
        target_block_revision_id, status
      from thread_version_projections
      where thread_id = ${seeded.threadId} and superseded_at is null
    `;
    expect(projection).toEqual({
      thread_id: seeded.threadId,
      source_block_revision_id: seeded.sourceRevisionId,
      target_document_version_id: seeded.targetVersionId,
      target_block_revision_id: seeded.targetRevisionId,
      status: "confirmed",
    });
    const [thread] = await testSql<{ target_block_revision_id: string }[]>`
      select target_block_revision_id from comment_threads where id = ${seeded.threadId}
    `;
    expect(thread.target_block_revision_id).toBe(seeded.sourceRevisionId);
  });

  it("requires a reason and rejects stale mapping decisions", async () => {
    const seeded = await seedReviewRequiredMapping();
    const actor: Actor = {
      userId: seeded.admin.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    };
    const { createVersioningService } = await loadService();
    const service = createVersioningService({ sql: testSql });

    await expect(service.decideMapping(actor, seeded.mappingId, {
      decision: "confirm",
      reason: " ",
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "DECISION_REASON_REQUIRED", status: 400 });

    await expect(service.decideMapping(actor, seeded.mappingId, {
      decision: "confirm",
      reason: "Potvrzeno po kontrole.",
      rowVersion: 99,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("keeps a split mapping pending until the administrator explicitly confirms it", async () => {
    const seeded = await seedReviewRequiredMapping("split");
    const actor: Actor = {
      userId: seeded.admin.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    };
    const { createVersioningService } = await loadService();
    const service = createVersioningService({ sql: testSql });

    const [before] = await testSql<{ status: string }[]>`
      select status from block_mapping_runs where id = ${seeded.runId}
    `;
    expect(before.status).toBe("review_required");

    const run = await service.decideMapping(actor, seeded.mappingId, {
      decision: "confirm",
      reason: "Připomínky se přenášejí na hlavní pokračující blok.",
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(run).toMatchObject({
      status: "confirmed",
      mappings: [{ relation: "split", reviewStatus: "confirmed" }],
    });
  });
});

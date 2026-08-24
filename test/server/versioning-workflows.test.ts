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
      generateMappingsFromPreviousVersion(
        actor: Actor | null,
        targetVersionId: string,
        idempotencyKey: string,
        correlationId?: string,
      ): Promise<{
        id: string;
        sourceVersionId: string;
        targetVersionId: string;
      } | null>;
      generateMappings(
        actor: Actor | null,
        input: {
          sourceVersionId: string;
          targetVersionId: string;
          idempotencyKey: string;
        },
        correlationId?: string,
      ): Promise<{
        id: string;
        documentId: string;
        sourceVersionId: string;
        targetVersionId: string;
        algorithmVersion: string;
        status: string;
        rowVersion: number;
        mappings: Array<{ relation: string; reviewStatus: string }>;
      }>;
    };
  }>;
}

async function seedVersionPair() {
  const owner = await seedActiveAdmin();
  const documentId = crypto.randomUUID();
  const sourceVersionId = crypto.randomUUID();
  const targetVersionId = crypto.randomUUID();
  const sourceBlockUid = crypto.randomUUID();
  const targetBlockUid = crypto.randomUUID();
  const sourceRevisionId = crypto.randomUUID();
  const targetRevisionId = crypto.randomUUID();

  await testSql`
    insert into documents (id, number, title, owner_admin_id, status)
    values (${documentId}, 'SOKOL-2026-910', 'Verzovaná norma', ${owner.id}, 'ready')
  `;
  await testSql`
    insert into document_versions (
      id, document_id, version_number, status, created_by_user_id, review_completed_at
    ) values
      (${sourceVersionId}, ${documentId}, 1, 'ready', ${owner.id}, now()),
      (${targetVersionId}, ${documentId}, 2, 'ready', ${owner.id}, now())
  `;
  await testSql`
    insert into document_blocks (block_uid, document_id, source_para_id)
    values
      (${sourceBlockUid}, ${documentId}, 'para-1'),
      (${targetBlockUid}, ${documentId}, 'para-1')
  `;
  await testSql`
    insert into block_revisions (
      block_revision_id, block_uid, document_version_id, block_order,
      block_type, structured_content, plain_text, normalized_hash,
      parser_version, revision_origin
    ) values
      (
        ${sourceRevisionId}, ${sourceBlockUid}, ${sourceVersionId}, 0,
        'paragraph', '{}', 'Původní znění.', ${"a".repeat(64)}, 'test', 'converted'
      ),
      (
        ${targetRevisionId}, ${targetBlockUid}, ${targetVersionId}, 0,
        'paragraph', '{}', 'Upravené znění.', ${"b".repeat(64)}, 'test', 'converted'
      )
  `;

  return {
    owner,
    documentId,
    sourceVersionId,
    targetVersionId,
    sourceBlockUid,
    targetBlockUid,
    sourceRevisionId,
    targetRevisionId,
  };
}

describe("document version mapping workflows", () => {
  it("publishes a strict mapping run contract", () => {
    expect(contracts).toHaveProperty("blockMappingRunSchema");
    const schema = Reflect.get(contracts, "blockMappingRunSchema") as {
      parse(input: unknown): Record<string, unknown>;
    };
    const valid = {
      id: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      sourceVersionId: crypto.randomUUID(),
      targetVersionId: crypto.randomUUID(),
      algorithmVersion: "block-map-v1",
      status: "confirmed",
      rowVersion: 1,
      mappings: [],
    };
    expect(schema.parse(valid)).toEqual(valid);
    expect(() => schema.parse({ ...valid, objectKey: "private/path" })).toThrow();
  });

  it("creates mapping run tables with immutable version endpoints", async () => {
    const expected = ["block_mapping_runs", "block_mappings"];
    const rows = await testSql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = any(${expected})
      order by table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual(expected);
  });

  it("maps two ready versions once and replays the same command", async () => {
    const seeded = await seedVersionPair();
    const actor: Actor = {
      userId: seeded.owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    };
    const { createVersioningService } = await loadService();
    const service = createVersioningService({ sql: testSql });
    const idempotencyKey = crypto.randomUUID();

    const first = await service.generateMappings(actor, {
      sourceVersionId: seeded.sourceVersionId,
      targetVersionId: seeded.targetVersionId,
      idempotencyKey,
    });
    const replay = await service.generateMappings(actor, {
      sourceVersionId: seeded.sourceVersionId,
      targetVersionId: seeded.targetVersionId,
      idempotencyKey,
    });

    expect(first).toMatchObject({
      documentId: seeded.documentId,
      sourceVersionId: seeded.sourceVersionId,
      targetVersionId: seeded.targetVersionId,
      algorithmVersion: "block-map-v1",
      status: "confirmed",
      rowVersion: 1,
      mappings: [{ relation: "modified", reviewStatus: "auto_confirmed" }],
    });
    expect(replay).toEqual(first);
    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count from block_mapping_runs
    `;
    expect(count).toBe(1);
  });

  it("selects the immediately previous ready version automatically", async () => {
    const seeded = await seedVersionPair();
    const actor: Actor = {
      userId: seeded.owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    };
    const { createVersioningService } = await loadService();
    const service = createVersioningService({ sql: testSql });

    const run = await service.generateMappingsFromPreviousVersion(
      actor,
      seeded.targetVersionId,
      crypto.randomUUID(),
    );

    expect(run).toMatchObject({
      sourceVersionId: seeded.sourceVersionId,
      targetVersionId: seeded.targetVersionId,
    });
  });
  it("reuses the deterministic run when the same version pair arrives with a new key", async () => {
    const seeded = await seedVersionPair();
    const actor: Actor = {
      userId: seeded.owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    };
    const { createVersioningService } = await loadService();
    const service = createVersioningService({ sql: testSql });
    const input = {
      sourceVersionId: seeded.sourceVersionId,
      targetVersionId: seeded.targetVersionId,
    };

    const first = await service.generateMappings(actor, {
      ...input,
      idempotencyKey: crypto.randomUUID(),
    });
    const repeated = await service.generateMappings(actor, {
      ...input,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(repeated.id).toBe(first.id);
    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count from block_mapping_runs
    `;
    expect(count).toBe(1);
  });

  it("automatically projects a thread through an unambiguous mapping", async () => {
    const seeded = await seedVersionPair();
    const member = await seedActiveMember();
    const threadId = crypto.randomUUID();
    await testSql`
      insert into comment_threads (
        id, public_id, document_id, block_uid, target_block_revision_id,
        created_by_user_id
      ) values (
        ${threadId}, 'VLAK-2026-000911', ${seeded.documentId},
        ${seeded.sourceBlockUid}, ${seeded.sourceRevisionId}, ${member.id}
      )
    `;
    const { createVersioningService } = await loadService();
    const service = createVersioningService({ sql: testSql });

    await service.generateMappings({
      userId: seeded.owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    }, {
      sourceVersionId: seeded.sourceVersionId,
      targetVersionId: seeded.targetVersionId,
      idempotencyKey: crypto.randomUUID(),
    });

    const [projection] = await testSql<{
      target_block_revision_id: string;
      status: string;
    }[]>`
      select target_block_revision_id, status
      from thread_version_projections
      where thread_id = ${threadId} and superseded_at is null
    `;
    expect(projection).toEqual({
      target_block_revision_id: seeded.targetRevisionId,
      status: "auto_projected",
    });
  });

  it("denies a foreign administrator and audits the attempt", async () => {
    const seeded = await seedVersionPair();
    const foreign = await seedActiveAdmin();
    const { createVersioningService } = await loadService();
    const service = createVersioningService({ sql: testSql });

    await expect(service.generateMappings(
      { userId: foreign.id, role: "admin", sessionId: crypto.randomUUID() },
      {
        sourceVersionId: seeded.sourceVersionId,
        targetVersionId: seeded.targetVersionId,
        idempotencyKey: crypto.randomUUID(),
      },
      crypto.randomUUID(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const [audit] = await testSql<{ outcome: string; action: string }[]>`
      select outcome, action from audit_events
      where target_id = ${seeded.targetVersionId}
      order by created_at desc limit 1
    `;
    expect(audit).toEqual({
      outcome: "denied",
      action: "versioning.mapping_generation_denied",
    });
  });
});

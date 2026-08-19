import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../contracts";
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
  const modulePath = "../../server/modules/exports/export-service";
  return import(modulePath) as Promise<{
    createExportService(input: { sql: typeof testSql }): {
      createExport(
        actor: Actor | null,
        documentId: string,
        input: {
          documentVersionId: string;
          visibility: "public" | "internal";
          filters?: { statuses?: string[]; priorities?: string[]; types?: string[] };
          options?: {
            includeAuthorEmail?: boolean;
            includeMembershipId?: boolean;
            includeInternalNote?: boolean;
          };
          idempotencyKey: string;
        },
        correlationId?: string,
      ): Promise<{ id: string; status: string; snapshotSha256: string }>;
      getDownloadFileId(
        actor: Actor | null,
        exportJobId: string,
        correlationId?: string,
      ): Promise<string>;
    };
  }>;
}

async function seedExportSource() {
  const owner = await seedActiveAdmin();
  const member = await seedActiveMember();
  await testSql`update users set membership_id = 'CANARY-MEMBER-ID' where id = ${member.id}`;
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const blockUid = crypto.randomUUID();
  const blockRevisionId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  await testSql`
    insert into documents (id, number, title, explanatory_report, owner_admin_id, status)
    values (${documentId}, 'SOKOL-2026-930', 'Exportovaná norma', 'Důvodová zpráva', ${owner.id}, 'ready')
  `;
  await testSql`
    insert into document_versions (
      id, document_id, version_number, status, created_by_user_id, review_completed_at
    ) values (${versionId}, ${documentId}, 1, 'ready', ${owner.id}, now())
  `;
  await testSql`insert into document_blocks (block_uid, document_id) values (${blockUid}, ${documentId})`;
  await testSql`
    insert into block_revisions (
      block_revision_id, block_uid, document_version_id, block_order, block_type,
      structured_content, plain_text, normalized_hash, parser_version, revision_origin
    ) values (
      ${blockRevisionId}, ${blockUid}, ${versionId}, 0, 'paragraph', '{}',
      'Článek první', ${"a".repeat(64)}, 'test', 'converted'
    )
  `;
  await testSql`
    insert into comment_threads (
      id, public_id, document_id, block_uid, target_block_revision_id, created_by_user_id
    ) values (
      ${threadId}, 'VLAK-2026-000930', ${documentId}, ${blockUid}, ${blockRevisionId}, ${member.id}
    )
  `;
  await testSql`
    insert into comments (
      id, public_id, thread_id, author_user_id, author_name_snapshot,
      organization_name_snapshot, body, comment_type, priority, status
    ) values (
      ${commentId}, 'PRIP-2026-000930', ${threadId}, ${member.id}, 'Jan Člen',
      'TJ Sokol Test', 'Navrhuji změnu.', 'proposal', 'high', 'settled'
    )
  `;
  await testSql`
    insert into settlements (
      id, comment_id, outcome, statement, responsible_user_id, settled_by_user_id,
      target_document_version_id, internal_note
    ) values (
      ${crypto.randomUUID()}, ${commentId}, 'accepted', 'Zapracováno.', ${owner.id},
      ${owner.id}, ${versionId}, 'CANARY-INTERNAL-NOTE'
    )
  `;
  return { owner, member, documentId, versionId };
}

describe("PDF export workflows", () => {
  it("creates one immutable public snapshot and replays the same command", async () => {
    const seeded = await seedExportSource();
    const actor: Actor = {
      userId: seeded.owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    };
    const { createExportService } = await loadService();
    const service = createExportService({ sql: testSql });
    const key = crypto.randomUUID();
    const input = {
      documentVersionId: seeded.versionId,
      visibility: "public" as const,
      idempotencyKey: key,
    };

    const first = await service.createExport(actor, seeded.documentId, input);
    const replay = await service.createExport(actor, seeded.documentId, input);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "queued", snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const [stored] = await testSql<{ snapshot: unknown; count: number }[]>`
      select snapshot, count(*) over()::int as count from export_jobs
    `;
    expect(stored.count).toBe(1);
    const serialized = JSON.stringify(stored.snapshot);
    expect(serialized).not.toContain(seeded.member.email);
    expect(serialized).not.toContain("CANARY-MEMBER-ID");
    expect(serialized).not.toContain("CANARY-INTERNAL-NOTE");
  });

  it("rejects a foreign administrator and stale authentication for internal fields", async () => {
    const seeded = await seedExportSource();
    const foreign = await seedActiveAdmin();
    const { createExportService } = await loadService();
    const service = createExportService({ sql: testSql });

    await expect(service.createExport({
      userId: foreign.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    }, seeded.documentId, {
      documentVersionId: seeded.versionId,
      visibility: "public",
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const sessionId = crypto.randomUUID();
    await testSql`
      insert into sessions (id, user_id, token_hash, csrf_hash, expires_at, created_at)
      values (${sessionId}, ${seeded.owner.id}, ${"b".repeat(64)}, ${"c".repeat(64)}, now() + interval '1 day', now() - interval '1 hour')
    `;
    await expect(service.createExport({
      userId: seeded.owner.id,
      role: "admin",
      sessionId,
    }, seeded.documentId, {
      documentVersionId: seeded.versionId,
      visibility: "internal",
      options: { includeAuthorEmail: true },
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "FRESH_AUTHENTICATION_REQUIRED", status: 403 });
  });

  it("requires fresh authentication again before an internal download", async () => {
    const seeded = await seedExportSource();
    const sessionId = crypto.randomUUID();
    await testSql`
      insert into sessions (id, user_id, token_hash, csrf_hash, expires_at, created_at)
      values (${sessionId}, ${seeded.owner.id}, ${"d".repeat(64)}, ${"e".repeat(64)},
        now() + interval '1 day', now())
    `;
    const actor: Actor = { userId: seeded.owner.id, role: "admin", sessionId };
    const { createExportService } = await loadService();
    const service = createExportService({ sql: testSql });
    const job = await service.createExport(actor, seeded.documentId, {
      documentVersionId: seeded.versionId,
      visibility: "internal",
      options: { includeAuthorEmail: true },
      idempotencyKey: crypto.randomUUID(),
    });
    await testSql`update sessions set created_at=now() - interval '1 hour' where id=${sessionId}`;

    await expect(service.getDownloadFileId(actor, job.id)).rejects.toMatchObject({
      code: "FRESH_AUTHENTICATION_REQUIRED",
      status: 403,
    });
  });

  it("audits a foreign administrator denied access to a download", async () => {
    const seeded = await seedExportSource();
    const ownerActor: Actor = {
      userId: seeded.owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    };
    const foreign = await seedActiveAdmin();
    const { createExportService } = await loadService();
    const service = createExportService({ sql: testSql });
    const job = await service.createExport(ownerActor, seeded.documentId, {
      documentVersionId: seeded.versionId,
      visibility: "public",
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(service.getDownloadFileId({
      userId: foreign.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    }, job.id, "0198f413-2a36-7000-8000-000000000399")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    const [audit] = await testSql<{ outcome: string; action: string; metadata: unknown }[]>`
      select outcome, action, metadata from audit_events
      where target_id=${job.id} and action='pdf_export.download_denied'
      order by created_at desc limit 1
    `;
    expect(audit).toMatchObject({
      outcome: "denied",
      action: "pdf_export.download_denied",
      metadata: { reason: "FORBIDDEN" },
    });
  });
});

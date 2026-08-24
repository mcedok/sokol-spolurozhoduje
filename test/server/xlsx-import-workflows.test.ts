import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor, XlsxEditableRow } from "../../contracts";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase, 30_000);

async function seedApplicableImport(classifications: Array<"safe_change" | "conflict">) {
  const admin = await seedActiveAdmin();
  const member = await (await import("./db-test-context")).seedActiveMember();
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const blockUid = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const exportJobId = crypto.randomUUID();
  const inputFileId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await testSql`
    insert into sessions (id, user_id, token_hash, csrf_hash, expires_at)
    values (${sessionId}, ${admin.id}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, now() + interval '1 hour')
  `;
  await testSql`
    insert into documents (id, number, title, owner_admin_id, status)
    values (${documentId}, ${`SOKOL-2026-${940 + classifications.length}`}, 'XLSX norma', ${admin.id}, 'ready')
  `;
  await testSql`
    insert into document_versions (id, document_id, version_number, status, created_by_user_id, review_completed_at)
    values (${versionId}, ${documentId}, 1, 'ready', ${admin.id}, now())
  `;
  await testSql`insert into document_blocks (block_uid, document_id) values (${blockUid}, ${documentId})`;
  await testSql`
    insert into block_revisions (block_revision_id, block_uid, document_version_id, block_order,
      block_type, structured_content, plain_text, normalized_hash, parser_version, revision_origin)
    values (${revisionId}, ${blockUid}, ${versionId}, 0, 'paragraph', '{}', 'Text', ${"a".repeat(64)}, 'test', 'converted')
  `;
  await testSql`
    insert into xlsx_export_jobs (id, document_id, document_version_id, schema_version, snapshot,
      snapshot_sha256, row_count, requested_by_user_id, idempotency_key, command_hash, signing_key_id)
    values (${exportJobId}, ${documentId}, ${versionId}, 'xlsx-working-v1', '{}', ${"b".repeat(64)},
      ${classifications.length}, ${admin.id}, ${crypto.randomUUID()}, ${"c".repeat(64)}, 'test-key')
  `;
  await testSql`
    insert into file_objects (id, document_id, data_owner_user_id, purpose, container, object_key,
      original_name, declared_mime, size_bytes, sha256)
    values (${inputFileId}, ${documentId}, ${admin.id}, 'xlsx_import', 'originals',
      ${`test/${batchId}.xlsx`}, 'test.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 1, ${"d".repeat(64)})
  `;
  await testSql`
    insert into xlsx_import_batches (id, document_id, export_job_id, input_file_id, status,
      file_sha256, uploaded_by_user_id, actor_session_id, idempotency_key, command_hash)
    values (${batchId}, ${documentId}, ${exportJobId}, ${inputFileId}, 'comparing',
      ${"d".repeat(64)}, ${admin.id}, ${sessionId}, ${crypto.randomUUID()}, ${"e".repeat(64)})
  `;

  const rows: Array<{ id: string; commentId: string; incoming: XlsxEditableRow }> = [];
  for (let index = 0; index < classifications.length; index++) {
    const threadId = crypto.randomUUID();
    const commentId = crypto.randomUUID();
    const rowId = crypto.randomUUID();
    const base: XlsxEditableRow = {
      type: "comment", priority: "normal", status: "open", outcome: null,
      statement: null, targetVersionNumber: null, responsibleUserId: null,
      declaredSettlementDate: null,
    };
    const incoming: XlsxEditableRow = { ...base, priority: "high" };
    await testSql`
      insert into comment_threads (id, public_id, document_id, block_uid, target_block_revision_id, created_by_user_id)
      values (${threadId}, ${`VLAK-2026-${String(940000 + index).padStart(6, "0")}`}, ${documentId},
        ${blockUid}, ${revisionId}, ${member.id})
    `;
    await testSql`
      insert into comments (id, public_id, thread_id, author_user_id, author_name_snapshot,
        organization_name_snapshot, body, comment_type, priority, status)
      values (${commentId}, ${`PRIP-2026-${String(940000 + index).padStart(6, "0")}`}, ${threadId},
        ${member.id}, 'Jan Člen', 'TJ Test', 'Text připomínky', 'comment', 'normal', 'open')
    `;
    await testSql`
      insert into xlsx_import_rows (id, batch_id, source_row_number, comment_id,
        source_comment_row_version, base_values, current_values, incoming_values, classification)
      values (${rowId}, ${batchId}, ${index + 2}, ${commentId}, 1, ${testSql.json(base)},
        ${testSql.json(base)}, ${testSql.json(incoming)}, ${classifications[index]})
    `;
    rows.push({ id: rowId, commentId, incoming });
  }
  const actor: Actor = { userId: admin.id, role: "admin", sessionId };
  const modulePath = "../../server/modules/xlsx/xlsx-import-service";
  const { createXlsxImportService } = await import(modulePath) as typeof import("../../server/modules/xlsx/xlsx-import-service");
  return { actor, batchId, rows, service: createXlsxImportService({ sql: testSql }) };
}

describe("working XLSX import workflow", () => {
  it("rejects an import that does not belong to the selected document", async () => {
    const admin = await seedActiveAdmin();
    const documentA = crypto.randomUUID();
    const documentB = crypto.randomUUID();
    const versionA = crypto.randomUUID();
    const versionB = crypto.randomUUID();
    await testSql`
      insert into documents (id, number, title, owner_admin_id, status)
      values (${documentA}, 'SOKOL-2026-912', 'A', ${admin.id}, 'ready'),
             (${documentB}, 'SOKOL-2026-913', 'B', ${admin.id}, 'ready')
    `;
    await testSql`
      insert into document_versions (id, document_id, version_number, status, created_by_user_id, review_completed_at)
      values (${versionA}, ${documentA}, 1, 'ready', ${admin.id}, now()),
             (${versionB}, ${documentB}, 1, 'ready', ${admin.id}, now())
    `;
    const modulePath = "../../server/modules/xlsx/xlsx-import-service";
    const { createXlsxImportService } = await import(modulePath) as typeof import("../../server/modules/xlsx/xlsx-import-service");
    const service = createXlsxImportService({ sql: testSql });
    await expect(service.assertSourceDocument(documentA, versionB)).rejects.toMatchObject({ code: "IMPORT_SOURCE_MISMATCH" });
  });

  it("locks and applies a safe row without locking the nullable side of a left join", async () => {
    const seeded = await seedApplicableImport(["safe_change"]);
    await expect(seeded.service.applySafeRows(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).resolves.toMatchObject({
      applied: 1,
      skipped: 0,
      status: "completed",
    });
    const [comment] = await testSql<{ priority: string }[]>`
      select priority from comments where id=${seeded.rows[0].commentId}
    `;
    expect(comment.priority).toBe("high");
    const [history] = await testSql<{ previous_priority: string }[]>`
      select previous_priority from comment_attribute_revisions where comment_id=${seeded.rows[0].commentId}
    `;
    expect(history.previous_priority).toBe("normal");
    const [application] = await testSql<{ revision_count: number }[]>`
      select jsonb_array_length(domain_revision_ids)::int revision_count
      from xlsx_row_applications where import_row_id=${seeded.rows[0].id}
    `;
    expect(application.revision_count).toBeGreaterThan(0);
  });

  it("records valid question and critical values in append-only attribute history", async () => {
    const seeded = await seedApplicableImport(["safe_change"]);
    const base = { ...seeded.rows[0].incoming, type: "question" as const, priority: "critical" as const };
    const incoming = { ...base, type: "proposal" as const, priority: "high" as const };
    await testSql`update comments set comment_type='question', priority='critical' where id=${seeded.rows[0].commentId}`;
    await testSql`
      update xlsx_import_rows set base_values=${testSql.json(base)}, current_values=${testSql.json(base)},
        incoming_values=${testSql.json(incoming)} where id=${seeded.rows[0].id}
    `;

    await seeded.service.applySafeRows(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1, idempotencyKey: crypto.randomUUID(),
    });

    const [history] = await testSql<{ previous_type: string; previous_priority: string }[]>`
      select previous_type, previous_priority from comment_attribute_revisions
      where comment_id=${seeded.rows[0].commentId}
    `;
    expect(history).toEqual({ previous_type: "question", previous_priority: "critical" });
  });

  it("rolls back every safe row when any compared row became stale", async () => {
    const seeded = await seedApplicableImport(["safe_change", "safe_change"]);
    await testSql`update comments set priority='critical', row_version=row_version+1 where id=${seeded.rows[1].commentId}`;

    await expect(seeded.service.applySafeRows(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({
      code: "STALE_IMPORT_ROW",
      status: 409,
    });
    const comments = await testSql<{ id: string; priority: string }[]>`
      select id, priority from comments where id in (${seeded.rows[0].commentId}, ${seeded.rows[1].commentId}) order by id
    `;
    expect(comments.find((row) => row.id === seeded.rows[0].commentId)?.priority).toBe("normal");
    expect(comments.find((row) => row.id === seeded.rows[1].commentId)?.priority).toBe("critical");
    const [failureAudit] = await testSql<{ action: string; outcome: string; failure_kind: string }[]>`
      select action, outcome, metadata->>'failureKind' failure_kind from audit_events
      where target_id=${seeded.batchId} and action='xlsx_import.safe_apply_failed'
    `;
    expect(failureAudit).toEqual({
      action: "xlsx_import.safe_apply_failed",
      outcome: "denied",
      failure_kind: "STALE_IMPORT_ROW",
    });
  });

  it("rolls back when only the persisted comment row version changed after preview", async () => {
    const seeded = await seedApplicableImport(["safe_change"]);
    await testSql`update comments set row_version=row_version+1 where id=${seeded.rows[0].commentId}`;

    await expect(seeded.service.applySafeRows(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "STALE_IMPORT_ROW", status: 409 });
    const [comment] = await testSql<{ priority: string }[]>`
      select priority from comments where id=${seeded.rows[0].commentId}
    `;
    expect(comment.priority).toBe("normal");
  });

  it("keeps conflict classification immutable and applies an explicit use_xlsx decision", async () => {
    const seeded = await seedApplicableImport(["conflict"]);
    await testSql`update xlsx_import_batches set status='awaiting_resolution' where id=${seeded.batchId}`;
    const decisionKey = crypto.randomUUID();
    const decision = await seeded.service.decideConflict(seeded.actor, seeded.batchId, seeded.rows[0].id, {
      decision: "use_xlsx",
      expectedRowVersion: 1,
      idempotencyKey: decisionKey,
      reason: "Potvrzeno administrátorem.",
    });
    await expect(seeded.service.decideConflict(seeded.actor, seeded.batchId, seeded.rows[0].id, {
      decision: "use_xlsx",
      expectedRowVersion: 1,
      idempotencyKey: decisionKey,
      reason: "Potvrzeno administrátorem.",
    })).resolves.toEqual(decision);
    const [staged] = await testSql<{ classification: string }[]>`
      select classification from xlsx_import_rows where id=${seeded.rows[0].id}
    `;
    expect(staged.classification).toBe("conflict");

    await expect(seeded.service.applyConflictDecisions(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).resolves.toMatchObject({
      applied: 1,
      skipped: 0,
      status: "completed",
    });
    const [comment] = await testSql<{ priority: string }[]>`
      select priority from comments where id=${seeded.rows[0].commentId}
    `;
    expect(comment.priority).toBe("high");
    const [application] = await testSql<{ phase: string; result: string }[]>`
      select run.phase, application.result from xlsx_row_applications application
      join xlsx_apply_runs run on run.id=application.apply_run_id
      where application.import_row_id=${seeded.rows[0].id}
    `;
    expect(application).toEqual({ phase: "conflict_resolutions", result: "applied" });
    await expect(testSql`
      update xlsx_import_decisions set reason='přepsáno' where import_row_id=${seeded.rows[0].id}
    `).rejects.toMatchObject({ code: "P0001" });
    await expect(testSql`
      update xlsx_row_applications set result='skipped' where import_row_id=${seeded.rows[0].id}
    `).rejects.toMatchObject({ code: "P0001" });
    await expect(testSql`
      update xlsx_apply_runs set applied_count=999 where batch_id=${seeded.batchId}
    `).rejects.toMatchObject({ code: "P0001" });
  });

  it("does not allow conflict decisions or completion before the safe phase", async () => {
    const seeded = await seedApplicableImport(["safe_change", "conflict"]);
    await expect(seeded.service.decideConflict(seeded.actor, seeded.batchId, seeded.rows[1].id, {
      decision: "keep_system", expectedRowVersion: 1, idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "IMPORT_NOT_APPLICABLE", status: 409 });
    await expect(seeded.service.applyConflictDecisions(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1, idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "IMPORT_NOT_APPLICABLE", status: 409 });
    const [batch] = await testSql<{ status: string }[]>`
      select status from xlsx_import_batches where id=${seeded.batchId}
    `;
    expect(batch.status).toBe("comparing");
  });

  it("does not allow the one-shot safe phase to run again while resolving conflicts", async () => {
    const seeded = await seedApplicableImport(["conflict"]);
    await testSql`update xlsx_import_batches set status='awaiting_resolution' where id=${seeded.batchId}`;

    await expect(seeded.service.applySafeRows(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "IMPORT_NOT_APPLICABLE", status: 409 });
  });

  it("rejects an apply command whose If-Match batch version is stale", async () => {
    const seeded = await seedApplicableImport(["safe_change"]);
    await expect(seeded.service.applySafeRows(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 99,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    const [comment] = await testSql<{ priority: string }[]>`
      select priority from comments where id=${seeded.rows[0].commentId}
    `;
    expect(comment.priority).toBe("normal");
  });

  it("revalidates the active fresh session inside the apply transaction", async () => {
    const seeded = await seedApplicableImport(["safe_change"]);
    await testSql`update sessions set revoked_at=now() where id=${seeded.actor.sessionId}`;

    await expect(seeded.service.applySafeRows(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "FRESH_AUTHENTICATION_REQUIRED", status: 403 });
    const [comment] = await testSql<{ priority: string }[]>`
      select priority from comments where id=${seeded.rows[0].commentId}
    `;
    expect(comment.priority).toBe("normal");
  });

  it("lets the trusted worker finish after the upload session becomes old", async () => {
    const seeded = await seedApplicableImport(["safe_change"]);
    await testSql`update sessions set created_at=now()-interval '1 hour' where id=${seeded.actor.sessionId}`;

    await expect(seeded.service.applySafeRows(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    }, crypto.randomUUID(), { trustedWorkerCallback: true })).resolves.toMatchObject({ applied: 1 });

    const [comment] = await testSql<{ priority: string }[]>`
      select priority from comments where id=${seeded.rows[0].commentId}
    `;
    expect(comment.priority).toBe("high");
  });

  it("requires the current batch version when cancelling an import", async () => {
    const seeded = await seedApplicableImport(["safe_change"]);
    await testSql`update xlsx_import_batches set status='awaiting_resolution' where id=${seeded.batchId}`;
    await expect(seeded.service.cancel(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 99,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    await seeded.service.cancel(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    const [batch] = await testSql<{ status: string }[]>`
      select status from xlsx_import_batches where id=${seeded.batchId}
    `;
    expect(batch.status).toBe("cancelled");
  });

  it("requeues a failed archived import without replacing its input object", async () => {
    const seeded = await seedApplicableImport(["safe_change"]);
    await testSql`
      update xlsx_import_batches set status='failed', error_code='SAFE_APPLY_CALLBACK_FAILED',
        error_detail='temporary failure', completed_at=now() where id=${seeded.batchId}
    `;
    const [before] = await testSql<{ input_file_id: string; object_key: string }[]>`
      select batch.input_file_id, file.object_key
      from xlsx_import_batches batch join file_objects file on file.id=batch.input_file_id
      where batch.id=${seeded.batchId}
    `;

    await seeded.service.retry(seeded.actor, seeded.batchId, {
      expectedBatchRowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });

    const [after] = await testSql<{
      status: string; input_file_id: string; object_key: string; actor_session_id: string;
      error_code: string | null; completed_at: Date | null;
    }[]>`
      select batch.status, batch.input_file_id, file.object_key, batch.actor_session_id,
        batch.error_code, batch.completed_at
      from xlsx_import_batches batch join file_objects file on file.id=batch.input_file_id
      where batch.id=${seeded.batchId}
    `;
    expect(after).toMatchObject({
      status: "uploaded",
      input_file_id: before.input_file_id,
      object_key: before.object_key,
      actor_session_id: seeded.actor.sessionId,
      error_code: null,
      completed_at: null,
    });
  });
});

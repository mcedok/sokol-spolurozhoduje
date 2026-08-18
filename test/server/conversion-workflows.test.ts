import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../contracts";
import { createConversionService } from "../../server/modules/conversion/conversion-service";
import {
  readinessFailures,
  type ReadinessSnapshot,
} from "../../server/modules/conversion/readiness-policy";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  testSql,
} from "./db-test-context";

const conversions = createConversionService({ sql: testSql });

beforeAll(migrateTestDatabase, 30_000);
beforeEach(resetTestDatabase, 30_000);

async function admin(role: "admin" | "superadmin" = "admin") {
  const user = await seedActiveAdmin({ role });
  return {
    user,
    actor: { userId: user.id, role, sessionId: crypto.randomUUID() } satisfies Actor,
  };
}

async function seedReview(ownerId: string) {
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await testSql`
    insert into documents(id, number, title, owner_admin_id, status)
    values (${documentId}, ${`SOKOL-2099-${String(Math.floor(Math.random() * 900000) + 100000)}`},
      'Kontrola převodu', ${ownerId}, 'conversion_review')
  `;
  await testSql`
    insert into file_objects(
      id, document_id, data_owner_user_id, purpose, container, object_key, original_name,
      declared_mime, detected_mime, size_bytes, sha256, etag, av_status, av_checked_at,
      av_result_code, object_status
    ) values (
      ${fileId}, ${documentId}, ${ownerId}, 'original_docx', 'originals',
      ${`${documentId}/${versionId}/source.docx`}, 'source.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      42, ${"a".repeat(64)}, 'etag', 'clean', now(), 'OK', 'archived'
    )
  `;
  await testSql`
    insert into document_versions(
      id, document_id, version_number, status, original_file_id, created_by_user_id
    ) values (${versionId}, ${documentId}, 1, 'conversion_review', ${fileId}, ${ownerId})
  `;
  await testSql`
    insert into conversion_jobs(
      id, document_version_id, status, current_step, profile_version, input_sha256,
      idempotency_key, correlation_id, completed_at
    ) values (
      ${jobId}, ${versionId}, 'completed', 'completed', 'docx-web-v1', ${"a".repeat(64)},
      ${crypto.randomUUID()}, ${crypto.randomUUID()}, now()
    )
  `;
  await testSql`update document_versions set current_conversion_job_id = ${jobId} where id = ${versionId}`;
  const blockUid = crypto.randomUUID();
  await testSql`
    insert into document_blocks(block_uid, document_id) values (${blockUid}, ${documentId})
  `;
  const blockRevisionId = crypto.randomUUID();
  await testSql`
    insert into block_revisions(
      block_revision_id, block_uid, document_version_id, block_order, block_type,
      structured_content, plain_text, normalized_hash, parser_version, revision_origin
    ) values (
      ${blockRevisionId}, ${blockUid}, ${versionId}, 0, 'paragraph', '{}', 'Text normy',
      ${"b".repeat(64)}, 'docx-web-v1', 'converted'
    )
  `;
  return { documentId, versionId, blockUid, blockRevisionId, jobId };
}

const readySnapshot = (): ReadinessSnapshot => ({
  avStatus: "clean",
  jobStatus: "completed",
  blockCount: 12,
  openBlockingFindings: 0,
  unconfirmedTables: 0,
  missingAltTexts: 0,
  missingTableAssets: 0,
});

describe("conversion readiness policy", () => {
  it.each([
    ["AV_NOT_CLEAN", { avStatus: "pending" }],
    ["CONVERSION_NOT_COMPLETE", { jobStatus: "rendering" }],
    ["NO_BLOCKS", { blockCount: 0 }],
    ["BLOCKING_FINDINGS", { openBlockingFindings: 1 }],
    ["TABLE_DECISION_REQUIRED", { unconfirmedTables: 1 }],
    ["ALT_TEXT_REQUIRED", { missingAltTexts: 1 }],
    ["TABLE_ASSET_REQUIRED", { missingTableAssets: 1 }],
  ] as const)("reports %s without hiding other readiness state", (code, override) => {
    const failures = readinessFailures({ ...readySnapshot(), ...override });
    expect(failures.map((failure) => failure.code)).toEqual([code]);
  });

  it("allows review completion only when every invariant is satisfied", () => {
    expect(readinessFailures(readySnapshot())).toEqual([]);
  });

  it("returns every failure so the administrator can fix them in one pass", () => {
    expect(readinessFailures({
      ...readySnapshot(),
      avStatus: "infected",
      blockCount: 0,
      missingAltTexts: 2,
    }).map((failure) => failure.code)).toEqual([
      "AV_NOT_CLEAN", "NO_BLOCKS", "ALT_TEXT_REQUIRED",
    ]);
  });
});

describe("conversion review workflow", () => {
  it("atomically marks a clean reviewed version and its document ready", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);

    const result = await conversions.completeReview(owner.actor, review.versionId, {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result).toMatchObject({ status: "ready", rowVersion: 2 });
    expect(await testSql`select status from documents where id = ${review.documentId}`)
      .toMatchObject([{ status: "ready" }]);
    expect(await testSql`select action from audit_events where target_id = ${review.versionId}`)
      .toMatchObject([{ action: "conversion.review_completed" }]);
    expect(await testSql`select event_type from outbox_events where aggregate_id = ${review.versionId}`)
      .toMatchObject([{ event_type: "document.conversion.ready" }]);
  });

  it("denies a foreign administrator without changing the version", async () => {
    const owner = await admin();
    const other = await admin();
    const review = await seedReview(owner.user.id);

    await expect(conversions.completeReview(other.actor, review.versionId, {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await testSql`select status from document_versions where id = ${review.versionId}`)
      .toMatchObject([{ status: "conversion_review" }]);
  });

  it("rolls back when the document is no longer in conversion review", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    await testSql`update documents set status='concept' where id=${review.documentId}`;

    await expect(conversions.completeReview(owner.actor, review.versionId, {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    expect(await testSql`select status from document_versions where id=${review.versionId}`)
      .toMatchObject([{ status: "conversion_review" }]);
    expect(await testSql`select * from outbox_events where aggregate_id=${review.versionId}`)
      .toHaveLength(0);
  });

  it("replays completion idempotently and rejects a reused key from another operation", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    const key = crypto.randomUUID();
    const command = { rowVersion: 1, idempotencyKey: key };
    const first = await conversions.completeReview(owner.actor, review.versionId, command);

    await expect(conversions.completeReview(owner.actor, review.versionId, command))
      .resolves.toEqual(first);
    expect(await testSql`select * from outbox_events where idempotency_key=${key}`).toHaveLength(1);

    const another = await seedReview(owner.user.id);
    await expect(conversions.completeReview(owner.actor, another.versionId, {
      rowVersion: 1,
      idempotencyKey: key,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await testSql`select status from document_versions where id=${another.versionId}`)
      .toMatchObject([{ status: "conversion_review" }]);
  });

  it("requires a blocking finding to be resolved before review completion", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    const findingId = crypto.randomUUID();
    await testSql`
      insert into conversion_findings(
        id, conversion_job_id, block_uid, code, severity, message
      ) values (
        ${findingId}, ${review.jobId}, ${review.blockUid}, 'TABLE_RENDER_MISMATCH',
        'blocking', 'Tabulka se liší od náhledu.'
      )
    `;

    await expect(conversions.decideFinding(
      owner.actor, findingId, "accepted", "Rozdíl ponechán",
      { rowVersion: 1, idempotencyKey: crypto.randomUUID() },
    )).rejects.toMatchObject({ code: "BLOCKING_FINDING_CANNOT_BE_ACCEPTED" });
    await expect(conversions.completeReview(owner.actor, review.versionId, {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "VERSION_NOT_READY" });

    await conversions.decideFinding(
      owner.actor, findingId, "resolved", "Tabulka opravena",
      { rowVersion: 1, idempotencyKey: crypto.randomUUID() },
    );
    await expect(conversions.completeReview(owner.actor, review.versionId, {
      rowVersion: 2,
      idempotencyKey: crypto.randomUUID(),
    })).resolves.toMatchObject({ status: "ready" });
    expect(await testSql`select status, decision_reason from conversion_findings where id=${findingId}`)
      .toMatchObject([{ status: "resolved", decision_reason: "Tabulka opravena" }]);
  });

  it("rejects a structural edit that changes the normalized document text", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);

    await expect(conversions.editBlockStructure(
      owner.actor,
      review.versionId,
      review.blockUid,
      {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        reason: "Oprava typu bloku",
        type: "heading",
        commentable: true,
        text: "Jiný text",
      },
    )).rejects.toMatchObject({ code: "TEXT_CHANGE_REQUIRES_DOCX" });
  });

  it("stores a structural correction as a new current block revision", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);

    const result = await conversions.editBlockStructure(
      owner.actor,
      review.versionId,
      review.blockUid,
      {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        reason: "Odstavec je nadpis",
        type: "heading",
        commentable: false,
        text: "Text normy",
      },
    );

    expect(result).toMatchObject({ type: "heading", commentable: false, rowVersion: 2 });
    expect(await testSql`
      select block_type, commentable, superseded_at is null as current
      from block_revisions where document_version_id=${review.versionId}
      order by created_at
    `).toMatchObject([
      { block_type: "paragraph", commentable: true, current: false },
      { block_type: "heading", commentable: false, current: true },
    ]);
    expect(await testSql`
      select change_type, reason from block_edit_revisions
      where document_version_id=${review.versionId} order by change_type
    `).toEqual([
      { change_type: "commentable", reason: "Odstavec je nadpis" },
      { change_type: "type", reason: "Odstavec je nadpis" },
    ]);
  });

  it("replays structural edits and finding decisions without duplicate mutations", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    const editKey = crypto.randomUUID();
    const editInput = {
      rowVersion: 1,
      idempotencyKey: editKey,
      reason: "Odstavec je nadpis",
      type: "heading" as const,
      commentable: true,
      text: "Text normy",
    };
    const firstEdit = await conversions.editBlockStructure(
      owner.actor, review.versionId, review.blockUid, editInput,
    );
    await expect(conversions.editBlockStructure(
      owner.actor, review.versionId, review.blockUid, editInput,
    )).resolves.toEqual(firstEdit);
    await expect(conversions.editBlockStructure(
      owner.actor, review.versionId, review.blockUid, {
        ...editInput,
        type: "quote",
      },
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await testSql`
      select * from block_edit_revisions where document_version_id=${review.versionId}
    `).toHaveLength(1);

    const findingId = crypto.randomUUID();
    await testSql`
      insert into conversion_findings(id, conversion_job_id, code, severity, message)
      values (${findingId}, ${review.jobId}, 'PARAGRAPH_WARNING', 'warning', 'Kontrolní varování')
    `;
    const decision = { rowVersion: 2, idempotencyKey: crypto.randomUUID() };
    const firstDecision = await conversions.decideFinding(
      owner.actor, findingId, "accepted", "Odchylka je přípustná", decision,
    );
    await expect(conversions.decideFinding(
      owner.actor, findingId, "accepted", "Odchylka je přípustná", decision,
    )).resolves.toEqual(firstDecision);
    expect(await testSql`
      select * from outbox_events where idempotency_key in (${editKey}, ${decision.idempotencyKey})
    `).toHaveLength(2);
  });

  it("requires assets selected by the confirmed table representation", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    await testSql`
      update block_revisions set block_type='table',
        structured_content=${testSql.json({ confirmedRepresentation: "image_with_attachment" })}
      where block_revision_id=${review.blockRevisionId}
    `;

    await expect(conversions.completeReview(owner.actor, review.versionId, {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "VERSION_NOT_READY" });
    await expect(conversions.editBlockStructure(
      owner.actor, review.versionId, review.blockUid, {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        reason: "Volba obrazu bez souborů",
        type: "table",
        commentable: true,
        text: "Text normy",
        tableRepresentation: "image_with_attachment",
        alternativeText: "Popis",
      },
    )).rejects.toMatchObject({ code: "TABLE_ASSET_REQUIRED" });
  });

  it("returns processing and preview data and retries an owned failed job", async () => {
    const owner = await admin();
    const other = await admin();
    const review = await seedReview(owner.user.id);

    await expect(conversions.getProcessing(owner.actor, review.versionId)).resolves.toMatchObject({
      versionId: review.versionId,
      jobId: review.jobId,
      jobStatus: "completed",
      versionStatus: "conversion_review",
    });
    await expect(conversions.getPreview(owner.actor, review.versionId)).resolves.toMatchObject({
      id: review.versionId,
      rowVersion: 1,
      blocks: [{ blockUid: review.blockUid, text: "Text normy" }],
    });
    await expect(conversions.getPreview(other.actor, review.versionId))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    await testSql`
      update conversion_jobs set status='failed', current_step='failed', error_code='TRANSIENT'
      where id=${review.jobId}
    `;
    await testSql`
      update document_versions set status='conversion' where id=${review.versionId}
    `;
    await testSql`
      update documents set status='conversion' where id=${review.documentId}
    `;
    await expect(conversions.retry(owner.actor, review.jobId, {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).resolves.toMatchObject({ jobStatus: "queued", rowVersion: 2 });
  });

  it("lets a superadministrator edit any review and audits a denied foreign administrator", async () => {
    const owner = await admin();
    const other = await admin();
    const superadmin = await admin("superadmin");
    const review = await seedReview(owner.user.id);

    await expect(conversions.editBlockStructure(
      other.actor, review.versionId, review.blockUid, {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        reason: "Cizí zásah",
        type: "heading",
        commentable: true,
        text: "Text normy",
      },
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await testSql`
      select action, outcome from audit_events
      where actor_user_id=${other.user.id} and target_id=${review.versionId}
    `).toEqual([{ action: "conversion.block_edit_denied", outcome: "denied" }]);

    await expect(conversions.editBlockStructure(
      superadmin.actor, review.versionId, review.blockUid, {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        reason: "Kontrola superadministrátorem",
        type: "heading",
        commentable: true,
        text: "Text normy",
      },
    )).resolves.toMatchObject({ type: "heading", rowVersion: 2 });
  });

  it("versions boundary, order, and technical-separator corrections", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    const sourceRange = { paragraphStart: 4, paragraphEnd: 4 };
    const secondUid = crypto.randomUUID();
    const thirdUid = crypto.randomUUID();
    const separatorUid = crypto.randomUUID();
    await testSql`
      insert into document_blocks(block_uid,document_id)
      values (${secondUid},${review.documentId}),(${thirdUid},${review.documentId}),
        (${separatorUid},${review.documentId})
    `;
    await testSql`
      insert into block_revisions(
        block_revision_id,block_uid,document_version_id,block_order,block_type,
        structured_content,plain_text,normalized_hash,parser_version,revision_origin
      ) values
        (${crypto.randomUUID()},${secondUid},${review.versionId},1,'paragraph','{}','Druhý',
          ${"c".repeat(64)},'docx-web-v1','converted'),
        (${crypto.randomUUID()},${thirdUid},${review.versionId},2,'paragraph','{}','Třetí',
          ${"d".repeat(64)},'docx-web-v1','converted'),
        (${crypto.randomUUID()},${separatorUid},${review.versionId},3,'paragraph','{}','',
          ${"e".repeat(64)},'docx-web-v1','converted')
    `;

    await expect(conversions.editBlockStructure(
      owner.actor, review.versionId, review.blockUid, {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        reason: "Oprava hranice a pořadí",
        type: "paragraph",
        commentable: true,
        text: "Text normy",
        order: 2,
        sourceRange,
      },
    )).resolves.toMatchObject({ rowVersion: 2, order: 2, sourceRange });
    expect(await testSql`
      select block_uid,block_order from block_revisions
      where document_version_id=${review.versionId} and superseded_at is null
      order by block_order
    `).toEqual([
      { block_uid: secondUid, block_order: 0 },
      { block_uid: thirdUid, block_order: 1 },
      { block_uid: review.blockUid, block_order: 2 },
      { block_uid: separatorUid, block_order: 3 },
    ]);
    await expect(conversions.editBlockStructure(
      owner.actor, review.versionId, separatorUid, {
        rowVersion: 2,
        idempotencyKey: crypto.randomUUID(),
        reason: "Technický oddělovač",
        type: "technical_separator",
        commentable: false,
        text: "",
      },
    )).resolves.toMatchObject({ rowVersion: 3, type: "technical_separator", order: 3 });

    expect(await testSql`
      select change_type from block_edit_revisions
      where document_version_id=${review.versionId} order by change_type
    `).toEqual([
      { change_type: "boundaries" },
      { change_type: "commentable" },
      { change_type: "order" },
      { change_type: "order" },
      { change_type: "order" },
      { change_type: "separator" },
    ]);
  });

  it("moves a boundary between adjacent blocks without changing character order", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    const rightUid = crypto.randomUUID();
    await testSql`
      insert into document_blocks(block_uid,document_id) values (${rightUid},${review.documentId})
    `;
    await testSql`
      insert into block_revisions(
        block_revision_id,block_uid,document_version_id,block_order,block_type,
        structured_content,plain_text,normalized_hash,parser_version,revision_origin
      ) values (
        ${crypto.randomUUID()},${rightUid},${review.versionId},1,'paragraph','{}',
        'pokračování',${"f".repeat(64)},'docx-web-v1','converted'
      )
    `;

    await expect(conversions.editBlockBoundary(
      owner.actor, review.versionId, review.blockUid, rightUid, {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        reason: "Oprava rozdělení odstavců",
        leftText: "Text",
        rightText: "normy pokračování",
      },
    )).resolves.toMatchObject({ rowVersion: 2 });
    expect(await testSql`
      select block_uid,plain_text from block_revisions
      where document_version_id=${review.versionId} and superseded_at is null
      order by block_order
    `).toEqual([
      { block_uid: review.blockUid, plain_text: "Text" },
      { block_uid: rightUid, plain_text: "normy pokračování" },
    ]);
    expect(await testSql`
      select change_type from block_edit_revisions
      where document_version_id=${review.versionId}
    `).toEqual([{ change_type: "boundaries" }, { change_type: "boundaries" }]);
  });

  it("stores a table presentation decision and required alternative text", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    const assetFileId = crypto.randomUUID();
    await testSql`
      update block_revisions set block_type='table',
        structured_content=${testSql.json({ tableRecommendation: "image_with_attachment" })}
      where block_revision_id=${review.blockRevisionId}
    `;
    await testSql`
      insert into file_objects(
        id, document_id, data_owner_user_id, purpose, container, object_key, original_name,
        declared_mime, detected_mime, size_bytes, sha256, av_status, object_status
      ) values (
        ${assetFileId}, ${review.documentId}, ${owner.user.id}, 'table_image', 'derivatives',
        ${`${review.documentId}/${review.versionId}/table.png`}, 'table.png', 'image/png',
        'image/png', 12, ${"c".repeat(64)}, 'clean', 'derivative'
      )
    `;
    await testSql`
      insert into block_assets(
        id, block_revision_id, file_object_id, purpose, checksum, table_representation
      ) values (
        ${crypto.randomUUID()}, ${review.blockRevisionId}, ${assetFileId}, 'table_image',
        ${"c".repeat(64)}, 'image_with_attachment'
      )
    `;
    await testSql`
      insert into block_assets(
        id, block_revision_id, file_object_id, purpose, asset_order, checksum, table_representation
      ) values (
        ${crypto.randomUUID()}, ${review.blockRevisionId},
        (select original_file_id from document_versions where id=${review.versionId}),
        'attachment', 1, ${"a".repeat(64)}, 'image_with_attachment'
      )
    `;

    await expect(conversions.completeReview(owner.actor, review.versionId, {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "VERSION_NOT_READY" });

    const edited = await conversions.editBlockStructure(
      owner.actor,
      review.versionId,
      review.blockUid,
      {
        rowVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        reason: "Potvrzen obrazový náhled tabulky",
        type: "table",
        commentable: true,
        text: "Text normy",
        tableRepresentation: "image_with_attachment",
        alternativeText: "Tabulka s přehledem termínů",
      },
    );

    expect(edited).toMatchObject({ rowVersion: 2 });
    expect(await testSql`
      select structured_content->>'confirmedRepresentation' as representation
      from block_revisions where document_version_id=${review.versionId} and superseded_at is null
    `).toEqual([{ representation: "image_with_attachment" }]);
    expect(await testSql`
      select asset.alternative_text
      from block_assets asset
      join block_revisions revision on revision.block_revision_id=asset.block_revision_id
      where revision.document_version_id=${review.versionId} and revision.superseded_at is null
        and asset.purpose='table_image'
    `).toEqual([{ alternative_text: "Tabulka s přehledem termínů" }]);
    await expect(conversions.completeReview(owner.actor, review.versionId, {
      rowVersion: 2,
      idempotencyKey: crypto.randomUUID(),
    })).resolves.toMatchObject({ status: "ready" });
  });

  it("does not allow a finding decision after conversion review is complete", async () => {
    const owner = await admin();
    const review = await seedReview(owner.user.id);
    const findingId = crypto.randomUUID();
    await testSql`
      insert into conversion_findings(id, conversion_job_id, code, severity, message)
      values (${findingId}, ${review.jobId}, 'PARAGRAPH_WARNING', 'warning', 'Kontrolní varování')
    `;
    await conversions.completeReview(owner.actor, review.versionId, {
      rowVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(conversions.decideFinding(
      owner.actor, findingId, "accepted", "Přijato po kontrole",
      { rowVersion: 2, idempotencyKey: crypto.randomUUID() },
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await testSql`select status from conversion_findings where id=${findingId}`)
      .toEqual([{ status: "open" }]);
  });
});

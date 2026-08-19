import type { Sql } from "postgres";
import type { XlsxExportJob, XlsxExportSnapshot } from "../../../contracts";
import type { XlsxExportSource } from "./xlsx-export-snapshot";

interface XlsxExportJobRow {
  id: string;
  document_id: string;
  document_version_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  schema_version: string;
  snapshot_sha256: string;
  row_count: number;
  row_version: number;
  created_at: Date;
  completed_at: Date | null;
  output_file_id: string | null;
  error_code: string | null;
}

function adaptJob(row: XlsxExportJobRow): XlsxExportJob {
  return {
    id: row.id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    status: row.status,
    schemaVersion: row.schema_version,
    snapshotSha256: row.snapshot_sha256,
    rowCount: row.row_count,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    outputFileId: row.output_file_id,
    errorCode: row.error_code,
  };
}

export async function findXlsxExportByIdempotencyKey(
  sql: Sql,
  idempotencyKey: string,
): Promise<(XlsxExportJob & { commandHash: string }) | null> {
  const [row] = await sql<(XlsxExportJobRow & { command_hash: string })[]>`
    select id, document_id, document_version_id, status, schema_version,
      snapshot_sha256, row_count, row_version, created_at, completed_at,
      output_file_id, error_code, command_hash
    from xlsx_export_jobs where idempotency_key = ${idempotencyKey}
  `;
  return row ? { ...adaptJob(row), commandHash: row.command_hash } : null;
}

export async function findXlsxExportForAccess(
  sql: Sql,
  jobId: string,
): Promise<{ job: XlsxExportJob; ownerAdminId: string } | null> {
  const [row] = await sql<(XlsxExportJobRow & { owner_admin_id: string })[]>`
    select job.id, job.document_id, job.document_version_id, job.status,
      job.schema_version, job.snapshot_sha256, job.row_count, job.row_version,
      job.created_at, job.completed_at, job.output_file_id, job.error_code,
      document.owner_admin_id
    from xlsx_export_jobs job
    join documents document on document.id = job.document_id
    where job.id = ${jobId}
  `;
  return row ? { job: adaptJob(row), ownerAdminId: row.owner_admin_id } : null;
}

export async function loadXlsxExportSource(
  sql: Sql,
  documentId: string,
  documentVersionId: string,
): Promise<{ ownerAdminId: string; source: XlsxExportSource } | null> {
  const [document] = await sql<{
    owner_admin_id: string;
    document_number: string;
    title: string;
    version_number: number;
    version_status: string;
  }[]>`
    select document.owner_admin_id, document.number as document_number,
      document.title, version.version_number, version.status::text as version_status
    from documents document
    join document_versions version on version.document_id = document.id
    where document.id = ${documentId} and version.id = ${documentVersionId}
  `;
  if (!document || document.version_status !== "ready") return null;

  const comments = await sql<{
    id: string;
    public_id: string;
    block_order: number;
    block_uid: string;
    block_text: string;
    author_name_snapshot: string;
    organization_name_snapshot: string;
    created_at: Date;
    body: string;
    comment_type: XlsxExportSource["comments"][number]["type"];
    priority: XlsxExportSource["comments"][number]["priority"];
    status: XlsxExportSource["comments"][number]["status"];
    comment_row_version: number;
    settlement_id: string | null;
    settlement_row_version: number | null;
    outcome: XlsxExportSource["comments"][number]["settlement"] extends infer Settlement
      ? Settlement extends { outcome: infer Outcome } ? Outcome : never
      : never;
    statement: string | null;
    responsible_user_id: string | null;
    responsible_admin_name: string | null;
    declared_settlement_date: string | null;
    target_version_number: number | null;
  }[]>`
    select comment.id, comment.public_id, revision.block_order, revision.block_uid,
      revision.plain_text as block_text, comment.author_name_snapshot,
      comment.organization_name_snapshot, comment.created_at, comment.body,
      comment.comment_type, comment.priority, comment.status,
      comment.row_version as comment_row_version,
      settlement.id as settlement_id, settlement.row_version as settlement_row_version,
      settlement.outcome, settlement.statement,
      settlement.responsible_user_id,
      concat(responsible.first_name, ' ', responsible.last_name) as responsible_admin_name,
      settlement.declared_settlement_date::text,
      target.version_number as target_version_number
    from comments comment
    join comment_threads thread on thread.id = comment.thread_id
    join block_revisions revision on revision.block_revision_id = thread.target_block_revision_id
    left join settlements settlement
      on settlement.comment_id = comment.id and settlement.voided_at is null
    left join users responsible on responsible.id = settlement.responsible_user_id
    left join document_versions target on target.id = settlement.target_document_version_id
    where thread.document_id = ${documentId} and comment.status <> 'hidden'
    order by revision.block_order, comment.public_id
  `;

  return {
    ownerAdminId: document.owner_admin_id,
    source: {
      document: {
        id: documentId,
        versionId: documentVersionId,
        number: document.document_number,
        title: document.title,
        versionNumber: document.version_number,
      },
      comments: comments.map((comment) => ({
        id: comment.id,
        publicId: comment.public_id,
        blockOrder: comment.block_order,
        blockUid: comment.block_uid,
        blockText: comment.block_text,
        authorName: comment.author_name_snapshot,
        organizationName: comment.organization_name_snapshot,
        createdAt: comment.created_at.toISOString(),
        body: comment.body,
        type: comment.comment_type,
        priority: comment.priority,
        status: comment.status,
        commentRowVersion: comment.comment_row_version,
        settlement: comment.settlement_id && comment.outcome && comment.statement
          && comment.responsible_user_id && comment.responsible_admin_name
          ? {
            id: comment.settlement_id,
            rowVersion: comment.settlement_row_version ?? 1,
            outcome: comment.outcome,
            statement: comment.statement,
            responsibleUserId: comment.responsible_user_id,
            responsibleAdminName: comment.responsible_admin_name,
            declaredSettlementDate: comment.declared_settlement_date,
            targetVersionNumber: comment.target_version_number,
          }
          : null,
      })),
    },
  };
}

export async function insertXlsxExportJob(
  sql: Sql,
  input: {
    id: string;
    documentId: string;
    documentVersionId: string;
    schemaVersion: string;
    snapshot: XlsxExportSnapshot;
    snapshotSha256: string;
    rowCount: number;
    requestedByUserId: string;
    idempotencyKey: string;
    commandHash: string;
    signingKeyId: string;
  },
): Promise<XlsxExportJob> {
  const [row] = await sql<XlsxExportJobRow[]>`
    insert into xlsx_export_jobs (
      id, document_id, document_version_id, schema_version, snapshot,
      snapshot_sha256, row_count, requested_by_user_id, idempotency_key,
      command_hash, signing_key_id
    ) values (
      ${input.id}, ${input.documentId}, ${input.documentVersionId}, ${input.schemaVersion},
      ${sql.json(input.snapshot as never)}, ${input.snapshotSha256}, ${input.rowCount},
      ${input.requestedByUserId}, ${input.idempotencyKey}, ${input.commandHash}, ${input.signingKeyId}
    )
    returning id, document_id, document_version_id, status, schema_version,
      snapshot_sha256, row_count, row_version, created_at, completed_at,
      output_file_id, error_code
  `;
  return adaptJob(row);
}

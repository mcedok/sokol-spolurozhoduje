import type { Sql } from "postgres";
import type {
  PdfExportJob,
  PdfExportSnapshot,
} from "../../../contracts";
import type { PdfExportSource } from "./export-snapshot";

interface ExportJobRow {
  id: string;
  document_id: string;
  document_version_id: string;
  visibility: "public" | "internal";
  status: "queued" | "processing" | "completed" | "failed";
  snapshot_sha256: string;
  command_hash: string;
  row_version: number;
  created_at: Date;
  completed_at: Date | null;
  output_file_id: string | null;
  error_code: string | null;
}

function adaptJob(row: ExportJobRow): PdfExportJob {
  return {
    id: row.id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    visibility: row.visibility,
    status: row.status,
    snapshotSha256: row.snapshot_sha256,
    rowVersion: row.row_version,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    outputFileId: row.output_file_id,
    errorCode: row.error_code,
  };
}

export async function findExportByIdempotencyKey(
  sql: Sql,
  idempotencyKey: string,
): Promise<(PdfExportJob & { commandHash: string }) | null> {
  const [row] = await sql<ExportJobRow[]>`
    select id, document_id, document_version_id, visibility, status,
      snapshot_sha256, command_hash, row_version, created_at, completed_at,
      output_file_id, error_code
    from export_jobs where idempotency_key = ${idempotencyKey}
  `;
  return row ? { ...adaptJob(row), commandHash: row.command_hash } : null;
}

export async function findExportForAccess(
  sql: Sql,
  exportJobId: string,
): Promise<{ job: PdfExportJob; ownerAdminId: string } | null> {
  const [row] = await sql<(ExportJobRow & { owner_admin_id: string })[]>`
    select job.id, job.document_id, job.document_version_id, job.visibility,
      job.status, job.snapshot_sha256, job.command_hash, job.row_version,
      job.created_at, job.completed_at, job.output_file_id, job.error_code,
      document.owner_admin_id
    from export_jobs job
    join documents document on document.id = job.document_id
    where job.id = ${exportJobId}
  `;
  return row ? { job: adaptJob(row), ownerAdminId: row.owner_admin_id } : null;
}

export async function loadPdfExportSource(
  sql: Sql,
  documentId: string,
  documentVersionId: string,
): Promise<{ ownerAdminId: string; source: PdfExportSource } | null> {
  const [document] = await sql<{
    owner_admin_id: string;
    number: string;
    title: string;
    explanatory_report: string;
    version_number: number;
    version_status: string;
  }[]>`
    select document.owner_admin_id, document.number, document.title,
      document.explanatory_report, version.version_number,
      version.status::text as version_status
    from documents document
    join document_versions version on version.document_id = document.id
    where document.id = ${documentId} and version.id = ${documentVersionId}
  `;
  if (!document || document.version_status !== "ready") return null;
  const comments = await sql<{
    public_id: string;
    block_order: number;
    block_text: string;
    author_name_snapshot: string;
    organization_name_snapshot: string;
    author_email: string;
    membership_id: string | null;
    created_at: Date;
    body: string;
    comment_type: PdfExportSource["comments"][number]["type"];
    priority: PdfExportSource["comments"][number]["priority"];
    status: PdfExportSource["comments"][number]["status"];
    outcome: PdfExportSource["comments"][number]["settlement"] extends infer Settlement
      ? Settlement extends { outcome: infer Outcome } ? Outcome : never
      : never;
    statement: string | null;
    settled_at: Date | null;
    target_version_number: number | null;
    internal_note: string | null;
  }[]>`
    select comment.public_id, revision.block_order, revision.plain_text as block_text,
      comment.author_name_snapshot, comment.organization_name_snapshot,
      author.email::text as author_email, author.membership_id,
      comment.created_at, comment.body, comment.comment_type, comment.priority,
      comment.status, settlement.outcome, settlement.statement, settlement.settled_at,
      target.version_number as target_version_number, settlement.internal_note
    from comments comment
    join comment_threads thread on thread.id = comment.thread_id
    join block_revisions revision on revision.block_revision_id = thread.target_block_revision_id
    join users author on author.id = comment.author_user_id
    left join settlements settlement on settlement.comment_id = comment.id
    left join document_versions target on target.id = settlement.target_document_version_id
    where thread.document_id = ${documentId}
    order by revision.block_order, comment.public_id
  `;
  return {
    ownerAdminId: document.owner_admin_id,
    source: {
      document: {
        number: document.number,
        title: document.title,
        explanatoryReport: document.explanatory_report,
        versionNumber: document.version_number,
      },
      comments: comments.map((comment) => ({
        publicId: comment.public_id,
        blockOrder: comment.block_order,
        blockText: comment.block_text,
        authorName: comment.author_name_snapshot,
        organizationName: comment.organization_name_snapshot,
        authorEmail: comment.author_email,
        membershipId: comment.membership_id,
        createdAt: comment.created_at.toISOString(),
        body: comment.body,
        type: comment.comment_type,
        priority: comment.priority,
        status: comment.status,
        settlement: comment.outcome && comment.statement && comment.settled_at ? {
          outcome: comment.outcome,
          statement: comment.statement,
          settledAt: comment.settled_at.toISOString(),
          targetVersionNumber: comment.target_version_number,
          internalNote: comment.internal_note,
        } : null,
      })),
    },
  };
}

export async function insertPdfExportJob(
  sql: Sql,
  input: {
    id: string;
    documentId: string;
    documentVersionId: string;
    visibility: "public" | "internal";
    filters: unknown;
    options: unknown;
    snapshot: PdfExportSnapshot;
    snapshotSha256: string;
    requestedByUserId: string;
    idempotencyKey: string;
    commandHash: string;
  },
): Promise<PdfExportJob> {
  const [row] = await sql<ExportJobRow[]>`
    insert into export_jobs (
      id, document_id, document_version_id, visibility, filters, options,
      snapshot, snapshot_sha256, requested_by_user_id, idempotency_key, command_hash
    ) values (
      ${input.id}, ${input.documentId}, ${input.documentVersionId}, ${input.visibility},
      ${sql.json(input.filters as never)}, ${sql.json(input.options as never)},
      ${sql.json(input.snapshot as never)}, ${input.snapshotSha256},
      ${input.requestedByUserId}, ${input.idempotencyKey}, ${input.commandHash}
    )
    returning id, document_id, document_version_id, visibility, status,
      snapshot_sha256, command_hash, row_version, created_at, completed_at,
      output_file_id, error_code
  `;
  return adaptJob(row);
}

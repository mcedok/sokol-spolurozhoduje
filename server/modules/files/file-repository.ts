import type { Sql } from "postgres";

export interface ExistingUpload {
  versionId: string;
  jobId: string;
  fileId: string;
  sha256: string;
  status: "file_check";
}

export async function findUploadByIdempotencyKey(
  sql: Sql,
  idempotencyKey: string,
): Promise<ExistingUpload | null> {
  const rows = await sql<{
    aggregate_id: string;
    payload: { jobId: string; fileId: string; sha256: string; status: "file_check" };
  }[]>`
    select aggregate_id, payload
    from outbox_events
    where idempotency_key = ${idempotencyKey}
      and event_type = 'document.conversion_queued'
  `;
  const row = rows[0];
  return row ? {
    versionId: row.aggregate_id,
    jobId: row.payload.jobId,
    fileId: row.payload.fileId,
    sha256: row.payload.sha256,
    status: row.payload.status,
  } : null;
}

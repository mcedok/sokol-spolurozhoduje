import type { Sql } from "postgres";
import type { ReadinessSnapshot } from "./readiness-policy";

export interface ConversionReviewRow {
  versionId: string;
  documentId: string;
  ownerAdminId: string;
  documentStatus: string;
  versionStatus: string;
  rowVersion: number;
  reviewCompletedAt: string | null;
  readiness: ReadinessSnapshot;
}

export async function findConversionReview(
  sql: Sql,
  versionId: string,
  lock = false,
): Promise<ConversionReviewRow | null> {
  const rows = await sql.unsafe<{
    version_id: string;
    document_id: string;
    owner_admin_id: string;
    document_status: string;
    version_status: string;
    row_version: number;
    review_completed_at: Date | null;
    av_status: ReadinessSnapshot["avStatus"];
    job_status: string;
    block_count: number;
    open_blocking_findings: number;
    unconfirmed_tables: number;
    missing_alt_texts: number;
    missing_table_assets: number;
  }[]>(`
      select version.id as version_id, version.document_id, document.owner_admin_id,
        document.status::text as document_status,
        version.status::text as version_status, version.row_version, version.review_completed_at,
        original.av_status,
        coalesce(job.status, 'queued') as job_status,
        (select count(*)::int from block_revisions revision
          where revision.document_version_id=version.id and revision.superseded_at is null) as block_count,
        (select count(*)::int from conversion_findings finding
          where finding.conversion_job_id=job.id and finding.severity='blocking'
            and finding.status='open') as open_blocking_findings,
        (select count(*)::int from block_revisions revision
          where revision.document_version_id=version.id and revision.superseded_at is null
            and revision.block_type='table'
            and coalesce(revision.structured_content->>'confirmedRepresentation', '')
              not in ('html', 'image_with_attachment', 'attachment_only')) as unconfirmed_tables,
        (select count(*)::int from block_assets asset
          join block_revisions revision on revision.block_revision_id=asset.block_revision_id
          where revision.document_version_id=version.id and revision.superseded_at is null
            and asset.purpose='table_image'
            and asset.table_representation='image_with_attachment'
            and length(trim(coalesce(asset.alternative_text,'')))=0) as missing_alt_texts
        ,(select count(*)::int from block_revisions revision
          where revision.document_version_id=version.id and revision.superseded_at is null
            and revision.block_type='table' and (
              (revision.structured_content->>'confirmedRepresentation'='image_with_attachment'
                and (not exists (
                  select 1 from block_assets asset where asset.block_revision_id=revision.block_revision_id
                    and asset.purpose='table_image'
                ) or not exists (
                  select 1 from block_assets asset where asset.block_revision_id=revision.block_revision_id
                    and asset.purpose='attachment'
                )))
              or (revision.structured_content->>'confirmedRepresentation'='attachment_only'
                and not exists (
                  select 1 from block_assets asset where asset.block_revision_id=revision.block_revision_id
                    and asset.purpose='attachment'
                ))
            )) as missing_table_assets
      from document_versions version
      join documents document on document.id=version.document_id
      left join file_objects original on original.id=version.original_file_id
      left join conversion_jobs job on job.id=version.current_conversion_job_id
      where version.id=$1
      ${lock ? "for update of version, document" : ""}
    `, [versionId]);
  const row = rows[0];
  if (!row) return null;
  return {
    versionId: row.version_id,
    documentId: row.document_id,
    ownerAdminId: row.owner_admin_id,
    documentStatus: row.document_status,
    versionStatus: row.version_status,
    rowVersion: row.row_version,
    reviewCompletedAt: row.review_completed_at?.toISOString() ?? null,
    readiness: {
      avStatus: row.av_status ?? "pending",
      jobStatus: row.job_status,
      blockCount: row.block_count,
      openBlockingFindings: row.open_blocking_findings,
      unconfirmedTables: row.unconfirmed_tables,
      missingAltTexts: row.missing_alt_texts,
      missingTableAssets: row.missing_table_assets,
    },
  };
}

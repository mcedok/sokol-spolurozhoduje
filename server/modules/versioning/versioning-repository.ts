import type { Sql } from "postgres";
import type { BlockMappingRun } from "../../../contracts";
import type { MatchableBlock } from "./block-matcher";

export interface VersionPairRow {
  document_id: string;
  owner_admin_id: string;
  source_version_id: string;
  target_version_id: string;
  source_version_number: number;
  target_version_number: number;
  source_status: string;
  target_status: string;
}

interface MappingRunRow {
  id: string;
  document_id: string;
  source_version_id: string;
  target_version_id: string;
  algorithm_version: string;
  status: "review_required" | "confirmed" | "failed";
  row_version: number;
  command_hash: string;
}

interface MappingRow {
  id: string;
  source_block_revision_id: string | null;
  target_block_revision_id: string | null;
  source_text: string | null;
  target_text: string | null;
  relation: BlockMappingRun["mappings"][number]["relation"];
  confidence: string;
  method: BlockMappingRun["mappings"][number]["method"];
  review_status: BlockMappingRun["mappings"][number]["reviewStatus"];
  row_version: number;
}

export interface MappingDecisionRow {
  id: string;
  run_id: string;
  source_block_revision_id: string | null;
  target_block_revision_id: string | null;
  review_status: BlockMappingRun["mappings"][number]["reviewStatus"];
  row_version: number;
  document_id: string;
  owner_admin_id: string;
  target_version_id: string;
  run_row_version: number;
}

export async function findVersionPair(
  sql: Sql,
  sourceVersionId: string,
  targetVersionId: string,
): Promise<VersionPairRow | null> {
  const [row] = await sql<VersionPairRow[]>`
    select document.id as document_id, document.owner_admin_id,
      source.id as source_version_id, target.id as target_version_id,
      source.version_number as source_version_number,
      target.version_number as target_version_number,
      source.status::text as source_status, target.status::text as target_status
    from document_versions source
    join document_versions target on target.document_id = source.document_id
    join documents document on document.id = source.document_id
    where source.id = ${sourceVersionId} and target.id = ${targetVersionId}
    for update of source, target, document
  `;
  return row ?? null;
}

export async function findPreviousReadyVersion(
  sql: Sql,
  targetVersionId: string,
): Promise<{
  target_version_id: string;
  target_status: string;
  owner_admin_id: string;
  source_version_id: string | null;
} | null> {
  const [row] = await sql<{
    target_version_id: string;
    target_status: string;
    owner_admin_id: string;
    source_version_id: string | null;
  }[]>`
    select target.id as target_version_id, target.status::text as target_status,
      document.owner_admin_id, previous.id as source_version_id
    from document_versions target
    join documents document on document.id = target.document_id
    left join lateral (
      select candidate.id
      from document_versions candidate
      where candidate.document_id = target.document_id
        and candidate.version_number < target.version_number
        and candidate.status = 'ready'
      order by candidate.version_number desc, candidate.id desc
      limit 1
    ) previous on true
    where target.id = ${targetVersionId}
  `;
  return row ?? null;
}

export async function listMatchableBlocks(sql: Sql, versionId: string): Promise<MatchableBlock[]> {
  const rows = await sql<{
    block_revision_id: string;
    block_uid: string;
    block_order: number;
    block_type: string;
    plain_text: string;
    normalized_hash: string;
    source_para_id: string | null;
    source_bookmark: string | null;
    previous_source_hash: string | null;
    next_source_hash: string | null;
  }[]>`
    select revision.block_revision_id, revision.block_uid, revision.block_order,
      revision.block_type, revision.plain_text, revision.normalized_hash,
      block.source_para_id, block.source_bookmark,
      block.previous_source_hash, block.next_source_hash
    from block_revisions revision
    join document_blocks block on block.block_uid = revision.block_uid
    where revision.document_version_id = ${versionId}
      and revision.superseded_at is null
    order by revision.block_order, revision.block_revision_id
  `;
  return rows.map((row) => ({
    blockRevisionId: row.block_revision_id,
    blockUid: row.block_uid,
    order: row.block_order,
    type: row.block_type,
    plainText: row.plain_text,
    normalizedHash: row.normalized_hash,
    sourceParaId: row.source_para_id ?? undefined,
    sourceBookmark: row.source_bookmark ?? undefined,
    previousSourceHash: row.previous_source_hash ?? undefined,
    nextSourceHash: row.next_source_hash ?? undefined,
  }));
}

export async function findRunByIdempotencyKey(
  sql: Sql,
  idempotencyKey: string,
): Promise<(MappingRunRow & { idempotency_key: string }) | null> {
  const [row] = await sql<(MappingRunRow & { idempotency_key: string })[]>`
    select id, document_id, source_version_id, target_version_id,
      algorithm_version, status, row_version, command_hash, idempotency_key
    from block_mapping_runs where idempotency_key = ${idempotencyKey}
  `;
  return row ?? null;
}

export async function findRunByVersionPair(
  sql: Sql,
  sourceVersionId: string,
  targetVersionId: string,
  algorithmVersion: string,
): Promise<MappingRunRow | null> {
  const [row] = await sql<MappingRunRow[]>`
    select id, document_id, source_version_id, target_version_id,
      algorithm_version, status, row_version, command_hash
    from block_mapping_runs
    where source_version_id = ${sourceVersionId}
      and target_version_id = ${targetVersionId}
      and algorithm_version = ${algorithmVersion}
  `;
  return row ?? null;
}

export async function findMappingRun(sql: Sql, runId: string): Promise<BlockMappingRun | null> {
  const [run] = await sql<MappingRunRow[]>`
    select id, document_id, source_version_id, target_version_id,
      algorithm_version, status, row_version, command_hash
    from block_mapping_runs where id = ${runId}
  `;
  if (!run) return null;
  const mappings = await sql<MappingRow[]>`
    select mapping.id, mapping.source_block_revision_id, mapping.target_block_revision_id,
      source.plain_text as source_text, target.plain_text as target_text,
      mapping.relation, mapping.confidence::text, mapping.method,
      mapping.review_status, mapping.row_version
    from block_mappings mapping
    left join block_revisions source
      on source.block_revision_id = mapping.source_block_revision_id
    left join block_revisions target
      on target.block_revision_id = mapping.target_block_revision_id
    where mapping.run_id = ${runId}
    order by mapping.created_at, mapping.id
  `;
  return {
    id: run.id,
    documentId: run.document_id,
    sourceVersionId: run.source_version_id,
    targetVersionId: run.target_version_id,
    algorithmVersion: run.algorithm_version,
    status: run.status,
    rowVersion: run.row_version,
    mappings: mappings.map((mapping) => ({
      id: mapping.id,
      sourceRevisionIds: mapping.source_block_revision_id
        ? [mapping.source_block_revision_id]
        : [],
      targetRevisionIds: mapping.target_block_revision_id
        ? [mapping.target_block_revision_id]
        : [],
      sourceText: mapping.source_text,
      targetText: mapping.target_text,
      relation: mapping.relation,
      confidence: Number(mapping.confidence),
      method: mapping.method,
      reviewStatus: mapping.review_status,
      rowVersion: mapping.row_version,
    })),
  };
}

export async function findMappingForDecision(
  sql: Sql,
  mappingId: string,
): Promise<MappingDecisionRow | null> {
  const [row] = await sql<MappingDecisionRow[]>`
    select mapping.id, mapping.run_id, mapping.source_block_revision_id,
      mapping.target_block_revision_id, mapping.review_status, mapping.row_version,
      run.document_id, document.owner_admin_id, run.target_version_id,
      run.row_version as run_row_version
    from block_mappings mapping
    join block_mapping_runs run on run.id = mapping.run_id
    join documents document on document.id = run.document_id
    where mapping.id = ${mappingId}
    for update of mapping, run, document
  `;
  return row ?? null;
}

export async function findLatestRunForTarget(
  sql: Sql,
  targetVersionId: string,
): Promise<{ id: string; owner_admin_id: string } | null> {
  const [row] = await sql<{ id: string; owner_admin_id: string }[]>`
    select run.id, document.owner_admin_id
    from block_mapping_runs run
    join documents document on document.id = run.document_id
    where run.target_version_id = ${targetVersionId}
    order by run.created_at desc, run.id desc
    limit 1
  `;
  return row ?? null;
}

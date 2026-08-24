create table block_mapping_runs (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete restrict,
  source_version_id uuid not null references document_versions(id) on delete restrict,
  target_version_id uuid not null references document_versions(id) on delete restrict,
  algorithm_version text not null check (length(trim(algorithm_version)) > 0),
  status text not null check (status in ('review_required', 'confirmed', 'failed')),
  idempotency_key uuid not null unique,
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  created_by_user_id uuid not null references users(id) on delete restrict,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_version_id <> target_version_id),
  unique (source_version_id, target_version_id, algorithm_version)
);

create table block_mappings (
  id uuid primary key,
  run_id uuid not null references block_mapping_runs(id) on delete restrict,
  source_block_revision_id uuid references block_revisions(block_revision_id) on delete restrict,
  target_block_revision_id uuid references block_revisions(block_revision_id) on delete restrict,
  relation text not null check (relation in (
    'unchanged', 'modified', 'moved', 'split', 'merged', 'removed', 'added'
  )),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  method text not null check (method in (
    'stable_uid', 'exact_hash', 'source_identity', 'text_similarity',
    'unmatched', 'administrator'
  )),
  review_status text not null check (review_status in (
    'auto_confirmed', 'needs_review', 'confirmed', 'rejected'
  )),
  confirmed_by_user_id uuid references users(id) on delete restrict,
  decision_reason text,
  decided_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_block_revision_id is not null or target_block_revision_id is not null),
  check (
    (relation = 'added' and source_block_revision_id is null and target_block_revision_id is not null)
    or (relation = 'removed' and source_block_revision_id is not null and target_block_revision_id is null)
    or (relation not in ('added', 'removed')
      and source_block_revision_id is not null and target_block_revision_id is not null)
  ),
  check (
    review_status in ('auto_confirmed', 'needs_review')
    or (confirmed_by_user_id is not null and decided_at is not null
      and length(trim(coalesce(decision_reason, ''))) > 0)
  ),
  unique nulls not distinct (run_id, source_block_revision_id, target_block_revision_id)
);

create index block_mapping_runs_document_idx
  on block_mapping_runs(document_id, created_at desc);
create index block_mappings_run_review_idx
  on block_mappings(run_id, review_status, id);

create function assert_block_mapping_endpoints()
returns trigger language plpgsql as $$
declare
  run_source_version_id uuid;
  run_target_version_id uuid;
  actual_source_version_id uuid;
  actual_target_version_id uuid;
begin
  select run.source_version_id, run.target_version_id
    into run_source_version_id, run_target_version_id
  from block_mapping_runs run where run.id = new.run_id;

  if new.source_block_revision_id is not null then
    select revision.document_version_id into actual_source_version_id
    from block_revisions revision
    where revision.block_revision_id = new.source_block_revision_id;
    if actual_source_version_id is distinct from run_source_version_id then
      raise exception 'mapping source revision must belong to the run source version';
    end if;
  end if;

  if new.target_block_revision_id is not null then
    select revision.document_version_id into actual_target_version_id
    from block_revisions revision
    where revision.block_revision_id = new.target_block_revision_id;
    if actual_target_version_id is distinct from run_target_version_id then
      raise exception 'mapping target revision must belong to the run target version';
    end if;
  end if;
  return new;
end $$;

create trigger block_mappings_endpoint_guard
before insert or update of run_id, source_block_revision_id, target_block_revision_id
on block_mappings
for each row execute function assert_block_mapping_endpoints();

create function assert_block_mapping_run_versions()
returns trigger language plpgsql as $$
declare
  source_document_id uuid;
  target_document_id uuid;
  source_number integer;
  target_number integer;
begin
  select document_id, version_number into source_document_id, source_number
  from document_versions where id = new.source_version_id;
  select document_id, version_number into target_document_id, target_number
  from document_versions where id = new.target_version_id;

  if source_document_id is distinct from new.document_id
    or target_document_id is distinct from new.document_id then
    raise exception 'mapping versions must belong to the same document';
  end if;
  if source_number >= target_number then
    raise exception 'mapping target version must be newer than source version';
  end if;
  return new;
end $$;

create trigger block_mapping_runs_versions_guard
before insert or update of document_id, source_version_id, target_version_id
on block_mapping_runs
for each row execute function assert_block_mapping_run_versions();

create table thread_version_projections (
  id uuid primary key,
  thread_id uuid not null references comment_threads(id) on delete restrict,
  mapping_id uuid references block_mappings(id) on delete restrict,
  source_block_revision_id uuid not null references block_revisions(block_revision_id) on delete restrict,
  target_document_version_id uuid not null references document_versions(id) on delete restrict,
  target_block_revision_id uuid references block_revisions(block_revision_id) on delete restrict,
  status text not null check (status in (
    'auto_projected', 'needs_review', 'confirmed', 'no_target'
  )),
  decided_by_user_id uuid references users(id) on delete restrict,
  decision_reason text,
  decided_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'no_target' and target_block_revision_id is null)
    or (status <> 'no_target' and target_block_revision_id is not null)
  ),
  check (
    status in ('auto_projected', 'needs_review')
    or (decided_by_user_id is not null and decided_at is not null
      and length(trim(coalesce(decision_reason, ''))) > 0)
  )
);

create unique index thread_version_projections_current_target_key
  on thread_version_projections (
    thread_id, target_document_version_id, coalesce(target_block_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where superseded_at is null;
create index thread_version_projections_target_idx
  on thread_version_projections(target_document_version_id, status, thread_id)
  where superseded_at is null;

create function assert_thread_projection_consistency()
returns trigger language plpgsql as $$
declare
  thread_document_id uuid;
  thread_source_revision_id uuid;
  target_document_id uuid;
  actual_target_version_id uuid;
begin
  select thread.document_id, thread.target_block_revision_id
    into thread_document_id, thread_source_revision_id
  from comment_threads thread where thread.id = new.thread_id;

  select version.document_id into target_document_id
  from document_versions version where version.id = new.target_document_version_id;

  if thread_source_revision_id is distinct from new.source_block_revision_id then
    raise exception 'projection source must remain the original thread revision';
  end if;
  if thread_document_id is distinct from target_document_id then
    raise exception 'projection target version must belong to the thread document';
  end if;

  if new.target_block_revision_id is not null then
    select revision.document_version_id into actual_target_version_id
    from block_revisions revision
    where revision.block_revision_id = new.target_block_revision_id;
    if actual_target_version_id is distinct from new.target_document_version_id then
      raise exception 'projection target revision must belong to the target version';
    end if;
  end if;
  return new;
end $$;

create trigger thread_version_projections_consistency_guard
before insert or update of thread_id, source_block_revision_id,
  target_document_version_id, target_block_revision_id
on thread_version_projections
for each row execute function assert_thread_projection_consistency();

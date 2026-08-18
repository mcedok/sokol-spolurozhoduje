create table export_jobs (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete restrict,
  document_version_id uuid not null references document_versions(id) on delete restrict,
  visibility text not null check (visibility in ('public', 'internal')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  filters jsonb not null,
  options jsonb not null,
  snapshot jsonb not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by_user_id uuid not null references users(id) on delete restrict,
  idempotency_key uuid not null unique,
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  output_file_id uuid references file_objects(id) on delete restrict,
  pdfa_validated boolean,
  validation_report jsonb,
  error_code text,
  error_detail text,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'completed') = (output_file_id is not null and completed_at is not null)),
  check (status <> 'completed' or pdfa_validated is true)
);

create index export_jobs_document_idx on export_jobs(document_id, created_at desc);
create index export_jobs_status_idx on export_jobs(status, created_at, id);

create function guard_export_snapshot_immutable()
returns trigger language plpgsql as $$
begin
  if old.document_id is distinct from new.document_id
    or old.document_version_id is distinct from new.document_version_id
    or old.visibility is distinct from new.visibility
    or old.filters is distinct from new.filters
    or old.options is distinct from new.options
    or old.snapshot is distinct from new.snapshot
    or old.snapshot_sha256 is distinct from new.snapshot_sha256
    or old.requested_by_user_id is distinct from new.requested_by_user_id
    or old.idempotency_key is distinct from new.idempotency_key
    or old.command_hash is distinct from new.command_hash then
    raise exception 'export snapshot fields are immutable';
  end if;
  return new;
end $$;

create trigger export_snapshot_immutable
before update on export_jobs
for each row execute function guard_export_snapshot_immutable();

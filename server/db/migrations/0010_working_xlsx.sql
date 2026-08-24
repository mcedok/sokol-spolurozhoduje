alter table file_objects drop constraint file_objects_purpose_check;
alter table file_objects add constraint file_objects_purpose_check check (purpose in (
  'original_docx', 'reference_render', 'table_image', 'attachment', 'pdf_export',
  'xlsx_export', 'xlsx_import'
));

alter table settlements drop constraint settlements_comment_id_key;
alter table settlements
  add column declared_settlement_date date,
  add column voided_at timestamptz,
  add column voided_by_user_id uuid references users(id) on delete restrict,
  add column void_reason text,
  add constraint settlements_void_guard check (
    (voided_at is null and voided_by_user_id is null and void_reason is null)
    or (voided_at is not null and voided_by_user_id is not null
      and length(trim(void_reason)) > 0)
  );

create unique index settlements_one_active_per_comment_idx
  on settlements(comment_id)
  where voided_at is null;

alter table settlement_revisions
  add column previous_responsible_user_id uuid references users(id) on delete restrict,
  add column previous_target_document_version_id uuid references document_versions(id) on delete restrict,
  add column previous_declared_settlement_date date;

create table xlsx_export_jobs (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete restrict,
  document_version_id uuid not null references document_versions(id) on delete restrict,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  schema_version text not null check (length(trim(schema_version)) > 0),
  snapshot jsonb not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  row_count integer not null check (row_count between 0 and 1000),
  requested_by_user_id uuid not null references users(id) on delete restrict,
  idempotency_key uuid not null unique,
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  output_file_id uuid references file_objects(id) on delete restrict,
  signing_key_id text not null check (length(trim(signing_key_id)) > 0),
  error_code text,
  error_detail text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'completed') = (output_file_id is not null and completed_at is not null))
);

create index xlsx_export_jobs_queue_idx
  on xlsx_export_jobs(created_at, id)
  where status in ('queued', 'processing');

create table xlsx_import_batches (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete restrict,
  export_job_id uuid not null references xlsx_export_jobs(id) on delete restrict,
  input_file_id uuid not null references file_objects(id) on delete restrict,
  status text not null default 'uploaded' check (status in (
    'uploaded', 'scanning', 'validating', 'comparing', 'applying_safe',
    'awaiting_resolution', 'applying_conflicts', 'completed', 'failed', 'cancelled'
  )),
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text,
  signing_key_id text,
  row_count integer not null default 0 check (row_count between 0 and 1000),
  counts jsonb not null default '{"unchanged":0,"safeChange":0,"alreadyCurrent":0,"conflict":0,"invalid":0}',
  uploaded_by_user_id uuid not null references users(id) on delete restrict,
  actor_session_id uuid not null references sessions(id) on delete restrict,
  idempotency_key uuid not null unique,
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  started_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  error_code text,
  error_detail text
);

create index xlsx_import_batches_document_idx
  on xlsx_import_batches(document_id, created_at desc);

create index xlsx_import_batches_queue_idx
  on xlsx_import_batches(created_at, id)
  where status in ('uploaded', 'scanning', 'validating');

create table xlsx_import_stage_events (
  id uuid primary key,
  batch_id uuid not null references xlsx_import_batches(id) on delete restrict,
  event_type text not null check (event_type in (
    'claimed', 'archived', 'compared', 'safe_applied', 'failed'
  )),
  status text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index xlsx_import_stage_events_batch_idx
  on xlsx_import_stage_events(batch_id, created_at, id);

create trigger xlsx_import_stage_events_append_only
before update or delete on xlsx_import_stage_events
for each row execute function prevent_comment_history_mutation();

create table comment_attribute_revisions (
  id uuid primary key,
  comment_id uuid not null references comments(id) on delete restrict,
  previous_type text not null check (previous_type in ('comment', 'proposal', 'question')),
  previous_priority text not null check (previous_priority in ('low', 'normal', 'high', 'critical')),
  edited_by_user_id uuid not null references users(id) on delete restrict,
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);

create index comment_attribute_revisions_comment_idx
  on comment_attribute_revisions(comment_id, created_at, id);

create trigger comment_attribute_revisions_append_only
before update or delete on comment_attribute_revisions
for each row execute function prevent_comment_history_mutation();

create table xlsx_import_rows (
  id uuid primary key,
  batch_id uuid not null references xlsx_import_batches(id) on delete restrict,
  source_row_number integer not null check (source_row_number > 0),
  comment_id uuid not null references comments(id) on delete restrict,
  source_comment_row_version integer not null check (source_comment_row_version > 0),
  source_settlement_row_version integer,
  base_values jsonb not null,
  current_values jsonb not null,
  incoming_values jsonb not null,
  classification text not null check (classification in (
    'unchanged', 'safe_change', 'already_current', 'conflict', 'invalid', 'structural_error'
  )),
  validation_errors jsonb not null default '[]',
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, comment_id),
  unique (batch_id, source_row_number)
);

create index xlsx_import_rows_classification_idx
  on xlsx_import_rows(batch_id, classification, source_row_number);

create table xlsx_import_decisions (
  id uuid primary key,
  import_row_id uuid not null references xlsx_import_rows(id) on delete restrict,
  decision text not null check (decision in ('keep_system', 'use_xlsx')),
  decided_by_user_id uuid not null references users(id) on delete restrict,
  expected_row_version integer not null check (expected_row_version > 0),
  reason text,
  idempotency_key uuid not null unique,
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

create index xlsx_import_decisions_row_idx
  on xlsx_import_decisions(import_row_id, created_at desc, id desc);

create table xlsx_apply_runs (
  id uuid primary key,
  batch_id uuid not null references xlsx_import_batches(id) on delete restrict,
  phase text not null check (phase in ('safe_changes', 'conflict_resolutions')),
  status text not null check (status in ('processing', 'completed', 'rolled_back', 'failed')),
  expected_batch_row_version integer not null check (expected_batch_row_version > 0),
  actor_user_id uuid not null references users(id) on delete restrict,
  correlation_id uuid not null,
  idempotency_key uuid not null unique,
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  applied_count integer not null default 0 check (applied_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table xlsx_row_applications (
  id uuid primary key,
  apply_run_id uuid not null references xlsx_apply_runs(id) on delete restrict,
  import_row_id uuid not null references xlsx_import_rows(id) on delete restrict,
  result text not null check (result in ('applied', 'kept_system', 'skipped', 'failed')),
  before_sha256 text not null check (before_sha256 ~ '^[a-f0-9]{64}$'),
  after_sha256 text,
  domain_revision_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (apply_run_id, import_row_id)
);

create trigger xlsx_import_decisions_append_only
before update or delete on xlsx_import_decisions
for each row execute function prevent_comment_history_mutation();

create trigger xlsx_row_applications_append_only
before update or delete on xlsx_row_applications
for each row execute function prevent_comment_history_mutation();

create function guard_xlsx_apply_run_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.status <> 'processing' or new.status not in ('completed', 'failed') then
    raise exception 'xlsx apply runs are append-only after completion';
  end if;
  return new;
end;
$$;

create trigger xlsx_apply_runs_guard
before update or delete on xlsx_apply_runs
for each row execute function guard_xlsx_apply_run_mutation();

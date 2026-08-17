create table file_objects (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete restrict,
  data_owner_user_id uuid not null references users(id) on delete restrict,
  purpose text not null check (purpose in (
    'original_docx', 'reference_render', 'table_image', 'attachment'
  )),
  container text not null check (container in ('quarantine', 'originals', 'derivatives')),
  object_key text not null unique,
  original_name text not null,
  declared_mime text not null,
  detected_mime text,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  etag text,
  av_status text not null default 'pending'
    check (av_status in ('pending', 'clean', 'infected', 'error')),
  av_checked_at timestamptz,
  av_result_code text,
  object_status text not null default 'quarantined'
    check (object_status in ('quarantined', 'archived', 'derivative', 'rejected', 'deleted')),
  retention_class text not null default 'document',
  legal_hold boolean not null default false,
  deleted_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (object_status <> 'deleted' or deleted_at is not null)
);

create table document_versions (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status document_status not null default 'file_check'
    check (status in ('file_check', 'conversion', 'conversion_review', 'ready')),
  original_file_id uuid references file_objects(id) on delete restrict,
  conversion_profile text not null default 'docx-web-v1',
  web_content_sha256 text check (
    web_content_sha256 is null or web_content_sha256 ~ '^[a-f0-9]{64}$'
  ),
  current_conversion_job_id uuid,
  created_by_user_id uuid not null references users(id) on delete restrict,
  review_completed_by_user_id uuid references users(id) on delete restrict,
  review_completed_at timestamptz,
  published_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, version_number)
);

create table conversion_jobs (
  id uuid primary key,
  document_version_id uuid not null references document_versions(id) on delete restrict,
  status text not null default 'queued' check (status in (
    'queued', 'leased', 'scanning', 'archiving', 'parsing', 'rendering',
    'analyzing', 'completed', 'retry_wait', 'failed', 'rejected'
  )),
  current_step text not null default 'file_check',
  parser_version text,
  libreoffice_version text,
  antivirus_version text,
  profile_version text not null,
  attempt_count integer not null default 0 check (attempt_count between 0 and 4),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key uuid not null unique,
  error_code text,
  correlation_id uuid not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table document_versions
  add constraint document_versions_current_job_fk
  foreign key (current_conversion_job_id) references conversion_jobs(id) on delete restrict;

create table document_blocks (
  block_uid uuid primary key,
  document_id uuid not null references documents(id) on delete restrict,
  source_bookmark text,
  source_para_id text,
  heading_path jsonb not null default '[]',
  previous_source_hash text,
  next_source_hash text,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

create table block_revisions (
  block_revision_id uuid primary key,
  block_uid uuid not null references document_blocks(block_uid) on delete restrict,
  document_version_id uuid not null references document_versions(id) on delete restrict,
  block_order integer not null check (block_order >= 0),
  block_type text not null check (block_type in (
    'heading', 'paragraph', 'list_item', 'table', 'table_image',
    'attachment_reference', 'quote', 'callout', 'technical_separator'
  )),
  structured_content jsonb not null,
  plain_text text not null,
  normalized_hash text not null check (normalized_hash ~ '^[a-f0-9]{64}$'),
  commentable boolean not null default true,
  source_range jsonb,
  parser_version text not null,
  revision_origin text not null check (revision_origin in ('converted', 'admin_structure_edit')),
  created_by_user_id uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint block_revisions_version_order_key unique (document_version_id, block_order),
  constraint block_revisions_version_block_key unique (document_version_id, block_uid)
);

create table conversion_findings (
  id uuid primary key,
  conversion_job_id uuid not null references conversion_jobs(id) on delete restrict,
  block_uid uuid references document_blocks(block_uid) on delete restrict,
  source_location jsonb,
  code text not null check (code ~ '^[A-Z][A-Z0-9_]+$'),
  severity text not null check (severity in ('info', 'warning', 'blocking')),
  message text not null check (length(trim(message)) > 0),
  diagnostics jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'accepted', 'resolved')),
  decided_by_user_id uuid references users(id) on delete restrict,
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (severity <> 'blocking' or status <> 'accepted'),
  check (status = 'open' or length(trim(coalesce(decision_reason, ''))) > 0)
);

create table block_assets (
  id uuid primary key,
  block_revision_id uuid not null references block_revisions(block_revision_id) on delete restrict,
  file_object_id uuid not null references file_objects(id) on delete restrict,
  purpose text not null check (purpose in ('table_image', 'reference_page', 'attachment')),
  asset_order integer not null default 0 check (asset_order >= 0),
  alternative_text text,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  table_representation text check (
    table_representation in ('html', 'image_with_attachment', 'attachment_only')
  ),
  created_at timestamptz not null default now(),
  unique (block_revision_id, asset_order)
);

create table block_edit_revisions (
  id uuid primary key,
  document_version_id uuid not null references document_versions(id) on delete restrict,
  block_uid uuid not null references document_blocks(block_uid) on delete restrict,
  previous_block_revision_id uuid not null references block_revisions(block_revision_id) on delete restrict,
  new_block_revision_id uuid not null references block_revisions(block_revision_id) on delete restrict,
  change_type text not null check (change_type in (
    'type', 'boundaries', 'order', 'commentable', 'separator',
    'table_representation', 'alternative_text'
  )),
  before_structure jsonb not null,
  after_structure jsonb not null,
  actor_user_id uuid not null references users(id) on delete restrict,
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);

create table security_events (
  id uuid primary key,
  actor_user_id uuid references users(id) on delete restrict,
  file_object_id uuid references file_objects(id) on delete restrict,
  code text not null check (code ~ '^[A-Z][A-Z0-9_]+$'),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  metadata jsonb not null default '{}',
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);

create index file_objects_document_status_idx
  on file_objects(document_id, object_status, created_at);
create index file_objects_rejected_retention_idx
  on file_objects(created_at) where object_status = 'rejected' and legal_hold = false;
create index document_versions_document_idx
  on document_versions(document_id, version_number desc);
create index conversion_jobs_available_idx
  on conversion_jobs(next_attempt_at, created_at)
  where status in ('queued', 'retry_wait');
create index conversion_findings_job_status_idx
  on conversion_findings(conversion_job_id, status, severity);
create index block_revisions_version_idx
  on block_revisions(document_version_id, block_order);
create index security_events_file_idx
  on security_events(file_object_id, created_at desc);

create table comment_threads (
  id uuid primary key,
  public_id text not null unique check (public_id ~ '^VLAK-[0-9]{4}-[0-9]{6,}$'),
  document_id uuid not null references documents(id) on delete restrict,
  block_uid uuid not null references document_blocks(block_uid) on delete restrict,
  target_block_revision_id uuid not null references block_revisions(block_revision_id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'locked', 'hidden', 'resolved')),
  created_by_user_id uuid not null references users(id) on delete restrict,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table comments (
  id uuid primary key,
  public_id text not null unique check (public_id ~ '^PRIP-[0-9]{4}-[0-9]{6,}$'),
  thread_id uuid not null references comment_threads(id) on delete restrict,
  parent_comment_id uuid,
  author_user_id uuid not null references users(id) on delete restrict,
  author_name_snapshot text not null check (length(trim(author_name_snapshot)) > 0),
  organization_name_snapshot text not null check (length(trim(organization_name_snapshot)) > 0),
  body text not null check (length(trim(body)) > 0),
  comment_type text not null check (comment_type in ('comment', 'proposal', 'question')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'critical')),
  status text not null default 'open' check (status in (
    'open', 'under_review', 'settled', 'withdrawn', 'hidden'
  )),
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, thread_id),
  foreign key (parent_comment_id, thread_id)
    references comments(id, thread_id) on delete restrict,
  check (parent_comment_id is null or parent_comment_id <> id)
);

create table comment_revisions (
  id uuid primary key,
  comment_id uuid not null references comments(id) on delete restrict,
  previous_body text not null check (length(trim(previous_body)) > 0),
  edited_by_user_id uuid not null references users(id) on delete restrict,
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);

create table comment_status_transitions (
  id uuid primary key,
  comment_id uuid not null references comments(id) on delete restrict,
  from_status text check (from_status is null or from_status in (
    'open', 'under_review', 'settled', 'withdrawn', 'hidden'
  )),
  to_status text not null check (to_status in (
    'open', 'under_review', 'settled', 'withdrawn', 'hidden'
  )),
  actor_user_id uuid not null references users(id) on delete restrict,
  reason text,
  created_at timestamptz not null default now()
);

create table settlements (
  id uuid primary key,
  comment_id uuid not null unique references comments(id) on delete restrict,
  outcome text not null check (outcome in (
    'accepted', 'partially_accepted', 'rejected', 'explained_no_change',
    'duplicate', 'out_of_scope', 'withdrawn'
  )),
  statement text not null check (length(trim(statement)) > 0),
  responsible_user_id uuid not null references users(id) on delete restrict,
  settled_by_user_id uuid not null references users(id) on delete restrict,
  target_document_version_id uuid references document_versions(id) on delete restrict,
  internal_note text,
  settled_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table settlement_revisions (
  id uuid primary key,
  settlement_id uuid not null references settlements(id) on delete restrict,
  previous_outcome text not null check (previous_outcome in (
    'accepted', 'partially_accepted', 'rejected', 'explained_no_change',
    'duplicate', 'out_of_scope', 'withdrawn'
  )),
  previous_statement text not null check (length(trim(previous_statement)) > 0),
  previous_internal_note text,
  edited_by_user_id uuid not null references users(id) on delete restrict,
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);

create table settlement_block_links (
  settlement_id uuid not null references settlements(id) on delete restrict,
  block_revision_id uuid not null references block_revisions(block_revision_id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (settlement_id, block_revision_id)
);

create index comment_threads_document_idx
  on comment_threads(document_id, created_at, id);
create index comments_thread_idx
  on comments(thread_id, created_at, id);
create index comments_status_priority_idx
  on comments(status, priority, created_at);
create index settlements_target_version_idx
  on settlements(target_document_version_id, settled_at);

create function assert_comment_thread_target_consistency()
returns trigger language plpgsql as $$
declare
  block_document_id uuid;
  revision_document_id uuid;
  revision_block_uid uuid;
begin
  select document_id into block_document_id
  from document_blocks
  where block_uid = new.block_uid;

  select dv.document_id, br.block_uid
    into revision_document_id, revision_block_uid
  from block_revisions br
  join document_versions dv on dv.id = br.document_version_id
  where br.block_revision_id = new.target_block_revision_id;

  if block_document_id is distinct from new.document_id
    or revision_document_id is distinct from new.document_id
    or revision_block_uid is distinct from new.block_uid then
    raise exception 'comment thread target must belong to the same document and block';
  end if;
  return new;
end $$;

create trigger comment_threads_target_guard
before insert or update of document_id, block_uid, target_block_revision_id
on comment_threads
for each row execute function assert_comment_thread_target_consistency();

create function assert_settlement_target_consistency()
returns trigger language plpgsql as $$
declare
  comment_document_id uuid;
  target_document_id uuid;
begin
  if new.target_document_version_id is null then
    return new;
  end if;

  select ct.document_id into comment_document_id
  from comments c
  join comment_threads ct on ct.id = c.thread_id
  where c.id = new.comment_id;

  select document_id into target_document_id
  from document_versions
  where id = new.target_document_version_id;

  if comment_document_id is distinct from target_document_id then
    raise exception 'settlement target version must belong to the same document';
  end if;
  return new;
end $$;

create trigger settlements_target_guard
before insert or update of comment_id, target_document_version_id
on settlements
for each row execute function assert_settlement_target_consistency();

create function prevent_comment_history_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'comment history is append-only';
end $$;

create trigger comment_revisions_append_only
before update or delete on comment_revisions
for each row execute function prevent_comment_history_mutation();

create trigger comment_status_transitions_append_only
before update or delete on comment_status_transitions
for each row execute function prevent_comment_history_mutation();

create trigger settlement_revisions_append_only
before update or delete on settlement_revisions
for each row execute function prevent_comment_history_mutation();

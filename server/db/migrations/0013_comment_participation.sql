alter table documents
  add column participation_version integer not null default 1
  check (participation_version > 0);

create table participation_sequences (
  year integer primary key check (year between 2000 and 9999),
  thread_last_value bigint not null default 0 check (thread_last_value >= 0),
  comment_last_value bigint not null default 0 check (comment_last_value >= 0)
);

create table comment_votes (
  comment_id uuid not null references comments(id) on delete restrict,
  user_id uuid not null references users(id) on delete restrict,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create table document_need_votes (
  document_id uuid not null references documents(id) on delete restrict,
  user_id uuid not null references users(id) on delete restrict,
  value text not null check (value in ('yes', 'no')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (document_id, user_id)
);

create index comment_votes_comment_idx on comment_votes(comment_id, value);
create index document_need_votes_document_idx on document_need_votes(document_id, value);

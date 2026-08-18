create table document_sequences (
  year integer primary key check (year between 2020 and 2200),
  last_value integer not null check (last_value > 0)
);

alter table documents add column closure_reason text not null default '';

create table document_approvals (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete restrict,
  requested_by_user_id uuid not null references users(id) on delete restrict,
  requested_status document_status not null,
  requested_row_version integer not null,
  decided_by_user_id uuid references users(id) on delete restrict,
  decision text check (decision in ('approved', 'rejected')),
  reason text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  check (
    (decision is null and decided_at is null)
    or (decision is not null and decided_at is not null)
  )
);

create unique index document_approvals_pending_idx
on document_approvals(document_id, requested_status)
where decision is null;

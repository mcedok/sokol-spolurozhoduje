create extension if not exists pgcrypto;
create extension if not exists citext;

do $$ begin
  create type user_role as enum ('member', 'admin', 'superadmin');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type user_status as enum ('invited', 'pending_verification', 'active', 'blocked');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type document_status as enum (
    'concept', 'file_check', 'conversion', 'conversion_review', 'ready',
    'published_open', 'comments_closed', 'settlement', 'settled',
    'approved', 'rejected', 'archived'
  );
exception when duplicate_object then null;
end $$;

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  first_name text not null check (length(trim(first_name)) > 0),
  last_name text not null check (length(trim(last_name)) > 0),
  email citext not null unique,
  membership_id text,
  role user_role not null,
  status user_status not null,
  email_verified_at timestamptz,
  last_login_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table admin_credentials (
  user_id uuid primary key references users(id) on delete restrict,
  password_hash text not null,
  totp_secret_ciphertext bytea,
  totp_enabled_at timestamptz,
  password_updated_at timestamptz not null default now()
);

create table login_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  pending_email citext,
  kind text not null check (kind in (
    'member_code', 'set_password', 'reset_password', 'admin_mfa', 'mfa_enrollment'
  )),
  secret_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  used_at timestamptz,
  locked_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (user_id is not null or pending_email is not null)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  csrf_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_from_id uuid references sessions(id)
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  number text not null unique check (number ~ '^SOKOL-[0-9]{4}-[0-9]{3,}$'),
  title text not null check (length(trim(title)) > 0),
  explanatory_report text not null default '',
  owner_admin_id uuid not null references users(id) on delete restrict,
  status document_status not null default 'concept',
  comments_open boolean not null default false,
  visibility_mode text not null default 'public_detail'
    check (visibility_mode in ('public_detail', 'login_required_detail')),
  four_eyes_required boolean not null default false,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table document_state_transitions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete restrict,
  actor_user_id uuid not null references users(id) on delete restrict,
  from_status document_status,
  to_status document_status not null,
  reason text,
  created_at timestamptz not null default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete restrict,
  actor_role user_role,
  action text not null,
  target_type text not null,
  target_id uuid,
  outcome text not null check (outcome in ('allowed', 'denied')),
  correlation_id uuid not null,
  metadata jsonb not null default '{}',
  previous_hash text,
  event_hash text not null unique,
  created_at timestamptz not null default now()
);

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  payload jsonb not null,
  idempotency_key uuid not null unique,
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);

create index users_role_status_idx on users(role, status);
create index documents_owner_status_idx on documents(owner_admin_id, status);
create index login_challenges_user_kind_idx
  on login_challenges(user_id, kind, created_at desc);
create index sessions_user_active_idx
  on sessions(user_id, expires_at) where revoked_at is null;
create index audit_events_target_idx
  on audit_events(target_type, target_id, created_at);
create index outbox_pending_idx
  on outbox_events(available_at) where processed_at is null;

create function assert_document_owner_is_admin() returns trigger language plpgsql as $$
declare
  owner_role user_role;
  owner_status user_status;
begin
  select role, status into owner_role, owner_status
  from users
  where id = new.owner_admin_id;

  if owner_role is null
    or owner_role not in ('admin', 'superadmin')
    or owner_status <> 'active' then
    raise exception 'document owner must be an active administrator';
  end if;
  return new;
end $$;

create trigger documents_owner_guard
before insert or update of owner_admin_id on documents
for each row execute function assert_document_owner_is_admin();

alter table audit_events add column chain_sequence bigint;

with recursive audit_chain as (
  select id, event_hash, 1::bigint chain_sequence
  from audit_events
  where previous_hash is null
  union all
  select child.id, child.event_hash, parent.chain_sequence + 1
  from audit_chain parent
  join audit_events child on child.previous_hash = parent.event_hash
)
update audit_events event
set chain_sequence = chain.chain_sequence
from audit_chain chain
where event.id = chain.id;

do $$
declare
  event_count bigint;
  root_count bigint;
  sequenced_count bigint;
  distinct_sequence_count bigint;
begin
  select count(*), count(*) filter (where previous_hash is null),
    count(chain_sequence), count(distinct chain_sequence)
  into event_count, root_count, sequenced_count, distinct_sequence_count
  from audit_events;
  if event_count > 0 and (
    root_count <> 1 or sequenced_count <> event_count
    or distinct_sequence_count <> event_count
  ) then
    raise exception 'existing audit hash chain is not linear; migration requires explicit repair';
  end if;
end $$;

create sequence audit_events_chain_sequence_seq;
select setval(
  'audit_events_chain_sequence_seq',
  coalesce((select max(chain_sequence) + 1 from audit_events), 1),
  false
);
alter sequence audit_events_chain_sequence_seq owned by audit_events.chain_sequence;
alter table audit_events
  alter column chain_sequence set default nextval('audit_events_chain_sequence_seq'),
  alter column chain_sequence set not null;

create unique index audit_events_chain_sequence_uq
  on audit_events(chain_sequence);

create function prevent_audit_event_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit events are append-only' using errcode = 'P0001';
end $$;

create trigger audit_events_append_only
before update or delete on audit_events
for each row execute function prevent_audit_event_mutation();

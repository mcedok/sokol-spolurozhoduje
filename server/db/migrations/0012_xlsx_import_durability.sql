alter table xlsx_import_batches
  add column lease_token uuid,
  add column safe_apply_correlation_id uuid,
  add column safe_apply_idempotency_key uuid unique,
  add column safe_apply_lease_token uuid,
  add column safe_apply_next_attempt_at timestamptz,
  add column safe_apply_attempt_count integer not null default 0
    check (safe_apply_attempt_count >= 0),
  add constraint xlsx_import_safe_apply_command_guard check (
    (safe_apply_correlation_id is null and safe_apply_idempotency_key is null)
    or (safe_apply_correlation_id is not null and safe_apply_idempotency_key is not null)
  );

update xlsx_import_batches
set safe_apply_correlation_id = gen_random_uuid(),
  safe_apply_idempotency_key = gen_random_uuid(),
  safe_apply_next_attempt_at = now()
where status = 'comparing' and safe_apply_correlation_id is null;

create index xlsx_import_batches_safe_apply_queue_idx
  on xlsx_import_batches(created_at, id)
  where status = 'comparing';

alter table xlsx_import_rows
  add column current_comment_row_version integer not null default 1
    check (current_comment_row_version > 0),
  add column current_settlement_row_version integer
    check (current_settlement_row_version is null or current_settlement_row_version > 0);

update xlsx_import_rows staged
set current_comment_row_version = comment_row.row_version
from comments comment_row
where comment_row.id = staged.comment_id;

update xlsx_import_rows staged
set current_settlement_row_version = settlement.row_version
from settlements settlement
where settlement.comment_id = staged.comment_id and settlement.voided_at is null;

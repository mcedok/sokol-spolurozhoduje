alter table block_revisions
  add column superseded_at timestamptz;

alter table block_revisions
  drop constraint block_revisions_version_order_key,
  drop constraint block_revisions_version_block_key;

create unique index block_revisions_current_order_key
  on block_revisions(document_version_id, block_order)
  where superseded_at is null;

create unique index block_revisions_current_block_key
  on block_revisions(document_version_id, block_uid)
  where superseded_at is null;

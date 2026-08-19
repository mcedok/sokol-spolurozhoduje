alter table file_objects drop constraint file_objects_purpose_check;
alter table file_objects add constraint file_objects_purpose_check check (purpose in (
  'original_docx', 'reference_render', 'table_image', 'attachment', 'pdf_export'
));

alter table export_jobs
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column lease_expires_at timestamptz;

create index export_jobs_worker_queue_idx
  on export_jobs(created_at, id)
  where status in ('queued', 'processing');

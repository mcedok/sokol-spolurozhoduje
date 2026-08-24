package cz.sokol.conversion.pdf;

import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;

public final class JdbcPdfExportRepository implements PdfExportProcessor.Repository {
  private final DataSource dataSource;
  private final Duration leaseDuration;
  private final Supplier<Instant> clock;

  public JdbcPdfExportRepository(DataSource dataSource, Duration leaseDuration) {
    this(dataSource, leaseDuration, Instant::now);
  }

  JdbcPdfExportRepository(DataSource dataSource, Duration leaseDuration, Supplier<Instant> clock) {
    this.dataSource = dataSource;
    this.leaseDuration = leaseDuration;
    this.clock = clock;
  }

  @Override
  public Optional<PdfExportProcessor.Job> claimNext() throws SQLException {
    Instant now = clock.get();
    String sql = """
        with candidate as (
          select id from export_jobs
          where status = 'queued'
             or (status = 'processing' and lease_expires_at < ?)
          order by created_at, id
          for update skip locked limit 1
        )
        update export_jobs job
        set status='processing', started_at=coalesce(started_at, ?),
            lease_expires_at=?, attempt_count=attempt_count+1,
            error_code=null, error_detail=null, updated_at=?
        from candidate where job.id=candidate.id
        returning job.id, job.document_id, job.document_version_id,
          job.requested_by_user_id, job.snapshot::text, job.snapshot_sha256
        """;
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (var statement = connection.prepareStatement(sql)) {
        Timestamp timestamp = Timestamp.from(now);
        statement.setTimestamp(1, timestamp);
        statement.setTimestamp(2, timestamp);
        statement.setTimestamp(3, Timestamp.from(now.plus(leaseDuration)));
        statement.setTimestamp(4, timestamp);
        try (var rows = statement.executeQuery()) {
          if (!rows.next()) {
            connection.commit();
            return Optional.empty();
          }
          var job = new PdfExportProcessor.Job(
              rows.getObject("id", UUID.class),
              rows.getObject("document_id", UUID.class),
              rows.getObject("document_version_id", UUID.class),
              rows.getObject("requested_by_user_id", UUID.class),
              rows.getString("snapshot"),
              rows.getString("snapshot_sha256"));
          connection.commit();
          return Optional.of(job);
        }
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  @Override
  public void complete(
      PdfExportProcessor.Job job, UUID fileId, String container, String key, String sha256,
      long size, String etag, String validationReport) throws SQLException {
    Instant now = clock.get();
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (var statement = connection.prepareStatement("""
            insert into file_objects (
              id, document_id, data_owner_user_id, purpose, container, object_key,
              original_name, declared_mime, detected_mime, size_bytes, sha256, etag,
              av_status, av_checked_at, object_status, retention_class
            ) values (?, ?, ?, 'pdf_export', ?, ?, ?, 'application/pdf', 'application/pdf',
              ?, ?, ?, 'clean', ?, 'derivative', 'document')
            on conflict (object_key) do nothing
            """)) {
          statement.setObject(1, fileId);
          statement.setObject(2, job.documentId());
          statement.setObject(3, job.requestedByUserId());
          statement.setString(4, container);
          statement.setString(5, key);
          statement.setString(6, "pripominky-" + job.id() + ".pdf");
          statement.setLong(7, size);
          statement.setString(8, sha256);
          statement.setString(9, etag);
          statement.setTimestamp(10, Timestamp.from(now));
          statement.executeUpdate();
        }
        UUID persistedFileId;
        try (var statement = connection.prepareStatement(
            "select id from file_objects where object_key=? and sha256=? for update")) {
          statement.setString(1, key);
          statement.setString(2, sha256);
          try (var rows = statement.executeQuery()) {
            if (!rows.next()) throw new SQLException("Uložený PDF derivát nebyl nalezen.");
            persistedFileId = rows.getObject(1, UUID.class);
          }
        }
        try (var statement = connection.prepareStatement("""
            update export_jobs
            set status='completed', output_file_id=?, pdfa_validated=true,
              validation_report=jsonb_build_object('text', ?), completed_at=?,
              lease_expires_at=null, row_version=row_version+1, updated_at=?
            where id=? and status='processing' and output_file_id is null
            """)) {
          statement.setObject(1, persistedFileId);
          statement.setString(2, validationReport);
          statement.setTimestamp(3, Timestamp.from(now));
          statement.setTimestamp(4, Timestamp.from(now));
          statement.setObject(5, job.id());
          if (statement.executeUpdate() != 1) {
            throw new SQLException("PDF export již není ve zpracovatelném stavu.");
          }
        }
        connection.commit();
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  @Override
  public void fail(PdfExportProcessor.Job job, String errorCode, String detail) throws SQLException {
    Instant now = clock.get();
    try (var connection = dataSource.getConnection(); var statement = connection.prepareStatement("""
        update export_jobs set status='failed', error_code=?, error_detail=?,
          lease_expires_at=null, row_version=row_version+1, updated_at=?
        where id=? and status='processing'
        """)) {
      statement.setString(1, errorCode);
      statement.setString(2, detail);
      statement.setTimestamp(3, Timestamp.from(now));
      statement.setObject(4, job.id());
      statement.executeUpdate();
    }
  }
}

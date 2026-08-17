package cz.sokol.conversion;

import java.sql.SQLException;
import java.util.UUID;
import javax.sql.DataSource;

public final class JdbcConversionRepository implements ConversionProcessor.Repository {
  private final DataSource dataSource;

  public JdbcConversionRepository(DataSource dataSource) {
    this.dataSource = dataSource;
  }

  @Override
  public ConversionProcessor.Job load(UUID jobId) throws SQLException {
    String sql = """
        select job.id, version.document_id, version.id as version_id,
          file.id as file_id, file.container, file.object_key, file.sha256,
          file.etag, job.correlation_id
        from conversion_jobs job
        join document_versions version on version.id=job.document_version_id
        join file_objects file on file.id=version.original_file_id
        where job.id=? and job.status='leased'
        """;
    try (var connection = dataSource.getConnection(); var statement = connection.prepareStatement(sql)) {
      statement.setObject(1, jobId);
      try (var rows = statement.executeQuery()) {
        if (!rows.next()) throw new SQLException("Pronajatá převodní úloha nebyla nalezena.");
        return new ConversionProcessor.Job(
            rows.getObject("id", UUID.class),
            rows.getObject("document_id", UUID.class),
            rows.getObject("version_id", UUID.class),
            rows.getObject("file_id", UUID.class),
            rows.getString("container"),
            rows.getString("object_key"),
            rows.getString("sha256"),
            rows.getString("etag"),
            rows.getObject("correlation_id", UUID.class));
      }
    }
  }

  @Override
  public void markScanning(ConversionProcessor.Job job) throws SQLException {
    try (var connection = dataSource.getConnection(); var statement = connection.prepareStatement("""
        update conversion_jobs set status='scanning', current_step='file_check',
          started_at=coalesce(started_at,now()), updated_at=now() where id=?
        """)) {
      statement.setObject(1, job.id());
      if (statement.executeUpdate() != 1) throw new SQLException("Nelze zahájit kontrolu souboru.");
    }
  }

  @Override
  public void markRejected(ConversionProcessor.Job job, String code) throws SQLException {
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (var statement = connection.prepareStatement("""
            update file_objects set av_status='infected', av_checked_at=now(),
              av_result_code=?, object_status='rejected', updated_at=now() where id=?
            """)) {
          statement.setString(1, code);
          statement.setObject(2, job.fileId());
          statement.executeUpdate();
        }
        try (var statement = connection.prepareStatement("""
            update conversion_jobs set status='rejected', error_code=?, completed_at=now(),
              lease_owner=null, lease_expires_at=null, heartbeat_at=null, updated_at=now() where id=?
            """)) {
          statement.setString(1, code);
          statement.setObject(2, job.id());
          statement.executeUpdate();
        }
        try (var statement = connection.prepareStatement("""
            insert into security_events(id,file_object_id,code,severity,correlation_id)
            values (?,?,'MALWARE_DETECTED','critical',?)
            """)) {
          statement.setObject(1, UUID.randomUUID());
          statement.setObject(2, job.fileId());
          statement.setObject(3, job.correlationId());
          statement.executeUpdate();
        }
        connection.commit();
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  @Override
  public void markArchived(
      ConversionProcessor.Job job, String container, String objectKey, String etag) throws SQLException {
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (var statement = connection.prepareStatement("""
            update file_objects set container=?, object_key=?, etag=?, av_status='clean',
              av_checked_at=now(), av_result_code='OK', object_status='archived', updated_at=now()
            where id=?
            """)) {
          statement.setString(1, container);
          statement.setString(2, objectKey);
          statement.setString(3, etag);
          statement.setObject(4, job.fileId());
          statement.executeUpdate();
        }
        try (var statement = connection.prepareStatement("""
            update conversion_jobs set status='parsing', current_step='parsing',
              lease_owner=null, lease_expires_at=null, heartbeat_at=null, updated_at=now() where id=?
            """)) {
          statement.setObject(1, job.id());
          statement.executeUpdate();
        }
        try (var statement = connection.prepareStatement("""
            update document_versions set status='conversion', updated_at=now() where id=?
            """)) {
          statement.setObject(1, job.versionId());
          statement.executeUpdate();
        }
        connection.commit();
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }
}

package cz.sokol.conversion;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import javax.sql.DataSource;

public final class JdbcQuarantineRetentionRepository implements QuarantineRetention.Repository {
  private final DataSource dataSource;
  private final ObjectMapper json = new ObjectMapper();

  public JdbcQuarantineRetentionRepository(DataSource dataSource) {
    this.dataSource = dataSource;
  }

  @Override
  public List<QuarantineRetention.Candidate> candidates() throws SQLException {
    String sql = """
        select file.id, file.container, file.object_key, file.etag,
          file.object_status, file.legal_hold, file.created_at
        from file_objects file
        where file.container='quarantine' and file.object_status='rejected'
          and file.created_at < now() - interval '7 days' and file.legal_hold=false
          and not exists (
            select 1 from security_events security
            where security.file_object_id=file.id
              and coalesce((security.metadata->>'retention_block')::boolean,false)=true
          )
        order by file.created_at limit 100
        """;
    List<QuarantineRetention.Candidate> result = new ArrayList<>();
    try (var connection = dataSource.getConnection();
         var statement = connection.prepareStatement(sql);
         var rows = statement.executeQuery()) {
      while (rows.next()) {
        result.add(new QuarantineRetention.Candidate(
            rows.getObject("id", UUID.class),
            rows.getString("container"),
            rows.getString("object_key"),
            rows.getString("etag"),
            rows.getString("object_status"),
            rows.getBoolean("legal_hold"),
            rows.getTimestamp("created_at").toInstant()));
      }
    }
    return result;
  }

  @Override
  public void markDeleted(UUID id, Instant deletedAt) throws Exception {
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (var statement = connection.prepareStatement("""
            update file_objects set object_status='deleted', deleted_at=?, updated_at=now()
            where id=? and object_status='rejected' and legal_hold=false
            """)) {
          statement.setObject(1, java.sql.Timestamp.from(deletedAt));
          statement.setObject(2, id);
          if (statement.executeUpdate() != 1) {
            throw new SQLException("Retenční stav souboru se mezitím změnil.");
          }
        }
        appendAudit(connection, id);
        connection.commit();
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  private void appendAudit(java.sql.Connection connection, UUID targetId) throws Exception {
    try (var lock = connection.prepareStatement(
        "select pg_advisory_xact_lock(hashtext('audit_events'))")) {
      lock.execute();
    }
    String previousHash = null;
    try (var statement = connection.prepareStatement(
        "select event_hash from audit_events order by created_at desc,id desc limit 1");
         var rows = statement.executeQuery()) {
      if (rows.next()) previousHash = rows.getString(1);
    }
    UUID correlationId = UUID.randomUUID();
    Map<String, Object> event = new TreeMap<>();
    event.put("action", "file.quarantine_deleted");
    event.put("actorRole", null);
    event.put("actorUserId", null);
    event.put("correlationId", correlationId.toString());
    event.put("metadata", Map.of());
    event.put("outcome", "allowed");
    event.put("previousHash", previousHash);
    event.put("targetId", targetId.toString());
    event.put("targetType", "file_object");
    String canonical = json.writeValueAsString(event);
    String eventHash = sha256((previousHash == null ? "" : previousHash) + canonical);
    try (var statement = connection.prepareStatement("""
        insert into audit_events(
          action,target_type,target_id,outcome,correlation_id,metadata,previous_hash,event_hash)
        values ('file.quarantine_deleted','file_object',?,'allowed',?,'{}'::jsonb,?,?)
        """)) {
      statement.setObject(1, targetId);
      statement.setObject(2, correlationId);
      statement.setString(3, previousHash);
      statement.setString(4, eventHash);
      statement.executeUpdate();
    }
  }

  private static String sha256(String value) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
  }
}

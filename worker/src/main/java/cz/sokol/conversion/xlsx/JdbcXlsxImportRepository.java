package cz.sokol.conversion.xlsx;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.HexFormat;
import java.util.UUID;
import javax.sql.DataSource;

/** Durable, lease-based staging repository for untrusted working XLSX imports. */
public final class JdbcXlsxImportRepository implements XlsxImportProcessor.Repository {
  private static final int MAX_SAFE_APPLY_ATTEMPTS = 8;
  private static final int MAX_IMPORT_ATTEMPTS = 5;
  private static final Set<String> TYPES = Set.of("comment", "proposal", "question");
  private static final Set<String> PRIORITIES = Set.of("low", "normal", "high", "critical");
  private static final Set<String> STATUSES = Set.of("open", "under_review", "settled", "withdrawn", "hidden");
  private static final Set<String> OUTCOMES = Set.of("accepted", "partially_accepted", "rejected",
      "explained_no_change", "duplicate", "out_of_scope", "withdrawn");
  private final DataSource dataSource;
  private final Duration leaseDuration;
  private final ObjectMapper mapper = new ObjectMapper();

  public JdbcXlsxImportRepository(DataSource dataSource, Duration leaseDuration) {
    this.dataSource = dataSource;
    this.leaseDuration = leaseDuration;
  }

  @Override
  public Optional<XlsxImportProcessor.SafeApplyCommand> claimSafeApply() throws Exception {
    Instant now = Instant.now();
    UUID dispatchLeaseToken = UUID.randomUUID();
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      markExhaustedSafeApplies(connection, now);
      try (var statement = connection.prepareStatement("""
          with candidate as (
            select id from xlsx_import_batches
            where status='comparing'
              and safe_apply_correlation_id is not null
              and safe_apply_attempt_count < ?
              and coalesce(safe_apply_next_attempt_at, created_at) <= ?
              and (lease_expires_at is null or lease_expires_at < ?)
            order by created_at, id for update skip locked limit 1
          )
          update xlsx_import_batches batch
          set lease_expires_at=?, safe_apply_lease_token=?,
            safe_apply_attempt_count=safe_apply_attempt_count+1,
            error_code=null, error_detail=null, updated_at=?
          from candidate where batch.id=candidate.id
          returning batch.id, batch.row_version, batch.safe_apply_correlation_id,
            batch.safe_apply_idempotency_key, batch.safe_apply_lease_token
          """)) {
        statement.setInt(1, MAX_SAFE_APPLY_ATTEMPTS);
        statement.setTimestamp(2, Timestamp.from(now));
        statement.setTimestamp(3, Timestamp.from(now));
        statement.setTimestamp(4, Timestamp.from(now.plus(leaseDuration)));
        statement.setObject(5, dispatchLeaseToken);
        statement.setTimestamp(6, Timestamp.from(now));
        try (var rows = statement.executeQuery()) {
          if (!rows.next()) {
            connection.commit();
            return Optional.empty();
          }
          var command = new XlsxImportProcessor.SafeApplyCommand(
              rows.getObject(1, UUID.class), rows.getInt(2),
              rows.getObject(3, UUID.class), rows.getObject(4, UUID.class),
              rows.getObject(5, UUID.class));
          connection.commit();
          return Optional.of(command);
        }
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  private void markExhaustedSafeApplies(Connection connection, Instant now) throws Exception {
    java.util.List<UUID> exhausted = new java.util.ArrayList<>();
    try (var statement = connection.prepareStatement("""
        select id from xlsx_import_batches
        where status='comparing' and safe_apply_correlation_id is not null
          and safe_apply_attempt_count >= ?
          and (lease_expires_at is null or lease_expires_at < ?)
        order by created_at, id for update skip locked
        """)) {
      statement.setInt(1, MAX_SAFE_APPLY_ATTEMPTS);
      statement.setTimestamp(2, Timestamp.from(now));
      try (var rows = statement.executeQuery()) {
        while (rows.next()) exhausted.add(rows.getObject(1, UUID.class));
      }
    }
    for (UUID batchId : exhausted) {
      try (var statement = connection.prepareStatement("""
          update xlsx_import_batches set status='failed', lease_expires_at=null,
            safe_apply_lease_token=null, safe_apply_next_attempt_at=null,
            error_code='SAFE_APPLY_CALLBACK_FAILED',
            error_detail='Vyčerpán limit pokusů automatické aplikace.', completed_at=now(),
            row_version=row_version+1, updated_at=now()
          where id=? and status='comparing' and safe_apply_attempt_count >= ?
          """)) {
        statement.setObject(1, batchId);
        statement.setInt(2, MAX_SAFE_APPLY_ATTEMPTS);
        if (statement.executeUpdate() == 1) {
          appendStageEvent(connection, batchId, "failed", "failed",
              mapper.writeValueAsString(Map.of("errorCode", "SAFE_APPLY_CALLBACK_FAILED")));
        }
      }
    }
  }

  @Override
  public void releaseSafeApply(XlsxImportProcessor.SafeApplyCommand command, String detail)
      throws Exception {
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (var statement = connection.prepareStatement("""
          update xlsx_import_batches set
            status=case when safe_apply_attempt_count >= ? then 'failed' else 'comparing' end,
            lease_expires_at=null, safe_apply_lease_token=null,
            safe_apply_next_attempt_at=case when safe_apply_attempt_count >= ? then null
              else now() + least(300, power(2, greatest(safe_apply_attempt_count - 1, 0))) * interval '1 second' end,
            error_code=case when safe_apply_attempt_count >= ? then 'SAFE_APPLY_CALLBACK_FAILED'
              else 'SAFE_APPLY_RETRY' end,
            error_detail=?, completed_at=case when safe_apply_attempt_count >= ? then now() else null end,
            row_version=case when safe_apply_attempt_count >= ? then row_version+1 else row_version end,
            updated_at=now()
          where id=? and status='comparing' and safe_apply_correlation_id=?
            and safe_apply_idempotency_key=? and safe_apply_lease_token=?
          returning status
          """)) {
        statement.setInt(1, MAX_SAFE_APPLY_ATTEMPTS);
        statement.setInt(2, MAX_SAFE_APPLY_ATTEMPTS);
        statement.setInt(3, MAX_SAFE_APPLY_ATTEMPTS);
        statement.setString(4, limited(detail));
        statement.setInt(5, MAX_SAFE_APPLY_ATTEMPTS);
        statement.setInt(6, MAX_SAFE_APPLY_ATTEMPTS);
        statement.setObject(7, command.batchId());
        statement.setObject(8, command.correlationId());
        statement.setObject(9, command.idempotencyKey());
        statement.setObject(10, command.dispatchLeaseToken());
        try (var rows = statement.executeQuery()) {
          if (!rows.next()) {
            connection.rollback();
            return;
          }
          if ("failed".equals(rows.getString(1))) {
            appendStageEvent(connection, command.batchId(), "failed", "failed",
                mapper.writeValueAsString(Map.of("errorCode", "SAFE_APPLY_CALLBACK_FAILED")));
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
  public Optional<XlsxImportProcessor.Job> claimNext() throws Exception {
    Instant now = Instant.now();
    UUID leaseToken = UUID.randomUUID();
    String sql = """
        with candidate as (
          select id from xlsx_import_batches
          where status='uploaded'
             or (status in ('scanning','validating') and lease_expires_at < ?
               and attempt_count < ?)
          order by created_at, id for update skip locked limit 1
        )
        update xlsx_import_batches b set status='scanning', started_at=coalesce(started_at, ?),
          lease_expires_at=?, attempt_count=attempt_count+1, error_code=null, error_detail=null,
          lease_token=?, row_version=row_version+1, updated_at=? from candidate where b.id=candidate.id
        returning b.id
        """;
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        markExhaustedImports(connection, now);
        UUID id;
        try (var statement = connection.prepareStatement(sql)) {
          statement.setTimestamp(1, Timestamp.from(now));
          statement.setInt(2, MAX_IMPORT_ATTEMPTS);
          statement.setTimestamp(3, Timestamp.from(now));
          statement.setTimestamp(4, Timestamp.from(now.plus(leaseDuration)));
          statement.setObject(5, leaseToken);
          statement.setTimestamp(6, Timestamp.from(now));
          try (var rows = statement.executeQuery()) {
            if (!rows.next()) {
              connection.commit();
              return Optional.empty();
            }
            id = rows.getObject(1, UUID.class);
          }
        }
        XlsxImportProcessor.Job job;
        try (var statement = connection.prepareStatement("""
            select b.id, b.document_id, b.export_job_id, e.document_version_id,
              b.uploaded_by_user_id, f.container, f.object_key, f.etag, b.file_sha256,
              e.snapshot::text, e.snapshot_sha256, e.row_count, e.signing_key_id, b.lease_token
            from xlsx_import_batches b join xlsx_export_jobs e on e.id=b.export_job_id
              join file_objects f on f.id=b.input_file_id where b.id=? for update
            """)) {
          statement.setObject(1, id);
          try (var rows = statement.executeQuery()) {
            if (!rows.next()) throw new SQLException("Importní dávka zmizela po získání lease.");
            job = new XlsxImportProcessor.Job(
                rows.getObject("id", UUID.class), rows.getObject("document_id", UUID.class),
                rows.getObject("export_job_id", UUID.class),
                rows.getObject("document_version_id", UUID.class),
                rows.getObject("uploaded_by_user_id", UUID.class), rows.getString("container"),
                rows.getString("object_key"), rows.getString("etag"), rows.getString("file_sha256"),
                rows.getString("snapshot"), rows.getString("snapshot_sha256"),
                rows.getInt("row_count"), rows.getString("signing_key_id"),
                rows.getObject("lease_token", UUID.class),
                Math.max(1_000L, leaseDuration.toMillis() / 3));
          }
        }
        appendStageEvent(connection, id, "claimed", "scanning", "{}");
        connection.commit();
        return Optional.of(job);
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  private void markExhaustedImports(Connection connection, Instant now) throws Exception {
    java.util.List<UUID> exhausted = new java.util.ArrayList<>();
    try (var statement = connection.prepareStatement("""
        select id from xlsx_import_batches
        where status in ('scanning','validating') and lease_expires_at < ?
          and attempt_count >= ?
        order by created_at, id for update skip locked
        """)) {
      statement.setTimestamp(1, Timestamp.from(now));
      statement.setInt(2, MAX_IMPORT_ATTEMPTS);
      try (var rows = statement.executeQuery()) {
        while (rows.next()) exhausted.add(rows.getObject(1, UUID.class));
      }
    }
    for (UUID batchId : exhausted) {
      try (var statement = connection.prepareStatement("""
          update xlsx_import_batches set status='failed', lease_expires_at=null,
            error_code='IMPORT_RETRY_EXHAUSTED', error_detail='Vyčerpán limit pokusů workeru.',
            completed_at=now(), row_version=row_version+1, updated_at=now()
          where id=? and status in ('scanning','validating') and attempt_count >= ?
          """)) {
        statement.setObject(1, batchId);
        statement.setInt(2, MAX_IMPORT_ATTEMPTS);
        if (statement.executeUpdate() == 1) {
          appendStageEvent(connection, batchId, "failed", "failed",
              mapper.writeValueAsString(Map.of("errorCode", "IMPORT_RETRY_EXHAUSTED")));
        }
      }
    }
  }

  @Override
  public void renewLease(XlsxImportProcessor.Job job) throws Exception {
    try (Connection connection = dataSource.getConnection();
         var statement = connection.prepareStatement("""
           update xlsx_import_batches set lease_expires_at=?, updated_at=now()
           where id=? and lease_token=? and status in ('scanning','validating')
           """)) {
      statement.setTimestamp(1, Timestamp.from(Instant.now().plus(leaseDuration)));
      statement.setObject(2, job.id());
      statement.setObject(3, job.leaseToken());
      if (statement.executeUpdate() != 1) throw new SQLException("Lease XLSX importu již není platná.");
    }
  }

  @Override
  public void markArchived(XlsxImportProcessor.Job job, String container, String key, String etag)
      throws Exception {
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (var statement = connection.prepareStatement("""
            update file_objects f set container=?, object_key=?, etag=?, av_status='clean',
              av_checked_at=now(), object_status='archived'
            from xlsx_import_batches b where b.id=? and f.id=b.input_file_id
            """)) {
          statement.setString(1, container); statement.setString(2, key); statement.setString(3, etag);
          statement.setObject(4, job.id());
          if (statement.executeUpdate() != 1) throw new SQLException("Archiv importu nebyl aktualizován.");
        }
        try (var statement = connection.prepareStatement("""
            update xlsx_import_batches set status='validating', signing_key_id=?,
              row_version=row_version+1, updated_at=now()
            where id=? and status='scanning' and lease_token=?
            """)) {
          statement.setString(1, job.signingKeyId()); statement.setObject(2, job.id());
          statement.setObject(3, job.leaseToken());
          if (statement.executeUpdate() != 1) throw new SQLException("Import není ve stavu scanning.");
        }
        appendStageEvent(connection, job.id(), "archived", "validating",
            mapper.writeValueAsString(Map.of("container", container, "objectKey", key)));
        connection.commit();
      } catch (Exception error) { connection.rollback(); throw error; }
    }
  }

  @Override
  public XlsxImportProcessor.SafeApplyCommand complete(
      XlsxImportProcessor.Job job, XlsxImportParser.ParsedWorkbook workbook)
      throws Exception {
    JsonNode snapshot = mapper.readTree(job.snapshotJson());
    Map<String, JsonNode> byPublicId = new HashMap<>();
    for (JsonNode comment : snapshot.path("comments")) byPublicId.put(comment.path("publicId").asText(), comment);
    if (workbook.rows().size() != job.rowCount()) throw new XlsxValidationException("ROW_SET_MISMATCH");
    Set<String> seen = new HashSet<>();
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        for (XlsxImportParser.ParsedRow parsed : workbook.rows()) {
          String[] values = parsed.values();
          JsonNode source = byPublicId.get(values[0]);
          if (source == null || !seen.add(values[0])) throw new XlsxValidationException("ROW_SET_MISMATCH");
          validateLockedFields(source, values);
          stageRow(connection, job, parsed.sourceRowNumber(), source, values);
        }
        if (seen.size() != byPublicId.size()) throw new XlsxValidationException("ROW_SET_MISMATCH");
        Map<String, Integer> counts = counts(connection, job.id());
        int rowVersion;
        UUID correlationId = UUID.randomUUID();
        UUID idempotencyKey = UUID.randomUUID();
        try (var statement = connection.prepareStatement("""
            update xlsx_import_batches set status='comparing', row_count=?, counts=?::jsonb,
              manifest_sha256=?, lease_expires_at=null, safe_apply_correlation_id=?,
              safe_apply_idempotency_key=?, safe_apply_next_attempt_at=now(),
              row_version=row_version+1, updated_at=now()
            where id=? and status='validating' and lease_token=?
            returning row_version
            """)) {
          statement.setInt(1, workbook.rows().size());
          statement.setString(2, mapper.writeValueAsString(Map.of(
              "unchanged", counts.getOrDefault("unchanged", 0),
              "safeChange", counts.getOrDefault("safe_change", 0),
              "alreadyCurrent", counts.getOrDefault("already_current", 0),
              "conflict", counts.getOrDefault("conflict", 0),
              "invalid", counts.getOrDefault("invalid", 0))));
          statement.setString(3, job.snapshotSha256()); statement.setObject(4, correlationId);
          statement.setObject(5, idempotencyKey); statement.setObject(6, job.id());
          statement.setObject(7, job.leaseToken());
          try (var rows = statement.executeQuery()) {
            if (!rows.next()) throw new SQLException("Import není ve stavu validating.");
            rowVersion = rows.getInt(1);
          }
        }
        appendStageEvent(connection, job.id(), "compared", "comparing",
            mapper.writeValueAsString(Map.of("rowCount", workbook.rows().size(), "counts", counts)));
        connection.commit();
        return new XlsxImportProcessor.SafeApplyCommand(
            job.id(), rowVersion, correlationId, idempotencyKey, null);
      } catch (Exception error) { connection.rollback(); throw error; }
    }
  }

  private void stageRow(Connection connection, XlsxImportProcessor.Job job, int sourceRow,
      JsonNode source, String[] values) throws Exception {
    UUID commentId = UUID.fromString(source.path("id").asText());
    Current current = loadCurrent(connection, commentId);
    if (current == null) throw new XlsxValidationException("COMMENT_MISSING");
    ObjectNode base = flattenBase(source.path("base"));
    ArrayNode errors = mapper.createArrayNode();
    ObjectNode incoming = incoming(connection, job, values, errors);
    String classification = XlsxThreeWayMerge.classify(base, current.values(), incoming, errors);
    try (var statement = connection.prepareStatement("""
        insert into xlsx_import_rows (id, batch_id, source_row_number, comment_id,
          source_comment_row_version, source_settlement_row_version, base_values, current_values,
          incoming_values, classification, validation_errors, current_comment_row_version,
          current_settlement_row_version)
        values (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?, ?)
        on conflict (batch_id, comment_id) do update set source_row_number=excluded.source_row_number,
          current_values=excluded.current_values, incoming_values=excluded.incoming_values,
          classification=excluded.classification, validation_errors=excluded.validation_errors,
          current_comment_row_version=excluded.current_comment_row_version,
          current_settlement_row_version=excluded.current_settlement_row_version,
          row_version=xlsx_import_rows.row_version+1, updated_at=now()
        """)) {
      statement.setObject(1, UUID.randomUUID()); statement.setObject(2, job.id());
      statement.setInt(3, sourceRow); statement.setObject(4, commentId);
      statement.setInt(5, source.path("commentRowVersion").asInt());
      JsonNode settlement = source.path("base").path("settlement");
      if (settlement.isMissingNode() || settlement.isNull()) statement.setObject(6, null);
      else statement.setInt(6, settlement.path("rowVersion").asInt());
      statement.setString(7, mapper.writeValueAsString(base));
      statement.setString(8, mapper.writeValueAsString(current.values()));
      statement.setString(9, mapper.writeValueAsString(incoming));
      statement.setString(10, classification); statement.setString(11, mapper.writeValueAsString(errors));
      statement.setInt(12, current.commentRowVersion());
      if (current.settlementRowVersion() == null) statement.setObject(13, null);
      else statement.setInt(13, current.settlementRowVersion());
      statement.executeUpdate();
    }
  }

  private Current loadCurrent(Connection connection, UUID commentId) throws Exception {
    try (var statement = connection.prepareStatement("""
        select c.comment_type, c.priority, c.status, c.row_version,
          s.outcome, s.statement, s.responsible_user_id, s.declared_settlement_date,
          s.row_version settlement_row_version, dv.version_number
        from comments c left join settlements s on s.comment_id=c.id and s.voided_at is null
          left join document_versions dv on dv.id=s.target_document_version_id where c.id=?
        """)) {
      statement.setObject(1, commentId);
      try (var row = statement.executeQuery()) {
        if (!row.next()) return null;
        ObjectNode values = mapper.createObjectNode();
        values.put("type", row.getString("comment_type")); values.put("priority", row.getString("priority"));
        values.put("status", row.getString("status")); nullable(values, "outcome", row.getString("outcome"));
        nullable(values, "statement", row.getString("statement"));
        nullable(values, "responsibleUserId", row.getString("responsible_user_id"));
        Object date = row.getObject("declared_settlement_date"); nullable(values, "declaredSettlementDate", date == null ? null : date.toString());
        Object version = row.getObject("version_number"); if (version == null) values.putNull("targetVersionNumber"); else values.put("targetVersionNumber", ((Number) version).intValue());
        Integer settlementRowVersion = row.getObject("settlement_row_version") == null
            ? null : row.getInt("settlement_row_version");
        return new Current(values, row.getInt("row_version"), settlementRowVersion);
      }
    }
  }

  private ObjectNode incoming(Connection connection, XlsxImportProcessor.Job job, String[] v,
      ArrayNode errors) throws Exception {
    ObjectNode node = mapper.createObjectNode();
    node.put("type", v[7]); node.put("priority", v[8]); node.put("status", v[9]);
    nullable(node, "outcome", blank(v[10])); nullable(node, "statement", blank(v[11]));
    if (v[12].isBlank()) node.putNull("targetVersionNumber");
    else try { node.put("targetVersionNumber", Integer.parseInt(v[12])); } catch (NumberFormatException e) { node.putNull("targetVersionNumber"); errors.add("INVALID_TARGET_VERSION"); }
    nullable(node, "responsibleUserId", resolveResponsible(connection, job, v[13], errors));
    nullable(node, "declaredSettlementDate", blank(v[14]));
    validateEditableFields(v, errors);
    if (!v[12].isBlank() && !targetVersionExists(connection, job.documentId(), v[12])) {
      errors.add("INVALID_TARGET_VERSION");
    }
    return node;
  }

  static void validateEditableFields(String[] values, ArrayNode errors) {
    if (!TYPES.contains(values[7])) errors.add("INVALID_TYPE");
    if (!PRIORITIES.contains(values[8])) errors.add("INVALID_PRIORITY");
    if (!STATUSES.contains(values[9])) errors.add("INVALID_STATUS");
    if (!values[10].isBlank() && !OUTCOMES.contains(values[10])) errors.add("INVALID_OUTCOME");
    if (!values[14].isBlank()) {
      try {
        if (LocalDate.parse(values[14]).isAfter(LocalDate.now())) errors.add("FUTURE_SETTLEMENT_DATE");
      } catch (Exception error) {
        errors.add("INVALID_SETTLEMENT_DATE");
      }
    }
    if ("settled".equals(values[9]) && (values[10].isBlank() || values[11].isBlank()
        || values[13].isBlank() || values[14].isBlank())) errors.add("INCOMPLETE_SETTLEMENT");
    if (!"settled".equals(values[9])
        && (!values[10].isBlank() || !values[11].isBlank() || !values[12].isBlank()
            || !values[13].isBlank() || !values[14].isBlank())) {
      errors.add("SETTLEMENT_DATA_WITHOUT_SETTLED_STATUS");
    }
  }

  static void validateLockedFields(JsonNode source, String[] values) throws XlsxValidationException {
    String[] expected = {
        source.path("publicId").asText(), Integer.toString(source.path("blockOrder").asInt()),
        source.path("blockText").asText(), source.path("authorName").asText(),
        source.path("organizationName").asText(), source.path("createdAt").asText(),
        source.path("body").asText()
    };
    for (int index = 0; index < expected.length; index++) {
      if (!expected[index].equals(values[index])) {
        throw new XlsxValidationException("LOCKED_FIELD_TAMPERED");
      }
    }
  }

  private boolean targetVersionExists(Connection connection, UUID documentId, String rawVersion)
      throws Exception {
    int version;
    try {
      version = Integer.parseInt(rawVersion);
    } catch (NumberFormatException error) {
      return false;
    }
    try (var statement = connection.prepareStatement(
        "select exists(select 1 from document_versions where document_id=? and version_number=?)")) {
      statement.setObject(1, documentId); statement.setInt(2, version);
      try (var rows = statement.executeQuery()) { rows.next(); return rows.getBoolean(1); }
    }
  }

  private String resolveResponsible(Connection connection, XlsxImportProcessor.Job job, String name,
      ArrayNode errors) throws Exception {
    if (name.isBlank()) return null;
    try (var statement = connection.prepareStatement("""
        select u.id from users u join documents d on d.id=?
        where u.status='active' and u.role in ('admin','superadmin')
          and trim(u.first_name || ' ' || u.last_name)=?
          and (u.id=? or u.id=d.owner_admin_id)
        """)) {
      statement.setObject(1, job.documentId()); statement.setString(2, name.trim());
      statement.setObject(3, job.uploadedByUserId());
      try (var rows = statement.executeQuery()) {
        if (!rows.next()) { errors.add("RESPONSIBLE_NOT_ALLOWED"); return null; }
        String id = rows.getObject(1, UUID.class).toString();
        if (rows.next()) { errors.add("RESPONSIBLE_AMBIGUOUS"); return null; }
        return id;
      }
    }
  }

  private ObjectNode flattenBase(JsonNode raw) {
    ObjectNode node = mapper.createObjectNode();
    node.set("type", raw.path("type")); node.set("priority", raw.path("priority")); node.set("status", raw.path("status"));
    JsonNode settlement = raw.path("settlement");
    if (settlement.isMissingNode() || settlement.isNull()) {
      for (String key : new String[]{"outcome","statement","responsibleUserId","declaredSettlementDate","targetVersionNumber"}) node.putNull(key);
    } else {
      for (String key : new String[]{"outcome","statement","responsibleUserId","declaredSettlementDate","targetVersionNumber"}) node.set(key, settlement.path(key));
    }
    return node;
  }

  private Map<String, Integer> counts(Connection connection, UUID batchId) throws Exception {
    Map<String, Integer> result = new HashMap<>();
    try (var statement = connection.prepareStatement("select classification, count(*) from xlsx_import_rows where batch_id=? group by classification")) {
      statement.setObject(1, batchId);
      try (var rows = statement.executeQuery()) { while (rows.next()) result.put(rows.getString(1), rows.getInt(2)); }
    }
    return result;
  }

  @Override
  public void fail(XlsxImportProcessor.Job job, String code, String detail) throws Exception {
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (var statement = connection.prepareStatement("""
            update xlsx_import_batches set status='failed', error_code=?, error_detail=?,
              lease_expires_at=null, completed_at=now(), row_version=row_version+1, updated_at=now()
            where id=? and lease_token=? and status in ('scanning','validating')
            """)) {
          statement.setString(1, code); statement.setString(2, detail); statement.setObject(3, job.id());
          statement.setObject(4, job.leaseToken());
          int changed = statement.executeUpdate();
          if (changed != 1) {
            connection.rollback();
            return;
          }
        }
        appendStageEvent(connection, job.id(), "failed", "failed",
            mapper.writeValueAsString(Map.of("errorCode", code)));
        connection.commit();
      } catch (Exception error) { connection.rollback(); throw error; }
    }
  }

  private void appendStageEvent(Connection connection, UUID batchId, String eventType,
      String status, String detailsJson) throws Exception {
    try (var statement = connection.prepareStatement("""
        insert into xlsx_import_stage_events(id,batch_id,event_type,status,details)
        values (?,?,?,?,?::jsonb)
        """)) {
      statement.setObject(1, UUID.randomUUID()); statement.setObject(2, batchId);
      statement.setString(3, eventType); statement.setString(4, status);
      statement.setString(5, detailsJson); statement.executeUpdate();
    }
    appendHashedAudit(connection, batchId, eventType, status, detailsJson);
  }

  private void appendHashedAudit(Connection connection, UUID batchId, String eventType,
      String status, String detailsJson) throws Exception {
    UUID actorUserId;
    String actorRole;
    UUID documentId;
    try (var statement = connection.prepareStatement("""
        select batch.uploaded_by_user_id, account.role::text, batch.document_id
        from xlsx_import_batches batch
        join users account on account.id=batch.uploaded_by_user_id
        where batch.id=?
        """)) {
      statement.setObject(1, batchId);
      try (var rows = statement.executeQuery()) {
        if (!rows.next()) throw new SQLException("Importní dávka pro audit nebyla nalezena.");
        actorUserId = rows.getObject(1, UUID.class);
        actorRole = rows.getString(2);
        documentId = rows.getObject(3, UUID.class);
      }
    }
    try (var statement = connection.prepareStatement(
        "select pg_advisory_xact_lock(hashtext('audit_events'))")) {
      statement.execute();
    }
    String previousHash = null;
    try (var statement = connection.prepareStatement(
        "select event_hash from audit_events order by chain_sequence desc limit 1");
         var rows = statement.executeQuery()) {
      if (rows.next()) previousHash = rows.getString(1);
    }
    UUID correlationId = UUID.randomUUID();
    ObjectNode metadata = mapper.createObjectNode();
    metadata.put("documentId", documentId.toString());
    metadata.put("stage", eventType);
    metadata.put("status", status);
    metadata.set("details", mapper.readTree(detailsJson));
    ObjectNode canonicalEvent = mapper.createObjectNode();
    canonicalEvent.put("action", "xlsx_import.worker_" + eventType);
    canonicalEvent.put("actorRole", actorRole);
    canonicalEvent.put("actorUserId", actorUserId.toString());
    canonicalEvent.put("correlationId", correlationId.toString());
    canonicalEvent.set("metadata", metadata);
    canonicalEvent.put("outcome", "failed".equals(eventType) ? "denied" : "allowed");
    if (previousHash == null) canonicalEvent.putNull("previousHash");
    else canonicalEvent.put("previousHash", previousHash);
    canonicalEvent.put("targetId", batchId.toString());
    canonicalEvent.put("targetType", "xlsx_import_batch");
    String canonical = XlsxCanonicalJson.canonical(mapper.writeValueAsString(canonicalEvent));
    String eventHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest(((previousHash == null ? "" : previousHash) + canonical)
            .getBytes(StandardCharsets.UTF_8)));
    try (var statement = connection.prepareStatement("""
        insert into audit_events (id, actor_user_id, actor_role, action, target_type,
          target_id, outcome, correlation_id, metadata, previous_hash, event_hash, created_at)
        values (?, ?, ?::user_role, ?, 'xlsx_import_batch', ?, ?, ?, ?::jsonb, ?, ?, clock_timestamp())
        """)) {
      statement.setObject(1, UUID.randomUUID()); statement.setObject(2, actorUserId);
      statement.setString(3, actorRole); statement.setString(4, "xlsx_import.worker_" + eventType);
      statement.setObject(5, batchId); statement.setString(6, "failed".equals(eventType) ? "denied" : "allowed");
      statement.setObject(7, correlationId); statement.setString(8, mapper.writeValueAsString(metadata));
      statement.setString(9, previousHash); statement.setString(10, eventHash);
      statement.executeUpdate();
    }
  }

  private static String blank(String value) { return value == null || value.isBlank() ? null : value.trim(); }
  private static String limited(String value) {
    String text = value == null ? "" : value;
    return text.length() <= 8_000 ? text : text.substring(0, 8_000);
  }
  private static void nullable(ObjectNode node, String key, String value) { if (value == null) node.putNull(key); else node.put(key, value); }
  private record Current(ObjectNode values, int commentRowVersion, Integer settlementRowVersion) {}
}

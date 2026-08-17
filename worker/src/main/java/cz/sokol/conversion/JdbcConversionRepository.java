package cz.sokol.conversion;

import com.fasterxml.jackson.databind.ObjectMapper;
import cz.sokol.conversion.model.ConversionResult;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;

public final class JdbcConversionRepository implements ConversionProcessor.Repository {
  private static final ObjectMapper JSON = new ObjectMapper();
  private final DataSource dataSource;

  public JdbcConversionRepository(DataSource dataSource) {
    this.dataSource = dataSource;
  }

  @Override
  public ConversionProcessor.Job load(UUID jobId) throws SQLException {
    String sql = """
        select job.id, version.document_id, version.id as version_id,
          file.id as file_id, file.container, file.object_key, file.sha256,
          file.etag, job.correlation_id, version.created_by_user_id,
          job.profile_version, version.created_at as version_created_at, job.lease_owner
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
            rows.getObject("correlation_id", UUID.class),
            rows.getObject("created_by_user_id", UUID.class),
            rows.getString("profile_version"),
            rows.getTimestamp("version_created_at").toInstant(),
            rows.getString("lease_owner"));
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
              updated_at=now() where id=? and lease_owner=?
            """)) {
          statement.setObject(1, job.id());
          statement.setString(2, job.leaseOwner());
          if (statement.executeUpdate() != 1) throw new SQLException("Pronájem úlohy zanikl.");
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

  @Override
  public void markRendering(ConversionProcessor.Job job) throws SQLException {
    try (var connection = dataSource.getConnection(); var statement = connection.prepareStatement("""
        update conversion_jobs set status='rendering', current_step='reference_render',
          updated_at=now() where id=? and status in ('leased','parsing') and lease_owner=?
        """)) {
      statement.setObject(1, job.id());
      statement.setString(2, job.leaseOwner());
      if (statement.executeUpdate() != 1) throw new SQLException("Nelze zahájit referenční render.");
    }
  }

  @Override
  public void completeConversion(
      ConversionProcessor.Job job, ConversionProcessor.CompletedConversion conversion) throws Exception {
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        try (var lock = connection.prepareStatement("""
            select input_sha256,status,lease_owner from conversion_jobs where id=? for update
            """)) {
          lock.setObject(1, job.id());
          try (var row = lock.executeQuery()) {
            if (!row.next() || !job.sha256().equals(row.getString("input_sha256"))
                || !"rendering".equals(row.getString("status"))
                || !job.leaseOwner().equals(row.getString("lease_owner"))) {
              throw new SQLException("Převodní úloha ztratila platný pronájem nebo vstup.");
            }
          }
        }
        ConversionProcessor.Derivative derivative = conversion.reference();
        try (var statement = connection.prepareStatement("""
            insert into file_objects(
              id,document_id,data_owner_user_id,purpose,container,object_key,original_name,
              declared_mime,detected_mime,size_bytes,sha256,etag,av_status,av_checked_at,
              av_result_code,object_status)
            values (?, ?, ?, 'reference_render', ?, ?, 'reference.pdf', ?, ?, ?, ?, ?,
              'clean', now(), 'DERIVED_FROM_CLEAN_ORIGINAL', 'derivative')
            on conflict (object_key) do nothing
            """)) {
          statement.setObject(1, UUID.randomUUID());
          statement.setObject(2, job.documentId());
          statement.setObject(3, job.ownerUserId());
          statement.setString(4, derivative.container());
          statement.setString(5, derivative.objectKey());
          statement.setString(6, derivative.contentType());
          statement.setString(7, derivative.contentType());
          statement.setLong(8, derivative.sizeBytes());
          statement.setString(9, derivative.sha256());
          statement.setString(10, derivative.etag());
          statement.executeUpdate();
        }
        Map<Integer, UUID> tableImageFiles = persistTableImageFiles(connection, job, conversion);
        persistBlocks(connection, job, conversion, tableImageFiles);
        persistFindings(connection, job, conversion.result());
        String webHash = sha256(JSON.writeValueAsBytes(conversion.result()));
        executeUpdate(connection, """
            update conversion_jobs set status='completed', current_step='completed',
              completed_at=now(), lease_owner=null, lease_expires_at=null, heartbeat_at=null,
              updated_at=now() where id=? and status='rendering'
            """, job.id());
        executeUpdate(connection, """
            update document_versions set status='conversion_review', web_content_sha256=?,
              row_version=row_version+1, updated_at=now() where id=?
            """, webHash, job.versionId());
        executeUpdate(connection, """
            update documents set status='conversion_review', row_version=row_version+1,
              updated_at=now() where id=?
            """, job.documentId());
        UUID outboxKey = UUID.nameUUIDFromBytes((job.id() + ":completed").getBytes(StandardCharsets.UTF_8));
        try (var outbox = connection.prepareStatement("""
            insert into outbox_events(event_type,aggregate_type,aggregate_id,payload,idempotency_key)
            values ('document.conversion.completed','document_version',?,?::jsonb,?)
            on conflict (idempotency_key) do nothing
            """)) {
          outbox.setObject(1, job.versionId());
          outbox.setString(2, JSON.writeValueAsString(Map.of(
              "jobId", job.id(), "versionId", job.versionId(), "blockCount",
              conversion.result().blocks().size())));
          outbox.setObject(3, outboxKey);
          outbox.executeUpdate();
        }
        connection.commit();
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  private static Map<Integer, UUID> persistTableImageFiles(
      java.sql.Connection connection, ConversionProcessor.Job job,
      ConversionProcessor.CompletedConversion conversion) throws Exception {
    Map<Integer, UUID> result = new LinkedHashMap<>();
    for (ConversionProcessor.TableImageDerivative image : conversion.tableImages()) {
      ConversionProcessor.Derivative derivative = image.derivative();
      UUID fileId = UUID.nameUUIDFromBytes((job.versionId() + ":table-image:"
          + image.tableIndex() + ":" + derivative.sha256()).getBytes(StandardCharsets.UTF_8));
      try (var statement = connection.prepareStatement("""
          insert into file_objects(
            id,document_id,data_owner_user_id,purpose,container,object_key,original_name,
            declared_mime,detected_mime,size_bytes,sha256,etag,av_status,av_checked_at,
            av_result_code,object_status)
          values (?, ?, ?, 'table_image', ?, ?, ?, ?, ?, ?, ?, ?,
            'clean', now(), 'DERIVED_FROM_CLEAN_ORIGINAL', 'derivative')
          on conflict (object_key) do nothing
          """)) {
        statement.setObject(1, fileId);
        statement.setObject(2, job.documentId());
        statement.setObject(3, job.ownerUserId());
        statement.setString(4, derivative.container());
        statement.setString(5, derivative.objectKey());
        statement.setString(6, "table-" + image.tableIndex() + ".png");
        statement.setString(7, derivative.contentType());
        statement.setString(8, derivative.contentType());
        statement.setLong(9, derivative.sizeBytes());
        statement.setString(10, derivative.sha256());
        statement.setString(11, derivative.etag());
        statement.executeUpdate();
      }
      try (var verify = connection.prepareStatement(
          "select id,sha256,size_bytes from file_objects where object_key=?")) {
        verify.setString(1, derivative.objectKey());
        try (var row = verify.executeQuery()) {
          if (!row.next() || !derivative.sha256().equals(row.getString("sha256"))
              || derivative.sizeBytes() != row.getLong("size_bytes")) {
            throw new SQLException("Uložený obraz tabulky neodpovídá odvozenému souboru.");
          }
          fileId = row.getObject("id", UUID.class);
        }
      }
      if (result.put(image.tableIndex(), fileId) != null) {
        throw new SQLException("Tabulka má více než jeden systémový obraz.");
      }
    }
    return Map.copyOf(result);
  }

  private static void persistBlocks(
      java.sql.Connection connection, ConversionProcessor.Job job,
      ConversionProcessor.CompletedConversion conversion,
      Map<Integer, UUID> tableImageFiles) throws Exception {
    int tableIndex = 0;
    for (int index = 0; index < conversion.result().blocks().size(); index += 1) {
      ConversionResult.Block block = conversion.result().blocks().get(index);
      UUID blockUid = UUID.fromString(block.blockUid());
      try (var statement = connection.prepareStatement("""
          insert into document_blocks(
            block_uid,document_id,source_bookmark,source_para_id,heading_path)
          values (?,?,?,?,?::jsonb) on conflict (block_uid) do nothing
          """)) {
        statement.setObject(1, blockUid);
        statement.setObject(2, job.documentId());
        statement.setString(3, block.sourceBookmark());
        statement.setString(4, block.sourceParaId());
        statement.setString(5, JSON.writeValueAsString(block.headingPath()));
        statement.executeUpdate();
      }
      Map<String, Object> structured = new LinkedHashMap<>(block.content());
      TableComplexityAnalyzer.Analysis table = null;
      if ("table".equals(block.type())) {
        table = conversion.tableReview().tables().get(tableIndex++);
        structured.put("tableRecommendation", table);
      }
      UUID revisionId = UUID.nameUUIDFromBytes(
          (job.versionId() + ":" + block.blockUid()).getBytes(StandardCharsets.UTF_8));
      try (var statement = connection.prepareStatement("""
          insert into block_revisions(
            block_revision_id,block_uid,document_version_id,block_order,block_type,
            structured_content,plain_text,normalized_hash,commentable,parser_version,revision_origin)
          values (?,?,?,?,?,?::jsonb,?,?,?,?, 'converted')
          on conflict (document_version_id,block_uid) do nothing
          """)) {
        statement.setObject(1, revisionId);
        statement.setObject(2, blockUid);
        statement.setObject(3, job.versionId());
        statement.setInt(4, index);
        statement.setString(5, block.type());
        statement.setString(6, JSON.writeValueAsString(structured));
        statement.setString(7, block.plainText());
        statement.setString(8, block.normalizedHash());
        statement.setBoolean(9, block.commentable());
        statement.setString(10, job.profileVersion());
        statement.executeUpdate();
      }
      if (table != null && "image_with_attachment".equals(table.recommendation().code())) {
        int currentTableIndex = tableIndex - 1;
        UUID fileId = tableImageFiles.get(currentTableIndex);
        if (fileId == null) throw new SQLException("Chybí povinný obraz tabulky.");
        ConversionProcessor.TableImageDerivative image = conversion.tableImages().stream()
            .filter(candidate -> candidate.tableIndex() == currentTableIndex)
            .findFirst().orElseThrow();
        UUID assetId = UUID.nameUUIDFromBytes(
            (revisionId + ":table-image").getBytes(StandardCharsets.UTF_8));
        try (var statement = connection.prepareStatement("""
            insert into block_assets(
              id,block_revision_id,file_object_id,purpose,asset_order,alternative_text,
              width,height,checksum,table_representation)
            values (?,?,?,'table_image',0,null,?,?,?,?)
            on conflict (block_revision_id,asset_order) do nothing
            """)) {
          statement.setObject(1, assetId);
          statement.setObject(2, revisionId);
          statement.setObject(3, fileId);
          statement.setInt(4, image.width());
          statement.setInt(5, image.height());
          statement.setString(6, image.derivative().sha256());
          statement.setString(7, table.recommendation().code());
          statement.executeUpdate();
        }
      }
      if (table != null && !"html".equals(table.recommendation().code())) {
        int attachmentOrder = "image_with_attachment".equals(table.recommendation().code()) ? 1 : 0;
        UUID assetId = UUID.nameUUIDFromBytes(
            (revisionId + ":attachment").getBytes(StandardCharsets.UTF_8));
        try (var statement = connection.prepareStatement("""
            insert into block_assets(
              id,block_revision_id,file_object_id,purpose,asset_order,checksum,table_representation)
            values (?,?,?,'attachment',?,?,?) on conflict (block_revision_id,asset_order) do nothing
            """)) {
          statement.setObject(1, assetId);
          statement.setObject(2, revisionId);
          statement.setObject(3, job.fileId());
          statement.setInt(4, attachmentOrder);
          statement.setString(5, job.sha256());
          statement.setString(6, table.recommendation().code());
          statement.executeUpdate();
        }
      }
    }
  }

  private static void persistFindings(
      java.sql.Connection connection, ConversionProcessor.Job job, ConversionResult result)
      throws Exception {
    for (int index = 0; index < result.findings().size(); index += 1) {
      ConversionResult.Finding finding = result.findings().get(index);
      UUID id = UUID.nameUUIDFromBytes(
          (job.id() + ":" + index + ":" + finding.code()).getBytes(StandardCharsets.UTF_8));
      UUID blockUid = null;
      Object blockIndex = finding.sourceLocation().get("blockIndex");
      if (blockIndex instanceof Number number && number.intValue() >= 0
          && number.intValue() < result.blocks().size()) {
        blockUid = UUID.fromString(result.blocks().get(number.intValue()).blockUid());
      }
      try (var statement = connection.prepareStatement("""
          insert into conversion_findings(
            id,conversion_job_id,block_uid,source_location,code,severity,message)
          values (?,?,?,?::jsonb,?,?,?) on conflict (id) do nothing
          """)) {
        statement.setObject(1, id);
        statement.setObject(2, job.id());
        statement.setObject(3, blockUid);
        statement.setString(4, JSON.writeValueAsString(finding.sourceLocation()));
        statement.setString(5, finding.code());
        statement.setString(6, finding.severity());
        statement.setString(7, finding.message());
        statement.executeUpdate();
      }
    }
  }

  private static void executeUpdate(
      java.sql.Connection connection, String sql, Object... values) throws SQLException {
    try (var statement = connection.prepareStatement(sql)) {
      for (int index = 0; index < values.length; index += 1) statement.setObject(index + 1, values[index]);
      if (statement.executeUpdate() != 1) throw new SQLException("Atomický přechod převodu selhal.");
    }
  }

  private static String sha256(byte[] value) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
  }
}

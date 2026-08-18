package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.azure.storage.blob.BlobServiceClientBuilder;
import cz.sokol.conversion.model.ConversionResult;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.postgresql.ds.PGSimpleDataSource;

class WorkerEndToEndTest {
  @TempDir Path temporaryDirectory;
  private static final String STORAGE = System.getenv().getOrDefault(
      "TEST_STORAGE_CONNECTION_STRING",
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
          + "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/"
          + "K1SZFPTOtr/KBHBeksoGMGw==;"
          + "BlobEndpoint=http://host.docker.internal:10000/devstoreaccount1;");

  @Test
  void oneLeasedEicarJobIsRejectedWithoutAnOriginal() throws Exception {
    PGSimpleDataSource dataSource = dataSource();
    UUID userId = UUID.randomUUID();
    UUID documentId = UUID.randomUUID();
    UUID fileId = UUID.randomUUID();
    UUID versionId = UUID.randomUUID();
    UUID jobId = UUID.randomUUID();
    String sourceKey = documentId + "/" + versionId + "/" + fileId + ".docx";
    String targetKey;
    String eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    byte[] content = eicar.getBytes(StandardCharsets.US_ASCII);
    String sha256 = HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(content));
    targetKey = documentId + "/" + versionId + "/" + sha256 + ".docx";
    var service = new BlobServiceClientBuilder().connectionString(STORAGE).buildClient();
    service.getBlobContainerClient("quarantine").createIfNotExists();
    service.getBlobContainerClient("originals").createIfNotExists();
    var source = service.getBlobContainerClient("quarantine").getBlobClient(sourceKey);
    var target = service.getBlobContainerClient("originals").getBlobClient(targetKey);
    source.upload(new ByteArrayInputStream(content), content.length, true);
    try {
      seed(dataSource, userId, documentId, fileId, versionId, jobId,
          sourceKey, source.getProperties().getETag(), sha256, content.length);
      JobLeaseRepository leases = new JobLeaseRepository(dataSource, Duration.ofMinutes(2));
      var leased = leases.leaseNext("e2e-worker", Instant.now());
      assertTrue(leased.isPresent());
      assertEquals(jobId, leased.orElseThrow().id());
      ConversionProcessor processor = new ConversionProcessor(
          new JdbcConversionRepository(dataSource),
          new AzureBlobStore(STORAGE),
          new ClamAvClient(
              System.getenv().getOrDefault("TEST_CLAMAV_HOST", "host.docker.internal"),
              3310,
              Duration.ofSeconds(10)));

      processor.scanAndArchive(jobId);

      try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement("""
          select job.status, file.av_status, file.object_status,
            (select count(*) from security_events where file_object_id=file.id) as security_count
          from conversion_jobs job
          join document_versions version on version.id=job.document_version_id
          join file_objects file on file.id=version.original_file_id where job.id=?
          """)) {
        statement.setObject(1, jobId);
        try (var rows = statement.executeQuery()) {
          assertTrue(rows.next());
          assertEquals("rejected", rows.getString("status"));
          assertEquals("infected", rows.getString("av_status"));
          assertEquals("rejected", rows.getString("object_status"));
          assertEquals(1, rows.getInt("security_count"));
        }
      }
      assertFalse(target.exists());
    } finally {
      cleanup(dataSource, userId, documentId, fileId, versionId, jobId);
      source.deleteIfExists();
      target.deleteIfExists();
    }
  }

  @Test
  void oneLeasedCleanDocxIsPersistedAtomicallyForReview() throws Exception {
    PGSimpleDataSource dataSource = dataSource();
    UUID userId = UUID.randomUUID();
    UUID documentId = UUID.randomUUID();
    UUID fileId = UUID.randomUUID();
    UUID versionId = UUID.randomUUID();
    UUID jobId = UUID.randomUUID();
    byte[] content = Files.readAllBytes(Path.of(System.getenv().getOrDefault(
        "SOKOL_FIXTURE_ROOT", "../test/fixtures/docx")).resolve("complex-tables.docx"));
    String sha256 = HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(content));
    String sourceKey = documentId + "/" + versionId + "/" + fileId + ".docx";
    String originalKey = documentId + "/" + versionId + "/" + sha256 + ".docx";
    String pdfSha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest("%PDF-reference".getBytes(StandardCharsets.UTF_8)));
    String referenceKey = documentId + "/" + versionId + "/reference/" + pdfSha + ".pdf";
    byte[] tablePng = new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47};
    String tableSha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest(tablePng));
    String tableKey = documentId + "/" + versionId + "/tables/1/" + tableSha + ".png";
    var service = new BlobServiceClientBuilder().connectionString(STORAGE).buildClient();
    service.getBlobContainerClient("quarantine").createIfNotExists();
    service.getBlobContainerClient("originals").createIfNotExists();
    service.getBlobContainerClient("derivatives").createIfNotExists();
    var source = service.getBlobContainerClient("quarantine").getBlobClient(sourceKey);
    var original = service.getBlobContainerClient("originals").getBlobClient(originalKey);
    var reference = service.getBlobContainerClient("derivatives").getBlobClient(referenceKey);
    var tableImage = service.getBlobContainerClient("derivatives").getBlobClient(tableKey);
    source.upload(new ByteArrayInputStream(content), content.length, true);
    try {
      seed(dataSource, userId, documentId, fileId, versionId, jobId,
          sourceKey, source.getProperties().getETag(), sha256, content.length);
      var leased = new JobLeaseRepository(dataSource, Duration.ofMinutes(2))
          .leaseNext("clean-e2e-worker", Instant.now());
      assertEquals(jobId, leased.orElseThrow().id());
      var processor = new ConversionProcessor(
          new JdbcConversionRepository(dataSource), new AzureBlobStore(STORAGE),
          new ClamAvClient(System.getenv().getOrDefault(
              "TEST_CLAMAV_HOST", "host.docker.internal"), 3310, Duration.ofSeconds(10)));
      var renderer = new LibreOfficeRenderer(command -> {
        Files.write(command.workingDirectory().resolve("source.pdf"),
            "%PDF-reference".getBytes(StandardCharsets.UTF_8));
        return new LibreOfficeRenderer.ProcessResult(0, false, "converted");
      });

      ConversionProcessor.TableArtifactGenerator artifacts = (docx, blocks, directory) -> {
        Files.createDirectories(directory);
        Path image = Files.write(directory.resolve("table-1.png"), tablePng);
        return new ConversionProcessor.GeneratedTableArtifacts(
            java.util.List.of(new ConversionProcessor.GeneratedTableImage(
                1, image, tableSha, 320, 180)), java.util.Set.of());
      };

      processor.processLeasedJob(
          jobId, temporaryDirectory.resolve("jobs"), renderer, artifacts);

      try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement("""
          select job.status, version.status as version_status, document.status as document_status,
            (select count(*) from block_revisions where document_version_id=version.id) as blocks,
            (select count(*) from conversion_findings where conversion_job_id=job.id) as findings,
            (select count(*) from block_assets asset join block_revisions revision
              on revision.block_revision_id=asset.block_revision_id
              where revision.document_version_id=version.id) as assets,
            (select count(*) from file_objects where document_id=document.id
              and purpose='reference_render') as references,
            (select count(*) from file_objects where document_id=document.id
              and purpose='table_image') as table_images,
            (select count(*) from block_assets asset join block_revisions revision
              on revision.block_revision_id=asset.block_revision_id
              where revision.document_version_id=version.id and asset.purpose='table_image'
                and asset.width=320 and asset.height=180
                and asset.alternative_text is null) as accessible_image_targets
          from conversion_jobs job
          join document_versions version on version.id=job.document_version_id
          join documents document on document.id=version.document_id where job.id=?
          """)) {
        statement.setObject(1, jobId);
        try (var rows = statement.executeQuery()) {
          assertTrue(rows.next());
          assertEquals("completed", rows.getString("status"));
          assertEquals("conversion_review", rows.getString("version_status"));
          assertEquals("conversion_review", rows.getString("document_status"));
          assertEquals(3, rows.getInt("blocks"));
          assertEquals(1, rows.getInt("findings"));
          assertEquals(3, rows.getInt("assets"));
          assertEquals(1, rows.getInt("references"));
          assertEquals(1, rows.getInt("table_images"));
          assertEquals(1, rows.getInt("accessible_image_targets"));
        }
      }
      assertTrue(original.exists());
      assertTrue(reference.exists());
      assertTrue(tableImage.exists());
      assertFalse(source.exists());
    } finally {
      cleanupConversion(dataSource, userId, documentId, fileId, versionId, jobId);
      source.deleteIfExists();
      original.deleteIfExists();
      reference.deleteIfExists();
      tableImage.deleteIfExists();
    }
  }

  @Test
  void conversionRetryPreservesAnAdministratorsCurrentBlockRevision() throws Exception {
    PGSimpleDataSource dataSource = dataSource();
    UUID userId = UUID.randomUUID();
    UUID documentId = UUID.randomUUID();
    UUID fileId = UUID.randomUUID();
    UUID versionId = UUID.randomUUID();
    UUID jobId = UUID.randomUUID();
    UUID blockUid = UUID.randomUUID();
    UUID newerVersionId = UUID.randomUUID();
    String sha256 = "a".repeat(64);
    String sourceKey = documentId + "/" + versionId + "/source.docx";
    UUID convertedRevisionId = UUID.nameUUIDFromBytes(
        (versionId + ":" + blockUid).getBytes(StandardCharsets.UTF_8));
    UUID adminRevisionId = UUID.randomUUID();
    try {
      seed(dataSource, userId, documentId, fileId, versionId, jobId,
          sourceKey, "etag", sha256, 42);
      try (Connection connection = dataSource.getConnection(); var statement = connection.createStatement()) {
        statement.executeUpdate("update conversion_jobs set status='rendering', lease_owner='retry-worker'"
            + " where id='" + jobId + "'");
        statement.executeUpdate("update document_versions set status='conversion' where id='" + versionId + "'");
        statement.executeUpdate("update documents set status='conversion' where id='" + documentId + "'");
        statement.executeUpdate("insert into document_blocks(block_uid,document_id) values ('"
            + blockUid + "','" + documentId + "')");
        statement.executeUpdate("insert into block_revisions(block_revision_id,block_uid,"
            + "document_version_id,block_order,block_type,structured_content,plain_text,"
            + "normalized_hash,parser_version,revision_origin,superseded_at) values ('"
            + convertedRevisionId + "','" + blockUid + "','" + versionId
            + "',0,'paragraph','{}','Původní text','" + "b".repeat(64)
            + "','docx-web-v1','converted',now())");
        statement.executeUpdate("insert into block_revisions(block_revision_id,block_uid,"
            + "document_version_id,block_order,block_type,structured_content,plain_text,"
            + "normalized_hash,parser_version,revision_origin,created_by_user_id) values ('"
            + adminRevisionId + "','" + blockUid + "','" + versionId
            + "',0,'heading','{}','Původní text','" + "b".repeat(64)
            + "','docx-web-v1','admin_structure_edit','" + userId + "')");
      }
      var block = new ConversionResult.Block(
          blockUid.toString(), "paragraph", "Původní text", "b".repeat(64), true,
          List.of(), null, null, Map.of(), List.of());
      var result = new ConversionResult("docx-web-v1", sha256, List.of(block), List.of());
      var completion = new ConversionProcessor.CompletedConversion(
          result,
          new ConversionProcessor.TableReview(List.of(), List.of()),
          new ConversionProcessor.Derivative(
              "derivatives", documentId + "/" + versionId + "/reference/retry.pdf",
              "c".repeat(64), "etag", 12, "application/pdf"),
          List.of());
      var job = new ConversionProcessor.Job(
          jobId, documentId, versionId, fileId, "originals", sourceKey, sha256, "etag",
          UUID.randomUUID(), userId, "docx-web-v1", Instant.now(), "retry-worker");

      new JdbcConversionRepository(dataSource).completeConversion(job, completion);

      try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement("""
          select block_revision_id, block_type from block_revisions
          where document_version_id=? and superseded_at is null
          """)) {
        statement.setObject(1, versionId);
        try (var rows = statement.executeQuery()) {
          assertTrue(rows.next());
          assertEquals(adminRevisionId, rows.getObject("block_revision_id", UUID.class));
          assertEquals("heading", rows.getString("block_type"));
          assertFalse(rows.next());
        }
      }
      try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement(
          "select count(*) from audit_events where target_id=? and action='conversion.completed'")) {
        statement.setObject(1, versionId);
        try (var rows = statement.executeQuery()) {
          assertTrue(rows.next());
          assertEquals(1, rows.getInt(1));
        }
      }
      try (Connection connection = dataSource.getConnection(); var statement = connection.createStatement()) {
        statement.executeUpdate("insert into document_versions(id,document_id,version_number,status,"
            + "original_file_id,created_by_user_id) values ('" + newerVersionId + "','" + documentId
            + "',2,'file_check','" + fileId + "','" + userId + "')");
        statement.executeUpdate("update document_versions set status='conversion' where id='" + versionId + "'");
        statement.executeUpdate("update documents set status='file_check' where id='" + documentId + "'");
        statement.executeUpdate("update conversion_jobs set status='rendering',lease_owner='retry-worker'"
            + " where id='" + jobId + "'");
      }
      assertThrows(java.sql.SQLException.class,
          () -> new JdbcConversionRepository(dataSource).completeConversion(job, completion));
      try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement(
          "select status from documents where id=?")) {
        statement.setObject(1, documentId);
        try (var rows = statement.executeQuery()) {
          assertTrue(rows.next());
          assertEquals("file_check", rows.getString("status"));
        }
      }
    } finally {
      try (Connection connection = dataSource.getConnection(); var statement = connection.createStatement()) {
        statement.executeUpdate("delete from document_versions where id='" + newerVersionId + "'");
      }
      cleanupConversion(dataSource, userId, documentId, fileId, versionId, jobId);
    }
  }

  @Test
  void retryAfterTransientRenderFailureKeepsTheArchivedOriginal() throws Exception {
    PGSimpleDataSource dataSource = dataSource();
    UUID userId = UUID.randomUUID();
    UUID documentId = UUID.randomUUID();
    UUID fileId = UUID.randomUUID();
    UUID versionId = UUID.randomUUID();
    UUID jobId = UUID.randomUUID();
    byte[] content = Files.readAllBytes(Path.of(System.getenv().getOrDefault(
        "SOKOL_FIXTURE_ROOT", "../test/fixtures/docx")).resolve("valid-minimal.docx"));
    String sha256 = HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(content));
    String sourceKey = documentId + "/" + versionId + "/" + fileId + ".docx";
    String originalKey = documentId + "/" + versionId + "/" + sha256 + ".docx";
    String pdfSha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest("%PDF-retry".getBytes(StandardCharsets.UTF_8)));
    String referenceKey = documentId + "/" + versionId + "/reference/" + pdfSha + ".pdf";
    var service = new BlobServiceClientBuilder().connectionString(STORAGE).buildClient();
    service.getBlobContainerClient("quarantine").createIfNotExists();
    service.getBlobContainerClient("originals").createIfNotExists();
    service.getBlobContainerClient("derivatives").createIfNotExists();
    var source = service.getBlobContainerClient("quarantine").getBlobClient(sourceKey);
    var original = service.getBlobContainerClient("originals").getBlobClient(originalKey);
    var reference = service.getBlobContainerClient("derivatives").getBlobClient(referenceKey);
    source.upload(new ByteArrayInputStream(content), content.length, true);
    try {
      seed(dataSource, userId, documentId, fileId, versionId, jobId,
          sourceKey, source.getProperties().getETag(), sha256, content.length);
      var leases = new JobLeaseRepository(dataSource, Duration.ofMinutes(2));
      assertEquals(jobId, leases.leaseNext("retry-e2e-worker", Instant.now()).orElseThrow().id());
      var processor = new ConversionProcessor(
          new JdbcConversionRepository(dataSource), new AzureBlobStore(STORAGE),
          contentStream -> ClamAvClient.AvStatus.CLEAN);
      var failingRenderer = new LibreOfficeRenderer(command -> {
        throw new java.io.IOException("TRANSIENT_RENDER_FAILURE");
      });
      assertThrows(java.io.IOException.class, () -> processor.processLeasedJob(
          jobId, temporaryDirectory.resolve("failed-retry"), failingRenderer,
          (docx, blocks, directory) -> new ConversionProcessor.GeneratedTableArtifacts(
              List.of(), java.util.Set.of())));
      assertTrue(original.exists());
      assertFalse(source.exists());

      try (Connection connection = dataSource.getConnection(); var statement = connection.createStatement()) {
        statement.executeUpdate("update conversion_jobs set status='failed',current_step='failed',"
            + "error_code='TRANSIENT_RENDER_FAILURE',lease_owner=null,lease_expires_at=null where id='"
            + jobId + "'");
        statement.executeUpdate("update conversion_jobs set status='queued',current_step='file_check',"
            + "error_code=null,next_attempt_at=now(),started_at=null,completed_at=null where id='"
            + jobId + "'");
        statement.executeUpdate("update document_versions set status='file_check',row_version=row_version+1"
            + " where id='" + versionId + "'");
        statement.executeUpdate("update documents set status='file_check',row_version=row_version+1"
            + " where id='" + documentId + "'");
      }
      assertEquals(jobId, leases.leaseNext("retry-e2e-worker", Instant.now()).orElseThrow().id());
      var successfulRenderer = new LibreOfficeRenderer(command -> {
        Files.write(command.workingDirectory().resolve("source.pdf"),
            "%PDF-retry".getBytes(StandardCharsets.UTF_8));
        return new LibreOfficeRenderer.ProcessResult(0, false, "converted");
      });
      processor.processLeasedJob(
          jobId, temporaryDirectory.resolve("successful-retry"), successfulRenderer,
          (docx, blocks, directory) -> new ConversionProcessor.GeneratedTableArtifacts(
              List.of(), java.util.Set.of()));

      assertTrue(original.exists());
      assertTrue(reference.exists());
      try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement(
          "select status from conversion_jobs where id=?")) {
        statement.setObject(1, jobId);
        try (var rows = statement.executeQuery()) {
          assertTrue(rows.next());
          assertEquals("completed", rows.getString("status"));
        }
      }
    } finally {
      cleanupConversion(dataSource, userId, documentId, fileId, versionId, jobId);
      source.deleteIfExists();
      original.deleteIfExists();
      reference.deleteIfExists();
    }
  }

  private static PGSimpleDataSource dataSource() {
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setUrl(System.getenv().getOrDefault(
        "TEST_DATABASE_URL", "jdbc:postgresql://host.docker.internal:55432/sokol_test"));
    dataSource.setUser("sokol");
    dataSource.setPassword("local-only-password");
    return dataSource;
  }

  private static void seed(
      PGSimpleDataSource dataSource, UUID userId, UUID documentId, UUID fileId,
      UUID versionId, UUID jobId, String sourceKey, String etag,
      String sha256, int size) throws Exception {
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (var user = connection.prepareStatement("""
          insert into users(id,first_name,last_name,email,role,status,email_verified_at)
          values (?,'Worker','Test',?,'admin','active',now())
          """)) {
        user.setObject(1, userId);
        user.setString(2, "worker-" + userId + "@example.test");
        user.executeUpdate();
      }
      try (var document = connection.prepareStatement("""
          insert into documents(id,number,title,owner_admin_id,status)
          values (?,?,'Worker E2E',?,'file_check')
          """)) {
        document.setObject(1, documentId);
        document.setString(2, "SOKOL-2099-" + Integer.toUnsignedString(documentId.hashCode()));
        document.setObject(3, userId);
        document.executeUpdate();
      }
      try (var file = connection.prepareStatement("""
          insert into file_objects(
            id,document_id,data_owner_user_id,purpose,container,object_key,
            original_name,declared_mime,detected_mime,size_bytes,sha256,etag)
          values (?,?,?,'original_docx','quarantine',?,'eicar.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',?,?,?)
          """)) {
        file.setObject(1, fileId);
        file.setObject(2, documentId);
        file.setObject(3, userId);
        file.setString(4, sourceKey);
        file.setInt(5, size);
        file.setString(6, sha256);
        file.setString(7, etag);
        file.executeUpdate();
      }
      try (var version = connection.prepareStatement("""
          insert into document_versions(
            id,document_id,version_number,status,original_file_id,created_by_user_id)
          values (?,?,1,'file_check',?,?)
          """)) {
        version.setObject(1, versionId);
        version.setObject(2, documentId);
        version.setObject(3, fileId);
        version.setObject(4, userId);
        version.executeUpdate();
      }
      try (var job = connection.prepareStatement("""
          insert into conversion_jobs(
            id,document_version_id,status,current_step,profile_version,input_sha256,
            idempotency_key,correlation_id)
          values (?,?,'queued','file_check','docx-web-v1',?,?,?)
          """)) {
        job.setObject(1, jobId);
        job.setObject(2, versionId);
        job.setString(3, sha256);
        job.setObject(4, UUID.randomUUID());
        job.setObject(5, UUID.randomUUID());
        job.executeUpdate();
      }
      try (var current = connection.prepareStatement(
          "update document_versions set current_conversion_job_id=? where id=?")) {
        current.setObject(1, jobId);
        current.setObject(2, versionId);
        current.executeUpdate();
      }
      connection.commit();
    }
  }

  private static void cleanup(
      PGSimpleDataSource dataSource, UUID userId, UUID documentId, UUID fileId,
      UUID versionId, UUID jobId) throws Exception {
    try (Connection connection = dataSource.getConnection(); var statement = connection.createStatement()) {
      statement.executeUpdate("delete from security_events where file_object_id='" + fileId + "'");
      statement.executeUpdate("update document_versions set current_conversion_job_id=null where id='" + versionId + "'");
      statement.executeUpdate("delete from conversion_jobs where id='" + jobId + "'");
      statement.executeUpdate("delete from document_versions where id='" + versionId + "'");
      statement.executeUpdate("delete from file_objects where id='" + fileId + "'");
      statement.executeUpdate("delete from documents where id='" + documentId + "'");
      statement.executeUpdate("delete from users where id='" + userId + "'");
    }
  }

  private static void cleanupConversion(
      PGSimpleDataSource dataSource, UUID userId, UUID documentId, UUID fileId,
      UUID versionId, UUID jobId) throws Exception {
    try (Connection connection = dataSource.getConnection(); var statement = connection.createStatement()) {
      statement.executeUpdate("delete from outbox_events where aggregate_id='" + versionId + "'");
      statement.executeUpdate("delete from conversion_findings where conversion_job_id='" + jobId + "'");
      statement.executeUpdate("delete from block_assets where block_revision_id in (select block_revision_id from block_revisions where document_version_id='" + versionId + "')");
      statement.executeUpdate("delete from block_revisions where document_version_id='" + versionId + "'");
      statement.executeUpdate("delete from document_blocks where document_id='" + documentId + "'");
      statement.executeUpdate("delete from file_objects where document_id='" + documentId + "' and purpose in ('reference_render','table_image')");
    }
    cleanup(dataSource, userId, documentId, fileId, versionId, jobId);
  }
}

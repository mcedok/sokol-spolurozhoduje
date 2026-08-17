package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.azure.storage.blob.BlobServiceClientBuilder;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;

class WorkerEndToEndTest {
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
}

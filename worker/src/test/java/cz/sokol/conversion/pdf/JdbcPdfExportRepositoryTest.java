package cz.sokol.conversion.pdf;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;

class JdbcPdfExportRepositoryTest {
  private static PGSimpleDataSource dataSource;

  @BeforeAll
  static void createSchema() throws Exception {
    dataSource = new PGSimpleDataSource();
    dataSource.setUrl(System.getenv().getOrDefault(
        "TEST_DATABASE_URL", "jdbc:postgresql://host.docker.internal:55432/sokol_test"));
    dataSource.setUser("sokol");
    dataSource.setPassword("local-only-password");
    dataSource.setCurrentSchema("pdf_worker_test");
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("drop schema if exists pdf_worker_test cascade");
      statement.execute("create schema pdf_worker_test");
      statement.execute("""
          create table pdf_worker_test.file_objects (
            id uuid primary key, document_id uuid not null, data_owner_user_id uuid not null,
            purpose text not null, container text not null, object_key text not null unique,
            original_name text not null, declared_mime text not null, detected_mime text,
            size_bytes bigint not null, sha256 text not null, etag text,
            av_status text not null, av_checked_at timestamptz,
            object_status text not null, retention_class text not null
          )
          """);
      statement.execute("""
          create table pdf_worker_test.export_jobs (
            id uuid primary key, document_id uuid not null, document_version_id uuid not null,
            requested_by_user_id uuid not null, visibility text not null,
            snapshot jsonb not null, snapshot_sha256 text not null,
            status text not null default 'queued', attempt_count integer not null default 0,
            lease_expires_at timestamptz, output_file_id uuid,
            pdfa_validated boolean, validation_report jsonb,
            error_code text, error_detail text, row_version integer not null default 1,
            created_at timestamptz not null default now(), started_at timestamptz,
            completed_at timestamptz, updated_at timestamptz not null default now()
          )
          """);
    }
  }

  @BeforeEach
  void reset() throws Exception {
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("truncate pdf_worker_test.export_jobs, pdf_worker_test.file_objects");
    }
  }

  @Test
  void claimsQueuedAndRecoversExpiredProcessingJobWithoutDoubleClaim() throws Exception {
    UUID queued = insertJob("queued", null, Instant.parse("2026-08-18T10:00:00Z"));
    UUID stale = insertJob("processing", Instant.parse("2026-08-18T09:00:00Z"),
        Instant.parse("2026-08-18T09:00:00Z"));
    JdbcPdfExportRepository repository = new JdbcPdfExportRepository(
        dataSource, Duration.ofMinutes(2), () -> Instant.parse("2026-08-18T12:00:00Z"));

    assertEquals(stale, repository.claimNext().orElseThrow().id());
    assertEquals(queued, repository.claimNext().orElseThrow().id());
    assertTrue(repository.claimNext().isEmpty());
  }

  @Test
  void completesOnceWithAValidatedDerivativeFile() throws Exception {
    UUID jobId = insertJob("queued", null, Instant.parse("2026-08-18T10:00:00Z"));
    JdbcPdfExportRepository repository = new JdbcPdfExportRepository(
        dataSource, Duration.ofMinutes(2), () -> Instant.parse("2026-08-18T12:00:00Z"));
    PdfExportProcessor.Job job = repository.claimNext().orElseThrow();
    UUID fileId = UUID.randomUUID();
    String digest = "a".repeat(64);

    repository.complete(job, fileId, "derivatives", "doc/export.pdf", digest,
        1234, "etag-1", "PASS PDF/A-2u");

    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      try (var rows = statement.executeQuery("select status, output_file_id, pdfa_validated from export_jobs")) {
        assertTrue(rows.next());
        assertEquals("completed", rows.getString("status"));
        assertEquals(fileId, rows.getObject("output_file_id", UUID.class));
        assertTrue(rows.getBoolean("pdfa_validated"));
      }
      try (var rows = statement.executeQuery("select purpose, object_status, av_status from file_objects")) {
        assertTrue(rows.next());
        assertEquals("pdf_export", rows.getString("purpose"));
        assertEquals("derivative", rows.getString("object_status"));
        assertEquals("clean", rows.getString("av_status"));
      }
    }
  }

  private static UUID insertJob(String status, Instant leaseExpiresAt, Instant createdAt) throws Exception {
    UUID id = UUID.randomUUID();
    try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement("""
        insert into pdf_worker_test.export_jobs (
          id, document_id, document_version_id, requested_by_user_id, visibility,
          snapshot, snapshot_sha256, status, lease_expires_at, created_at
        ) values (?, ?, ?, ?, 'public', '{}'::jsonb, ?, ?, ?, ?)
        """)) {
      statement.setObject(1, id);
      statement.setObject(2, UUID.randomUUID());
      statement.setObject(3, UUID.randomUUID());
      statement.setObject(4, UUID.randomUUID());
      statement.setString(5, "b".repeat(64));
      statement.setString(6, status);
      statement.setObject(7, leaseExpiresAt == null ? null : java.sql.Timestamp.from(leaseExpiresAt));
      statement.setObject(8, java.sql.Timestamp.from(createdAt));
      statement.executeUpdate();
    }
    return id;
  }
}

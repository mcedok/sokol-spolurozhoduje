package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;

class JdbcXlsxImportRepositoryTest {
  private static PGSimpleDataSource dataSource;

  @BeforeAll
  static void createSchema() throws Exception {
    dataSource = new PGSimpleDataSource();
    dataSource.setUrl(System.getenv().getOrDefault(
        "TEST_DATABASE_URL", "jdbc:postgresql://host.docker.internal:55432/sokol_test"));
    dataSource.setUser("sokol");
    dataSource.setPassword("local-only-password");
    dataSource.setCurrentSchema("xlsx_import_worker_test");
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("drop schema if exists xlsx_import_worker_test cascade");
      statement.execute("create schema xlsx_import_worker_test");
      statement.execute("create type user_role as enum ('member','admin','superadmin')");
      statement.execute("create table users (id uuid primary key, role user_role not null)");
      statement.execute("""
          create table audit_events (
            id uuid primary key, actor_user_id uuid references users(id), actor_role user_role,
            action text not null, target_type text not null, target_id uuid,
            outcome text not null, correlation_id uuid not null, metadata jsonb not null,
            previous_hash text, event_hash text not null unique,
            chain_sequence bigint generated always as identity,
            created_at timestamptz not null default now()
          )
          """);
      statement.execute("""
          create table file_objects (
            id uuid primary key, container text not null, object_key text not null,
            etag text, av_status text default 'pending', av_checked_at timestamptz,
            object_status text default 'quarantined'
          )
          """);
      statement.execute("""
          create table xlsx_export_jobs (
            id uuid primary key, document_version_id uuid not null, snapshot jsonb not null,
            snapshot_sha256 text not null, row_count integer not null, signing_key_id text not null
          )
          """);
      statement.execute("""
          create table xlsx_import_batches (
            id uuid primary key, document_id uuid not null, export_job_id uuid not null,
            input_file_id uuid not null, status text not null, file_sha256 text not null,
            uploaded_by_user_id uuid not null, attempt_count integer not null default 0,
            lease_expires_at timestamptz, lease_token uuid, started_at timestamptz, signing_key_id text,
            safe_apply_correlation_id uuid, safe_apply_idempotency_key uuid,
            safe_apply_lease_token uuid, safe_apply_next_attempt_at timestamptz,
            safe_apply_attempt_count integer not null default 0,
            row_count integer not null default 0, counts jsonb not null default '{}',
            manifest_sha256 text, error_code text, error_detail text,
            row_version integer not null default 1, created_at timestamptz not null default now(),
            completed_at timestamptz, updated_at timestamptz not null default now()
          )
          """);
      statement.execute("""
          create table xlsx_import_stage_events (
            id uuid primary key, batch_id uuid not null, event_type text not null,
            status text not null, details jsonb not null, created_at timestamptz not null default now()
          )
          """);
      statement.execute("""
          create table xlsx_import_rows (
            id uuid primary key, batch_id uuid not null, source_row_number integer not null,
            comment_id uuid not null, source_comment_row_version integer not null,
            source_settlement_row_version integer, base_values jsonb not null,
            current_comment_row_version integer not null default 1,
            current_settlement_row_version integer,
            current_values jsonb not null, incoming_values jsonb not null,
            classification text not null, validation_errors jsonb not null default '[]',
            row_version integer not null default 1, created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(), unique(batch_id, comment_id),
            unique(batch_id, source_row_number)
          )
          """);
    }
  }

  @BeforeEach
  void reset() throws Exception {
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("truncate xlsx_import_rows, xlsx_import_stage_events, audit_events, xlsx_import_batches, xlsx_export_jobs, file_objects, users");
    }
  }

  @Test
  void rejectsAnyChangeToLockedWorkbookFields() throws Exception {
    var source = new ObjectMapper().readTree("""
        {"publicId":"PRIP-2026-940000","blockOrder":4,"blockText":"Blok",
         "authorName":"Jan Člen","organizationName":"TJ Test",
         "createdAt":"2026-08-19T12:00:00Z","body":"Původní text"}
        """);
    String[] values = {
        "PRIP-2026-940000", "4", "Blok", "Jan Člen", "TJ Test",
        "2026-08-19T12:00:00Z", "Změněný text", "comment", "normal", "open",
        "", "", "", "", ""
    };

    XlsxValidationException error = assertThrows(XlsxValidationException.class,
        () -> JdbcXlsxImportRepository.validateLockedFields(source, values));
    assertEquals("LOCKED_FIELD_TAMPERED", error.getMessage());
  }

  @Test
  void validatesCompleteSettlementsAndRejectsSettlementDataOnOpenRows() {
    String[] incomplete = {
        "id", "1", "block", "author", "org", "date", "body",
        "comment", "normal", "settled", "accepted", "statement", "", "Admin", ""
    };
    var incompleteErrors = new ObjectMapper().createArrayNode();
    JdbcXlsxImportRepository.validateEditableFields(incomplete, incompleteErrors);
    assertTrue(incompleteErrors.toString().contains("INCOMPLETE_SETTLEMENT"));

    String[] openWithSettlement = incomplete.clone();
    openWithSettlement[9] = "open";
    openWithSettlement[14] = "2026-08-19";
    var openErrors = new ObjectMapper().createArrayNode();
    JdbcXlsxImportRepository.validateEditableFields(openWithSettlement, openErrors);
    assertTrue(openErrors.toString().contains("SETTLEMENT_DATA_WITHOUT_SETTLED_STATUS"));
  }

  @Test
  void leasesArchivesAndMovesAnEmptyVerifiedWorkbookToComparing() throws Exception {
    UUID batchId = UUID.randomUUID();
    UUID documentId = UUID.randomUUID();
    UUID exportId = UUID.randomUUID();
    UUID versionId = UUID.randomUUID();
    UUID userId = UUID.randomUUID();
    UUID fileId = UUID.randomUUID();
    try (Connection connection = dataSource.getConnection()) {
      try (var statement = connection.prepareStatement("insert into users(id,role) values (?,'admin')")) {
        statement.setObject(1, userId); statement.executeUpdate();
      }
      try (var statement = connection.prepareStatement(
          "insert into file_objects(id,container,object_key,etag) values (?,'quarantine','upload.xlsx','etag-1')")) {
        statement.setObject(1, fileId); statement.executeUpdate();
      }
      try (var statement = connection.prepareStatement("""
          insert into xlsx_export_jobs(id,document_version_id,snapshot,snapshot_sha256,row_count,signing_key_id)
          values (?,?,'{"comments":[]}'::jsonb,?,0,'key-1')
          """)) {
        statement.setObject(1, exportId); statement.setObject(2, versionId);
        statement.setString(3, "a".repeat(64)); statement.executeUpdate();
      }
      try (var statement = connection.prepareStatement("""
          insert into xlsx_import_batches(id,document_id,export_job_id,input_file_id,status,
            file_sha256,uploaded_by_user_id) values (?,?,?,?, 'uploaded',?,?)
          """)) {
        statement.setObject(1, batchId); statement.setObject(2, documentId);
        statement.setObject(3, exportId); statement.setObject(4, fileId);
        statement.setString(5, "b".repeat(64)); statement.setObject(6, userId);
        statement.executeUpdate();
      }
    }
    JdbcXlsxImportRepository repository = new JdbcXlsxImportRepository(dataSource, Duration.ofMinutes(2));

    XlsxImportProcessor.Job job = repository.claimNext().orElseThrow();
    assertEquals(batchId, job.id());
    assertTrue(repository.claimNext().isEmpty());
    repository.renewLease(job);
    repository.markArchived(job, "originals", "archive.xlsx", "etag-2");
    XlsxImportProcessor.SafeApplyCommand completed =
        repository.complete(job, new XlsxImportParser.ParsedWorkbook(List.of()));
    XlsxImportProcessor.SafeApplyCommand claimed = repository.claimSafeApply().orElseThrow();
    assertEquals(completed.batchId(), claimed.batchId());
    assertEquals(completed.expectedBatchRowVersion(), claimed.expectedBatchRowVersion());
    assertEquals(completed.correlationId(), claimed.correlationId());
    assertEquals(completed.idempotencyKey(), claimed.idempotencyKey());
    assertTrue(claimed.dispatchLeaseToken() != null);
    assertTrue(repository.claimSafeApply().isEmpty());
    repository.releaseSafeApply(claimed, "simulated crash");
    assertTrue(repository.claimSafeApply().isEmpty());
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("update xlsx_import_batches set safe_apply_next_attempt_at=now()-interval '1 second', safe_apply_attempt_count=7");
    }
    XlsxImportProcessor.SafeApplyCommand finalAttempt = repository.claimSafeApply().orElseThrow();
    repository.releaseSafeApply(claimed, "stale worker must not release a newer lease");
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement();
         var rows = statement.executeQuery("select safe_apply_lease_token from xlsx_import_batches")) {
      assertTrue(rows.next());
      assertEquals(finalAttempt.dispatchLeaseToken(), rows.getObject(1, UUID.class));
    }
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("update xlsx_import_batches set lease_expires_at=now()-interval '1 second'");
    }
    assertTrue(repository.claimSafeApply().isEmpty());
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement();
         var rows = statement.executeQuery("select status,error_code from xlsx_import_batches")) {
      assertTrue(rows.next());
      assertEquals("failed", rows.getString("status"));
      assertEquals("SAFE_APPLY_CALLBACK_FAILED", rows.getString("error_code"));
    }
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("""
          update xlsx_import_batches set status='comparing', completed_at=null,
            safe_apply_attempt_count=7, safe_apply_next_attempt_at=now()-interval '1 second'
          """);
    }
    XlsxImportProcessor.SafeApplyCommand releasedFinalAttempt = repository.claimSafeApply().orElseThrow();
    repository.releaseSafeApply(releasedFinalAttempt, "permanent callback failure");

    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement();
         var rows = statement.executeQuery("select status,row_count,lease_expires_at from xlsx_import_batches")) {
      assertTrue(rows.next());
      assertEquals("failed", rows.getString("status"));
      assertEquals(0, rows.getInt("row_count"));
      assertEquals(null, rows.getObject("lease_expires_at"));
    }
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement();
         var rows = statement.executeQuery("select event_type from xlsx_import_stage_events order by created_at")) {
      assertTrue(rows.next()); assertEquals("claimed", rows.getString(1));
      assertTrue(rows.next()); assertEquals("archived", rows.getString(1));
      assertTrue(rows.next()); assertEquals("compared", rows.getString(1));
    }
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement();
         var rows = statement.executeQuery("select action,previous_hash,event_hash from audit_events order by created_at,id")) {
      String previous = null;
      for (String action : List.of("xlsx_import.worker_claimed", "xlsx_import.worker_archived", "xlsx_import.worker_compared")) {
        assertTrue(rows.next());
        assertEquals(action, rows.getString("action"));
        assertEquals(previous, rows.getString("previous_hash"));
        previous = rows.getString("event_hash");
      }
    }
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("update xlsx_import_batches set status='scanning', attempt_count=5, lease_expires_at=now()-interval '1 second', completed_at=null");
    }
    assertTrue(repository.claimNext().isEmpty());
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement();
         var rows = statement.executeQuery("select status,error_code from xlsx_import_batches")) {
      assertTrue(rows.next());
      assertEquals("failed", rows.getString("status"));
      assertEquals("IMPORT_RETRY_EXHAUSTED", rows.getString("error_code"));
    }
  }

  @Test
  void fencesAWorkerWhoseLeaseWasReclaimed() throws Exception {
    // The full fixture above already proves normal claiming; this check exercises the token predicate.
    UUID staleToken = UUID.randomUUID();
    var stale = new XlsxImportProcessor.Job(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
        UUID.randomUUID(), UUID.randomUUID(), "quarantine", "x", "e", "h", "{}", "s", 0,
        "key", staleToken, 1_000L);
    JdbcXlsxImportRepository repository = new JdbcXlsxImportRepository(dataSource, Duration.ofMinutes(2));
    assertThrows(SQLException.class, () -> repository.renewLease(stale));
  }
}

package cz.sokol.conversion;

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

class JobLeaseRepositoryTest {
  private static PGSimpleDataSource dataSource;

  @BeforeAll
  static void createSchema() throws Exception {
    dataSource = new PGSimpleDataSource();
    dataSource.setUrl(System.getenv().getOrDefault(
        "TEST_DATABASE_URL", "jdbc:postgresql://host.docker.internal:55432/sokol_test"));
    dataSource.setUser("sokol");
    dataSource.setPassword("local-only-password");
    dataSource.setCurrentSchema("worker_test");
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("create schema if not exists worker_test");
      statement.execute("""
          create table if not exists worker_test.conversion_jobs (
            id uuid primary key,
            status text not null,
            attempt_count integer not null default 0,
            next_attempt_at timestamptz,
            lease_owner text,
            lease_expires_at timestamptz,
            heartbeat_at timestamptz,
            error_code text,
            created_at timestamptz not null
          )
          """);
      statement.execute("""
          alter table worker_test.conversion_jobs
          add column if not exists error_code text
          """);
    }
  }

  @BeforeEach
  void resetJobs() throws Exception {
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("truncate worker_test.conversion_jobs");
    }
  }

  @Test
  void onlyOneWorkerLeasesAQueuedJob() throws Exception {
    UUID id = UUID.randomUUID();
    Instant now = Instant.parse("2026-08-17T08:00:00Z");
    try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement(
        "insert into worker_test.conversion_jobs(id,status,created_at) values (?,'queued',?)")) {
      statement.setObject(1, id);
      statement.setObject(2, java.sql.Timestamp.from(now.minusSeconds(60)));
      statement.executeUpdate();
    }
    JobLeaseRepository repository = new JobLeaseRepository(dataSource, Duration.ofMinutes(2));

    var first = repository.leaseNext("worker-a", now);
    var second = repository.leaseNext("worker-b", now);

    assertTrue(first.isPresent());
    assertTrue(second.isEmpty());
    assertEquals(id, first.orElseThrow().id());
    assertEquals("worker-a", first.orElseThrow().leaseOwner());
    assertEquals(now.plus(Duration.ofMinutes(2)), first.orElseThrow().leaseExpiresAt());
  }

  @Test
  void retriesAfterOneFiveAndTwentyMinutesThenFails() throws Exception {
    UUID id = UUID.randomUUID();
    Instant now = Instant.parse("2026-08-17T08:00:00Z");
    try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement(
        "insert into worker_test.conversion_jobs(id,status,attempt_count,created_at) values (?,'leased',1,?)")) {
      statement.setObject(1, id);
      statement.setObject(2, java.sql.Timestamp.from(now.minusSeconds(60)));
      statement.executeUpdate();
    }
    JobLeaseRepository repository = new JobLeaseRepository(dataSource, Duration.ofMinutes(2));

    assertEquals(now.plus(Duration.ofMinutes(1)),
        repository.recordTransientFailure(id, now, "TEMPORARY").nextAttemptAt());
    setAttempt(id, 2);
    assertEquals(now.plus(Duration.ofMinutes(5)),
        repository.recordTransientFailure(id, now, "TEMPORARY").nextAttemptAt());
    setAttempt(id, 3);
    assertEquals(now.plus(Duration.ofMinutes(20)),
        repository.recordTransientFailure(id, now, "TEMPORARY").nextAttemptAt());
    setAttempt(id, 4);
    var failed = repository.recordTransientFailure(id, now, "TEMPORARY");
    assertEquals("failed", failed.status());
    assertEquals(null, failed.nextAttemptAt());
  }

  private static void setAttempt(UUID id, int attempt) throws Exception {
    try (Connection connection = dataSource.getConnection(); var statement = connection.prepareStatement(
        "update worker_test.conversion_jobs set status='leased', attempt_count=? where id=?")) {
      statement.setInt(1, attempt);
      statement.setObject(2, id);
      statement.executeUpdate();
    }
  }
}

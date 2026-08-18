package cz.sokol.conversion;

import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import javax.sql.DataSource;

public final class JobLeaseRepository {
  private static final Duration[] RETRY_DELAYS = {
      Duration.ofMinutes(1), Duration.ofMinutes(5), Duration.ofMinutes(20)
  };

  private final DataSource dataSource;
  private final Duration leaseDuration;

  public JobLeaseRepository(DataSource dataSource, Duration leaseDuration) {
    this.dataSource = dataSource;
    this.leaseDuration = leaseDuration;
  }

  public Optional<LeasedJob> leaseNext(String workerId, Instant now) throws SQLException {
    String sql = """
        with candidate as (
          select id from conversion_jobs
          where status in ('queued','retry_wait')
            and coalesce(next_attempt_at, ?) <= ?
            and (lease_expires_at is null or lease_expires_at < ?)
          order by created_at for update skip locked limit 1
        )
        update conversion_jobs job
        set status='leased', lease_owner=?, lease_expires_at=?, heartbeat_at=?,
            attempt_count=attempt_count+1
        from candidate where job.id=candidate.id
        returning job.id, job.lease_owner, job.lease_expires_at, job.attempt_count
        """;
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (var statement = connection.prepareStatement(sql)) {
        Timestamp timestamp = Timestamp.from(now);
        statement.setTimestamp(1, timestamp);
        statement.setTimestamp(2, timestamp);
        statement.setTimestamp(3, timestamp);
        statement.setString(4, workerId);
        statement.setTimestamp(5, Timestamp.from(now.plus(leaseDuration)));
        statement.setTimestamp(6, timestamp);
        try (var rows = statement.executeQuery()) {
          if (!rows.next()) {
            connection.commit();
            return Optional.empty();
          }
          LeasedJob job = new LeasedJob(
              rows.getObject("id", UUID.class),
              rows.getString("lease_owner"),
              rows.getTimestamp("lease_expires_at").toInstant(),
              rows.getInt("attempt_count"));
          connection.commit();
          return Optional.of(job);
        }
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  public FailureState recordTransientFailure(UUID id, Instant now, String errorCode)
      throws SQLException {
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        int previousAttempts;
        try (var statement = connection.prepareStatement(
            "select attempt_count from conversion_jobs where id=? for update")) {
          statement.setObject(1, id);
          try (var rows = statement.executeQuery()) {
            if (!rows.next()) throw new SQLException("Převodní úloha nebyla nalezena.");
            previousAttempts = rows.getInt(1);
          }
        }
        int failureNumber = previousAttempts;
        if (failureNumber < 1) throw new SQLException("Převodní úloha nebyla pronajata.");
        boolean failed = failureNumber > RETRY_DELAYS.length;
        Instant nextAttemptAt = failed ? null : now.plus(RETRY_DELAYS[failureNumber - 1]);
        try (var statement = connection.prepareStatement("""
            update conversion_jobs set status=?, attempt_count=?, next_attempt_at=?,
              error_code=?, lease_owner=null, lease_expires_at=null, heartbeat_at=null
            where id=?
            """)) {
          statement.setString(1, failed ? "failed" : "retry_wait");
          statement.setInt(2, previousAttempts);
          statement.setTimestamp(3, nextAttemptAt == null ? null : Timestamp.from(nextAttemptAt));
          statement.setString(4, errorCode);
          statement.setObject(5, id);
          statement.executeUpdate();
        }
        connection.commit();
        return new FailureState(failed ? "failed" : "retry_wait", failureNumber, nextAttemptAt);
      } catch (Exception error) {
        connection.rollback();
        throw error;
      }
    }
  }

  public record LeasedJob(UUID id, String leaseOwner, Instant leaseExpiresAt, int attemptCount) {}

  public record FailureState(String status, int attemptCount, Instant nextAttemptAt) {}
}

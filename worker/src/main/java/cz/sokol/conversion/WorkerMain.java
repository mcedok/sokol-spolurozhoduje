package cz.sokol.conversion;

import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.postgresql.ds.PGSimpleDataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class WorkerMain {
  private static final Logger LOGGER = LoggerFactory.getLogger(WorkerMain.class);

  private WorkerMain() {}

  public static void main(String[] arguments) throws Exception {
    WorkerConfig config = WorkerConfig.fromEnvironment(System.getenv());
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setUrl(config.databaseUrl());
    dataSource.setUser(config.databaseUser());
    dataSource.setPassword(config.databasePassword());
    JobLeaseRepository leases = new JobLeaseRepository(
        dataSource, Duration.ofSeconds(config.leaseSeconds()));
    ConversionProcessor processor = new ConversionProcessor(
        new JdbcConversionRepository(dataSource),
        new AzureBlobStore(config.storageConnectionString()),
        new ClamAvClient(config.clamAvHost(), config.clamAvPort(), Duration.ofMinutes(2)));
    QuarantineRetention retention = new QuarantineRetention(
        new JdbcQuarantineRetentionRepository(dataSource),
        new AzureBlobStore(config.storageConnectionString()),
        Clock.systemUTC());
    Instant nextRetention = Instant.EPOCH;

    while (!Thread.currentThread().isInterrupted()) {
      Instant now = Instant.now();
      if (!now.isBefore(nextRetention)) {
        try {
          retention.purge();
        } catch (Exception error) {
          LOGGER.error("Řízená retence karantény selhala.", error);
        }
        nextRetention = now.plus(Duration.ofHours(1));
      }
      var leased = leases.leaseNext(config.workerId(), now);
      if (leased.isEmpty()) {
        Thread.sleep(Duration.ofSeconds(2));
        continue;
      }
      try {
        processor.processLeasedJob(
            leased.orElseThrow().id(),
            Path.of(System.getenv().getOrDefault("TMPDIR", "/tmp/conversion")),
            new LibreOfficeRenderer());
      } catch (Exception error) {
        LOGGER.error("Převodní úloha selhala přechodnou chybou.", error);
        leases.recordTransientFailure(leased.orElseThrow().id(), Instant.now(), "TRANSIENT_FAILURE");
      }
    }
  }
}

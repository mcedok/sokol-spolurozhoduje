package cz.sokol.conversion;

import cz.sokol.conversion.pdf.JdbcPdfExportRepository;
import cz.sokol.conversion.pdf.PdfAValidator;
import cz.sokol.conversion.pdf.PdfExportProcessor;
import cz.sokol.conversion.pdf.PdfExportRenderer;
import cz.sokol.conversion.xlsx.JdbcXlsxExportRepository;
import cz.sokol.conversion.xlsx.JdbcXlsxImportRepository;
import cz.sokol.conversion.xlsx.HttpXlsxSafeApplyClient;
import cz.sokol.conversion.xlsx.XlsxExportProcessor;
import cz.sokol.conversion.xlsx.XlsxImportParser;
import cz.sokol.conversion.xlsx.XlsxImportProcessor;
import cz.sokol.conversion.xlsx.XlsxSecurityPolicy;
import cz.sokol.conversion.xlsx.XlsxWorkbookRenderer;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
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
    PdfExportProcessor pdfExports = new PdfExportProcessor(
        new JdbcPdfExportRepository(dataSource, Duration.ofSeconds(config.leaseSeconds())),
        new AzureBlobStore(config.storageConnectionString()),
        new PdfExportRenderer(Path.of(config.fontRoot()))::render,
        new PdfAValidator(
            List.of(config.veraPdfCommand()),
            Duration.ofSeconds(config.pdfValidationTimeoutSeconds()))::validate);
    AzureBlobStore xlsxBlobStore = new AzureBlobStore(config.storageConnectionString());
    byte[] manifestSecret = config.xlsxManifestSecret()
        .getBytes(java.nio.charset.StandardCharsets.UTF_8);
    Map<String, byte[]> manifestVerificationKeys = new HashMap<>();
    manifestVerificationKeys.put(config.xlsxManifestKeyId(), manifestSecret);
    if (!config.xlsxManifestRetainedKeys().isBlank()) {
      for (String item : config.xlsxManifestRetainedKeys().split(",")) {
        String[] pair = item.trim().split(":", 2);
        if (pair.length != 2 || pair[0].isBlank() || pair[1].isBlank()) {
          throw new IllegalArgumentException("XLSX_MANIFEST_RETAINED_KEYS má neplatný formát.");
        }
        manifestVerificationKeys.put(pair[0], java.util.Base64.getDecoder().decode(pair[1]));
      }
    }
    XlsxExportProcessor xlsxExports = new XlsxExportProcessor(
        new JdbcXlsxExportRepository(dataSource, Duration.ofSeconds(config.leaseSeconds())),
        xlsxBlobStore,
        new XlsxWorkbookRenderer()::render,
        manifestVerificationKeys);
    XlsxImportProcessor xlsxImports = new XlsxImportProcessor(
        new JdbcXlsxImportRepository(dataSource, Duration.ofSeconds(config.leaseSeconds())),
        xlsxBlobStore,
        new ClamAvClient(config.clamAvHost(), config.clamAvPort(), Duration.ofMinutes(2)),
        new XlsxImportParser(), new XlsxSecurityPolicy(
            config.xlsxMaxBytes(), config.xlsxMaxRows(), config.xlsxMaxZipEntries(),
            config.xlsxMaxUnpackedBytes(), 32_767, 10_000_000L), manifestVerificationKeys,
        new HttpXlsxSafeApplyClient(
            config.applicationInternalUrl(), config.workerCallbackSecret()));
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
      boolean pdfProcessed = false;
      try {
        pdfProcessed = pdfExports.processNext(
            Path.of(System.getenv().getOrDefault("TMPDIR", "/tmp/conversion"), "pdf"));
      } catch (Exception error) {
        LOGGER.error("PDF exportní úloha selhala.", error);
      }
      try {
        xlsxExports.processNext(
            Path.of(System.getenv().getOrDefault("TMPDIR", "/tmp/conversion"), "xlsx"));
      } catch (Exception error) {
        LOGGER.error("XLSX exportní úloha selhala.", error);
      }
      try {
        xlsxImports.processNext(
            Path.of(System.getenv().getOrDefault("TMPDIR", "/tmp/conversion"), "xlsx-import"));
      } catch (Exception error) {
        LOGGER.error("XLSX importní úloha selhala.", error);
      }
      var leased = leases.leaseNext(config.workerId(), now);
      if (leased.isEmpty()) {
        if (!pdfProcessed) Thread.sleep(Duration.ofSeconds(2));
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

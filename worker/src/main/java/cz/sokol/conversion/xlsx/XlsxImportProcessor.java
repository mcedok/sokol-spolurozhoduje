package cz.sokol.conversion.xlsx;

import cz.sokol.conversion.BlobStore;
import cz.sokol.conversion.ClamAvClient;
import cz.sokol.conversion.VirusScanner;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.Optional;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Executes the untrusted-upload boundary before rows can enter import staging. */
public final class XlsxImportProcessor {
  private final Repository repository;
  private final BlobStore blobs;
  private final VirusScanner scanner;
  private final XlsxImportParser parser;
  private final XlsxSecurityPolicy policy;
  private final Map<String, byte[]> verificationKeys;
  private final SafeApplyClient safeApplyClient;

  public XlsxImportProcessor(Repository repository, BlobStore blobs, VirusScanner scanner,
      XlsxImportParser parser, XlsxSecurityPolicy policy, String signingKeyId,
      byte[] signingSecret, SafeApplyClient safeApplyClient) {
    this(repository, blobs, scanner, parser, policy,
        Map.of(signingKeyId, signingSecret), safeApplyClient);
  }

  public XlsxImportProcessor(Repository repository, BlobStore blobs, VirusScanner scanner,
      XlsxImportParser parser, XlsxSecurityPolicy policy, Map<String, byte[]> verificationKeys,
      SafeApplyClient safeApplyClient) {
    this.repository = repository;
    this.blobs = blobs;
    this.scanner = scanner;
    this.parser = parser;
    this.policy = policy;
    this.verificationKeys = verificationKeys.entrySet().stream().collect(
        java.util.stream.Collectors.toUnmodifiableMap(Map.Entry::getKey,
            entry -> entry.getValue().clone()));
    this.safeApplyClient = safeApplyClient;
  }

  public boolean processNext(Path workRoot) throws Exception {
    Optional<SafeApplyCommand> pendingSafeApply = repository.claimSafeApply();
    if (pendingSafeApply.isPresent()) {
      SafeApplyCommand command = pendingSafeApply.orElseThrow();
      try {
        safeApplyClient.apply(command);
      } catch (Exception error) {
        repository.releaseSafeApply(command, error.toString());
      }
      return true;
    }
    Optional<Job> claimed = repository.claimNext();
    if (claimed.isEmpty()) return false;
    Job job = claimed.orElseThrow();
    var heartbeat = Executors.newSingleThreadScheduledExecutor(runnable -> {
      Thread thread = new Thread(runnable, "xlsx-import-lease-" + job.id());
      thread.setDaemon(true);
      return thread;
    });
    heartbeat.scheduleAtFixedRate(() -> {
      try { repository.renewLease(job); } catch (Exception ignored) { /* fenced transitions remain authoritative */ }
    }, job.leaseHeartbeatMillis(), job.leaseHeartbeatMillis(), TimeUnit.MILLISECONDS);
    try {
      byte[] signingSecret = verificationKeys.get(job.signingKeyId());
      if (signingSecret == null) {
        throw new XlsxValidationException("MANIFEST_KEY_UNKNOWN");
      }
      ArchivedSource source = archive(job);
      Path root = workRoot.toAbsolutePath().normalize();
      Files.createDirectories(root);
      Path directory = Files.createTempDirectory(root, job.id() + "-");
      try {
        Path workbook = directory.resolve("import.xlsx");
        try (InputStream content = blobs.open(source.container(), source.key())) {
          Files.copy(content, workbook, StandardCopyOption.REPLACE_EXISTING);
        }
        if (!job.fileSha256().equals(sha256(workbook))) {
          throw new XlsxValidationException("FILE_INTEGRITY");
        }
        XlsxImportParser.ParsedWorkbook parsed = parser.parse(workbook, policy,
            new XlsxImportParser.ManifestExpectation(
                job.exportJobId().toString(), job.snapshotSha256(), job.rowCount(),
                job.documentId().toString(), job.documentVersionId().toString(), job.signingKeyId(),
                XlsxCanonicalJson.sha256(new com.fasterxml.jackson.databind.ObjectMapper()
                    .readTree(job.snapshotJson()).path("comments").toString())),
            signingSecret);
        SafeApplyCommand command = repository.complete(job, parsed);
        try {
          safeApplyClient.apply(command);
        } catch (Exception error) {
          repository.releaseSafeApply(command, error.toString());
        }
      } finally {
        deleteTree(directory);
      }
      return true;
    } catch (XlsxValidationException error) {
      repository.fail(job, error.getMessage(), error.toString());
      return true;
    } catch (Exception error) {
      repository.fail(job, "IMPORT_PROCESSING_FAILED", error.toString());
      throw error;
    } finally {
      heartbeat.shutdownNow();
    }
  }

  private ArchivedSource archive(Job job) throws Exception {
    String targetContainer = "originals";
    String targetKey = job.documentId() + "/xlsx-imports/" + job.id() + "/"
        + job.fileSha256() + ".xlsx";
    Optional<BlobStore.StoredBlob> existing = blobs.probe(targetContainer, targetKey);
    if (existing.isPresent()) {
      BlobStore.StoredBlob stored = existing.orElseThrow();
      if (!job.fileSha256().equals(stored.sha256())) {
        throw new XlsxValidationException("FILE_INTEGRITY");
      }
      if (!(targetContainer.equals(job.sourceContainer()) && targetKey.equals(job.sourceKey()))) {
        Optional<BlobStore.StoredBlob> source = blobs.probe(job.sourceContainer(), job.sourceKey());
        if (source.isPresent() && (!job.sourceEtag().equals(source.orElseThrow().etag())
            || !blobs.deleteIfMatch(job.sourceContainer(), job.sourceKey(), job.sourceEtag()))) {
          throw new XlsxValidationException("SOURCE_CHANGED");
        }
      }
      repository.markArchived(job, targetContainer, targetKey, stored.etag());
      return new ArchivedSource(targetContainer, targetKey);
    }
    if (targetContainer.equals(job.sourceContainer()) && targetKey.equals(job.sourceKey())) {
      throw new XlsxValidationException("ARCHIVED_SOURCE_MISSING");
    }
    try (InputStream content = blobs.open(job.sourceContainer(), job.sourceKey())) {
      if (scanner.scan(content) == ClamAvClient.AvStatus.INFECTED) {
        throw new XlsxValidationException("MALWARE_DETECTED");
      }
    }
    BlobStore.StoredBlob stored = blobs.copyIfAbsent(job.sourceContainer(), job.sourceKey(),
        targetContainer, targetKey, job.fileSha256());
    if (!job.fileSha256().equals(stored.sha256())
        || !blobs.deleteIfMatch(job.sourceContainer(), job.sourceKey(), job.sourceEtag())) {
      throw new XlsxValidationException("FILE_INTEGRITY");
    }
    repository.markArchived(job, targetContainer, targetKey, stored.etag());
    return new ArchivedSource(targetContainer, targetKey);
  }

  private static String sha256(Path path) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream input = Files.newInputStream(path)) {
      byte[] buffer = new byte[64 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (count > 0) digest.update(buffer, 0, count);
      }
    }
    return HexFormat.of().formatHex(digest.digest());
  }

  private static void deleteTree(Path root) throws Exception {
    if (!Files.exists(root)) return;
    try (var paths = Files.walk(root)) {
      for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
        Files.deleteIfExists(path);
      }
    }
  }

  public interface Repository {
    Optional<SafeApplyCommand> claimSafeApply() throws Exception;
    void releaseSafeApply(SafeApplyCommand command, String detail) throws Exception;
    Optional<Job> claimNext() throws Exception;
    void renewLease(Job job) throws Exception;
    void markArchived(Job job, String container, String key, String etag) throws Exception;
    SafeApplyCommand complete(Job job, XlsxImportParser.ParsedWorkbook workbook) throws Exception;
    void fail(Job job, String code, String detail) throws Exception;
  }

  public record Job(UUID id, UUID documentId, UUID exportJobId, UUID documentVersionId,
      UUID uploadedByUserId, String sourceContainer, String sourceKey, String sourceEtag,
      String fileSha256, String snapshotJson, String snapshotSha256, int rowCount,
      String signingKeyId, UUID leaseToken, long leaseHeartbeatMillis) {}

  public record SafeApplyCommand(UUID batchId, int expectedBatchRowVersion,
      UUID correlationId, UUID idempotencyKey, UUID dispatchLeaseToken) {}

  @FunctionalInterface
  public interface SafeApplyClient {
    void apply(SafeApplyCommand command) throws Exception;
  }

  private record ArchivedSource(String container, String key) {}
}

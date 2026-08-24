package cz.sokol.conversion.xlsx;

import cz.sokol.conversion.BlobStore;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public final class XlsxExportProcessor {
  private final Repository repository;
  private final BlobStore blobs;
  private final Renderer renderer;
  private final Map<String, byte[]> signingKeys;

  public XlsxExportProcessor(Repository repository, BlobStore blobs, Renderer renderer, byte[] signingSecret) {
    this(repository, blobs, renderer, Map.of("__legacy__", signingSecret));
  }

  public XlsxExportProcessor(Repository repository, BlobStore blobs, Renderer renderer,
      Map<String, byte[]> signingKeys) {
    this.repository = repository;
    this.blobs = blobs;
    this.renderer = renderer;
    this.signingKeys = signingKeys.entrySet().stream().collect(
        java.util.stream.Collectors.toUnmodifiableMap(Map.Entry::getKey,
            entry -> entry.getValue().clone()));
  }

  public boolean processNext(Path workRoot) throws Exception {
    Optional<Job> claimed = repository.claimNext();
    if (claimed.isEmpty()) return false;
    Job job = claimed.orElseThrow();
    Path root = workRoot.toAbsolutePath().normalize();
    Files.createDirectories(root);
    Path directory = Files.createTempDirectory(root, "xlsx-export-" + job.id() + "-");
    try {
      if (!job.snapshotSha256().equals(XlsxCanonicalJson.sha256(job.snapshotJson()))) {
        repository.fail(job, "SNAPSHOT_INTEGRITY", "Checksum snapshotu neodpovídá obsahu.");
        return true;
      }
      Path output = directory.resolve("pripominky.xlsx");
      byte[] signingSecret = signingKeys.get(job.signingKeyId());
      if (signingSecret == null && signingKeys.size() == 1 && signingKeys.containsKey("__legacy__")) {
        signingSecret = signingKeys.get("__legacy__");
      }
      if (signingSecret == null) {
        repository.fail(job, "MANIFEST_KEY_UNKNOWN", "Podpisový klíč exportu není dostupný.");
        return true;
      }
      renderer.render(job.snapshotJson(), output, job.id().toString(), job.signingKeyId(), signingSecret);
      String sha256 = digest(output);
      String key = job.documentId() + "/" + job.documentVersionId() + "/exports/"
          + job.id() + "/" + sha256 + ".xlsx";
      BlobStore.StoredBlob stored = blobs.putIfAbsent(
          "derivatives", key, output, sha256,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      if (!sha256.equals(stored.sha256())) {
        repository.fail(job, "OUTPUT_INTEGRITY", "Hash uloženého XLSX neodpovídá derivátu.");
        return true;
      }
      repository.complete(job, UUID.randomUUID(), "derivatives", key, sha256,
          Files.size(output), stored.etag());
      return true;
    } catch (Exception error) {
      repository.fail(job, "XLSX_EXPORT_PROCESSING_FAILED", limited(error.getMessage()));
      throw error;
    } finally {
      if (Files.exists(directory)) {
        try (var paths = Files.walk(directory)) {
          for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
      }
    }
  }

  private static String digest(Path path) throws Exception {
    try (InputStream input = Files.newInputStream(path)) {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] buffer = new byte[64 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) if (count > 0) digest.update(buffer, 0, count);
      return HexFormat.of().formatHex(digest.digest());
    }
  }

  private static String digest(byte[] content) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
  }

  private static String limited(String value) {
    String text = value == null ? "" : value;
    return text.length() <= 8_000 ? text : text.substring(0, 8_000);
  }

  public interface Repository {
    Optional<Job> claimNext() throws Exception;
    void complete(Job job, UUID fileId, String container, String key, String sha256, long size, String etag) throws Exception;
    void fail(Job job, String errorCode, String detail) throws Exception;
  }

  @FunctionalInterface
  public interface Renderer {
    void render(String snapshotJson, Path output, String exportJobId, String signingKeyId,
        byte[] signingSecret) throws Exception;
  }

  public record Job(UUID id, UUID documentId, UUID documentVersionId, UUID requestedByUserId,
      String snapshotJson, String snapshotSha256, String signingKeyId) {}
}

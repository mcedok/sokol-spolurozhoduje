package cz.sokol.conversion.pdf;

import cz.sokol.conversion.BlobStore;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;

public final class PdfExportProcessor {
  private final Repository repository;
  private final BlobStore blobs;
  private final Renderer renderer;
  private final Validator validator;

  public PdfExportProcessor(
      Repository repository, BlobStore blobs, Renderer renderer, Validator validator) {
    this.repository = repository;
    this.blobs = blobs;
    this.renderer = renderer;
    this.validator = validator;
  }

  public boolean processNext(Path workRoot) throws Exception {
    Optional<Job> claimed = repository.claimNext();
    if (claimed.isEmpty()) return false;
    Job job = claimed.orElseThrow();
    Path root = workRoot.toAbsolutePath().normalize();
    Files.createDirectories(root);
    Path directory = Files.createTempDirectory(root, "pdf-export-" + job.id() + "-");
    try {
      if (!job.snapshotSha256().equals(PdfExportSnapshot.checksumOfJson(job.snapshotJson()))) {
        repository.fail(job, "SNAPSHOT_INTEGRITY", "Checksum snapshotu neodpovídá obsahu.");
        return true;
      }
      PdfExportSnapshot snapshot = PdfExportSnapshot.fromJson(job.snapshotJson());
      Path output = directory.resolve("export.pdf");
      renderer.render(snapshot, output);
      PdfAValidator.Validation validation = validator.validate(output);
      if (!validation.valid()) {
        repository.fail(job, "PDFA_VALIDATION_FAILED", limited(validation.report()));
        return true;
      }
      String sha256 = digest(output);
      String key = job.documentId() + "/" + job.documentVersionId() + "/exports/"
          + job.id() + "/" + sha256 + ".pdf";
      BlobStore.StoredBlob stored = blobs.putIfAbsent(
          "derivatives", key, output, sha256, "application/pdf");
      if (!sha256.equals(stored.sha256())) {
        repository.fail(job, "OUTPUT_INTEGRITY", "Hash uloženého PDF neodpovídá derivátu.");
        return true;
      }
      repository.complete(
          job, UUID.randomUUID(), "derivatives", key, sha256, Files.size(output),
          stored.etag(), limited(validation.report()));
      return true;
    } catch (Exception error) {
      repository.fail(job, "EXPORT_PROCESSING_FAILED", limited(error.getMessage()));
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
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream input = Files.newInputStream(path)) {
      byte[] buffer = new byte[64 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) if (count > 0) digest.update(buffer, 0, count);
    }
    return HexFormat.of().formatHex(digest.digest());
  }

  private static String limited(String value) {
    String text = value == null ? "" : value;
    return text.length() <= 8_000 ? text : text.substring(0, 8_000);
  }

  public interface Repository {
    Optional<Job> claimNext() throws Exception;
    void complete(
        Job job, UUID fileId, String container, String key, String sha256,
        long size, String etag, String validationReport) throws Exception;
    void fail(Job job, String errorCode, String detail) throws Exception;
  }

  @FunctionalInterface public interface Renderer {
    void render(PdfExportSnapshot snapshot, Path output) throws Exception;
  }

  @FunctionalInterface public interface Validator {
    PdfAValidator.Validation validate(Path candidate) throws Exception;
  }

  public record Job(
      UUID id,
      UUID documentId,
      UUID documentVersionId,
      UUID requestedByUserId,
      String snapshotJson,
      String snapshotSha256) {}
}
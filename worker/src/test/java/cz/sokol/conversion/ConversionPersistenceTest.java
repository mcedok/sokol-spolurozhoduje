package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import cz.sokol.conversion.model.ConversionResult;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ConversionPersistenceTest {
  @TempDir Path temporaryDirectory;

  @Test
  void oneLeasedCleanJobCompletesTheWholeConversionBeforeReleasingItsLease() throws Exception {
    Path fixture = Path.of(System.getenv().getOrDefault(
        "SOKOL_FIXTURE_ROOT", "../test/fixtures/docx")).resolve("complex-tables.docx");
    byte[] docx = Files.readAllBytes(fixture);
    String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(docx));
    var job = new ConversionProcessor.Job(
        UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
        "quarantine", "source.docx", sha, "source-etag", UUID.randomUUID(),
        UUID.randomUUID(), "docx-web-v1", Instant.parse("2026-08-17T08:00:00Z"), "worker-1");
    var operations = new ArrayList<String>();
    var repository = new RecordingRepository(job, operations);
    var blobs = new MemoryBlobStore(docx, operations);
    var renderer = new LibreOfficeRenderer(command -> {
      Files.write(command.workingDirectory().resolve("source.pdf"), "%PDF-reference".getBytes());
      return new LibreOfficeRenderer.ProcessResult(0, false, "converted");
    });

    ConversionProcessor.TableArtifactGenerator artifacts = (source, blocks, directory) -> {
      Files.createDirectories(directory);
      Path image = Files.write(directory.resolve("table-1.png"), new byte[] {1, 2, 3});
      return new ConversionProcessor.GeneratedTableArtifacts(
          List.of(new ConversionProcessor.GeneratedTableImage(
              1, image, sha(image), 120, 80)), java.util.Set.of(1));
    };

    new ConversionProcessor(repository, blobs, content -> ClamAvClient.AvStatus.CLEAN)
        .processLeasedJob(job.id(), temporaryDirectory.resolve("jobs"), renderer, artifacts);

    assertEquals(List.of(
        "scanning", "copy", "delete", "archived", "rendering", "put", "put", "completed"),
        operations);
    assertNotNull(repository.completed);
    assertEquals(3, repository.completed.result().blocks().size());
    assertEquals(1, repository.completed.result().findings().stream()
        .filter(finding -> finding.code().equals("ALT_TEXT_REQUIRED")).count());
    assertEquals(1, repository.completed.result().findings().stream()
        .filter(finding -> finding.code().equals("TABLE_RENDER_MISMATCH")).count());
    assertEquals("attachment_only", repository.completed.tableReview().tables().get(2)
        .recommendation().code());
    assertEquals(1, repository.completed.tableImages().size());
    assertEquals(1, repository.completed.tableImages().get(0).tableIndex());
    assertEquals("image/png", repository.completed.tableImages().get(0).derivative().contentType());
    assertFalse(repository.completed.result().sourceSha256().isBlank());
  }

  private static String sha(Path path) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest(Files.readAllBytes(path)));
  }

  private static final class RecordingRepository implements ConversionProcessor.Repository {
    private final ConversionProcessor.Job job;
    private final List<String> operations;
    private ConversionProcessor.CompletedConversion completed;

    RecordingRepository(ConversionProcessor.Job job, List<String> operations) {
      this.job = job;
      this.operations = operations;
    }

    @Override public ConversionProcessor.Job load(UUID id) { return job; }
    @Override public void markScanning(ConversionProcessor.Job ignored) { operations.add("scanning"); }
    @Override public void markRejected(ConversionProcessor.Job ignored, String code) {
      throw new AssertionError(code);
    }
    @Override public void markArchived(
        ConversionProcessor.Job ignored, String container, String key, String etag) {
      operations.add("archived");
    }
    @Override public void markRendering(ConversionProcessor.Job ignored) { operations.add("rendering"); }
    @Override public void completeConversion(
        ConversionProcessor.Job ignored, ConversionProcessor.CompletedConversion conversion) {
      operations.add("completed");
      completed = conversion;
    }
  }

  private static final class MemoryBlobStore implements BlobStore {
    private final byte[] docx;
    private final List<String> operations;

    MemoryBlobStore(byte[] docx, List<String> operations) {
      this.docx = docx;
      this.operations = operations;
    }

    @Override public Optional<StoredBlob> probe(String container, String key) {
      return Optional.empty();
    }
    @Override public InputStream open(String container, String key) {
      return new ByteArrayInputStream(docx);
    }
    @Override public StoredBlob copyIfAbsent(
        String sourceContainer, String sourceKey, String targetContainer,
        String targetKey, String expectedSha256) {
      operations.add("copy");
      return new StoredBlob("archive-etag", expectedSha256);
    }
    @Override public boolean deleteIfMatch(String container, String key, String etag) {
      operations.add("delete");
      return true;
    }
    @Override public StoredBlob putIfAbsent(
        String container, String key, Path source, String expectedSha256, String contentType) {
      operations.add("put");
      return new StoredBlob("derivative-etag", expectedSha256);
    }
  }
}

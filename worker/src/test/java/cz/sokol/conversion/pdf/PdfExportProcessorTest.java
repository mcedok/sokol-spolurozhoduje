package cz.sokol.conversion.pdf;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import cz.sokol.conversion.BlobStore;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PdfExportProcessorTest {
  @TempDir Path temporaryDirectory;

  @Test
  void completesOnlyAValidatedContentAddressedPdf() throws Exception {
    String snapshot = snapshot();
    var events = new ArrayList<String>();
    var repository = new FakeRepository(job(snapshot), events);
    var blobs = new FakeBlobStore(events);
    PdfExportProcessor processor = new PdfExportProcessor(
        repository,
        blobs,
        (model, output) -> { events.add("render"); Files.writeString(output, "%PDF-valid"); },
        candidate -> { events.add("validate"); return new PdfAValidator.Validation(true, "PASS PDF/A-2u", 0); });

    assertTrue(processor.processNext(temporaryDirectory));

    assertEquals(List.of("claim", "render", "validate", "put", "complete"), events);
    assertTrue(repository.completed);
    assertFalse(repository.failed);
    assertEquals("application/pdf", blobs.contentType);
    assertTrue(blobs.objectKey.startsWith(repository.job.documentId() + "/"));
  }

  @Test
  void failedPdfaValidationNeverPublishesOrCompletesTheArtifact() throws Exception {
    String snapshot = snapshot();
    var events = new ArrayList<String>();
    var repository = new FakeRepository(job(snapshot), events);
    var blobs = new FakeBlobStore(events);
    PdfExportProcessor processor = new PdfExportProcessor(
        repository,
        blobs,
        (model, output) -> { events.add("render"); Files.writeString(output, "%PDF-invalid"); },
        candidate -> { events.add("validate"); return new PdfAValidator.Validation(false, "FAIL PDF/A-2u", 1); });

    assertTrue(processor.processNext(temporaryDirectory));

    assertEquals(List.of("claim", "render", "validate", "fail"), events);
    assertFalse(repository.completed);
    assertTrue(repository.failed);
  }

  private static PdfExportProcessor.Job job(String snapshot) {
    return new PdfExportProcessor.Job(
        UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
        snapshot, PdfExportSnapshot.checksumOfJson(snapshot));
  }

  private static String snapshot() {
    return """
        {"schemaVersion":"pdf-export-v1","visibility":"public",
         "generatedAt":"2026-08-18T12:00:00.000Z",
         "document":{"number":"SOKOL-2026-100","title":"Jednací řád",
           "explanatoryReport":"Důvodová zpráva.","versionNumber":2},
         "filters":{"statuses":[],"priorities":[],"types":[]},
         "options":{"includeAuthorEmail":false,"includeMembershipId":false,"includeInternalNote":false},
         "statistics":{"total":0,"settled":0,"open":0},"comments":[]}
        """;
  }

  private static final class FakeRepository implements PdfExportProcessor.Repository {
    private final PdfExportProcessor.Job job;
    private final List<String> events;
    private boolean available = true;
    private boolean completed;
    private boolean failed;

    private FakeRepository(PdfExportProcessor.Job job, List<String> events) {
      this.job = job;
      this.events = events;
    }

    @Override public Optional<PdfExportProcessor.Job> claimNext() {
      events.add("claim");
      if (!available) return Optional.empty();
      available = false;
      return Optional.of(job);
    }

    @Override public void complete(
        PdfExportProcessor.Job ignored, UUID fileId, String container, String key,
        String sha256, long size, String etag, String report) {
      events.add("complete");
      completed = true;
    }

    @Override public void fail(PdfExportProcessor.Job ignored, String code, String detail) {
      events.add("fail");
      failed = true;
    }
  }

  private static final class FakeBlobStore implements BlobStore {
    private final List<String> events;
    private String objectKey;
    private String contentType;

    private FakeBlobStore(List<String> events) { this.events = events; }
    @Override public Optional<StoredBlob> probe(String container, String key) { return Optional.empty(); }
    @Override public InputStream open(String container, String key) {
      return new ByteArrayInputStream(new byte[0]);
    }
    @Override public StoredBlob copyIfAbsent(
        String sourceContainer, String sourceKey, String targetContainer, String targetKey,
        String expectedSha256) { throw new UnsupportedOperationException(); }
    @Override public StoredBlob putIfAbsent(
        String container, String key, Path source, String expectedSha256, String type) {
      events.add("put"); objectKey = key; contentType = type;
      return new StoredBlob("etag-export", expectedSha256);
    }
    @Override public boolean deleteIfMatch(String container, String key, String etag) { return false; }
  }
}
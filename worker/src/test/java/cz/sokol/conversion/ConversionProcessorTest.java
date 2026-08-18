package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ConversionProcessorTest {
  @TempDir Path temporaryDirectory;

  @Test
  void archivesOnlyACleanObjectWithTheExpectedDigest() throws Exception {
    var operations = new ArrayList<String>();
    var job = job();
    var repository = new FakeRepository(job, operations);
    var blobs = new FakeBlobStore(operations, job.sha256());
    VirusScanner scanner = content -> {
      operations.add("scan");
      return ClamAvClient.AvStatus.CLEAN;
    };

    new ConversionProcessor(repository, blobs, scanner).scanAndArchive(job.id());

    assertEquals(List.of(
        "probe-originals", "scanning", "open", "scan", "copy", "delete", "archived"),
        operations);
    assertEquals("originals", repository.archivedContainer);
    assertEquals(job.documentId() + "/" + job.versionId() + "/" + job.sha256() + ".docx",
        repository.archivedKey);
  }

  @Test
  void rejectsAnInfectedObjectWithoutCopyingOrParsingIt() throws Exception {
    var operations = new ArrayList<String>();
    var job = job();
    var repository = new FakeRepository(job, operations);
    var blobs = new FakeBlobStore(operations, job.sha256());
    VirusScanner scanner = content -> {
      operations.add("scan");
      return ClamAvClient.AvStatus.INFECTED;
    };

    new ConversionProcessor(repository, blobs, scanner).scanAndArchive(job.id());

    assertEquals(List.of("probe-originals", "scanning", "open", "scan", "rejected"), operations);
    assertEquals(1, repository.securityEvents);
  }

  @Test
  void resumesAfterACleanCopyWhenTheQuarantineObjectIsAlreadyGone() throws Exception {
    var operations = new ArrayList<String>();
    var job = job();
    var repository = new FakeRepository(job, operations);
    var blobs = new FakeBlobStore(operations, job.sha256());
    blobs.targetAlreadyArchived = true;
    blobs.sourceAvailable = false;
    VirusScanner scanner = content -> {
      operations.add("scan");
      return ClamAvClient.AvStatus.CLEAN;
    };

    new ConversionProcessor(repository, blobs, scanner).scanAndArchive(job.id());

    assertEquals(List.of("probe-originals", "probe-quarantine", "archived"), operations);
  }

  @Test
  void retryNeverDeletesAnAlreadyArchivedOriginal() throws Exception {
    var operations = new ArrayList<String>();
    var initial = job();
    String archivedKey = initial.documentId() + "/" + initial.versionId() + "/"
        + initial.sha256() + ".docx";
    var archivedJob = new ConversionProcessor.Job(
        initial.id(), initial.documentId(), initial.versionId(), initial.fileId(),
        "originals", archivedKey, initial.sha256(), "etag-output", initial.correlationId(),
        initial.ownerUserId(), initial.profileVersion(), initial.versionCreatedAt(),
        initial.leaseOwner());
    var repository = new FakeRepository(archivedJob, operations);
    var blobs = new FakeBlobStore(operations, archivedJob.sha256());
    blobs.targetAlreadyArchived = true;

    new ConversionProcessor(repository, blobs, content -> {
      throw new AssertionError("Archivovaný originál se při retry znovu neskenuje.");
    }).scanAndArchive(archivedJob.id());

    assertEquals(List.of("probe-originals", "archived"), operations);
  }

  @Test
  void rendersAndStoresAContentAddressedReferencePdf() throws Exception {
    var operations = new ArrayList<String>();
    var job = job();
    var repository = new FakeRepository(job, operations);
    var blobs = new FakeBlobStore(operations, job.sha256());
    Path docx = Files.write(temporaryDirectory.resolve("source.docx"), new byte[] {1});
    Path jobDirectory = Files.createDirectory(temporaryDirectory.resolve("render-job"));
    var renderer = new LibreOfficeRenderer(command -> {
      Files.write(jobDirectory.resolve("source.pdf"), "%PDF-reference".getBytes());
      return new LibreOfficeRenderer.ProcessResult(0, false, "converted");
    });

    var derivative = new ConversionProcessor(repository, blobs, content ->
        ClamAvClient.AvStatus.CLEAN).renderAndStoreReference(
            job.id(), docx, jobDirectory, renderer);

    assertEquals(List.of("rendering", "put-derivatives"), operations);
    assertEquals("derivatives", derivative.container());
    assertEquals(job.documentId() + "/" + job.versionId() + "/reference/"
        + derivative.sha256() + ".pdf", derivative.objectKey());
    assertEquals("application/pdf", blobs.uploadedContentType);
  }

  @Test
  void turnsTableRecommendationsIntoBlockingReviewFindings() throws Exception {
    Path fixtures = Path.of(System.getenv().getOrDefault(
        "SOKOL_FIXTURE_ROOT", "../test/fixtures/docx"));
    var processor = new ConversionProcessor(
        new FakeRepository(job(), new ArrayList<>()),
        new FakeBlobStore(new ArrayList<>(), "a".repeat(64)),
        content -> ClamAvClient.AvStatus.CLEAN);

    var review = processor.recommendTables(
        fixtures.resolve("complex-tables.docx"), Set.of(0), new TableComplexityAnalyzer());

    assertEquals(3, review.tables().size());
    assertEquals(2, review.findings().stream()
        .filter(finding -> finding.code().equals("ALT_TEXT_REQUIRED")).count());
    assertEquals(1, review.findings().stream()
        .filter(finding -> finding.code().equals("TABLE_RENDER_MISMATCH")).count());
    assertEquals("blocking", review.findings().get(0).severity());
  }

  @Test
  void tableFindingsPointToTheActualBlockInsteadOfTheTableOrdinal() throws Exception {
    Path fixtures = Path.of(System.getenv().getOrDefault(
        "SOKOL_FIXTURE_ROOT", "../test/fixtures/docx"));
    Path docx = fixtures.resolve("supported-elements.docx");
    var parsed = new DocxParser(java.time.Instant.parse("2026-08-17T08:00:00Z"))
        .parse(docx, "1".repeat(64), "docx-web-v1");
    var processor = new ConversionProcessor(
        new FakeRepository(job(), new ArrayList<>()),
        new FakeBlobStore(new ArrayList<>(), "a".repeat(64)),
        content -> ClamAvClient.AvStatus.CLEAN);

    var review = processor.recommendTables(
        docx, Set.of(0), new TableComplexityAnalyzer(), parsed.blocks());

    assertEquals(2, review.findings().size());
    assertEquals(4, review.findings().get(0).sourceLocation().get("blockIndex"));
    assertEquals(4, review.findings().get(1).sourceLocation().get("blockIndex"));
  }

  private static ConversionProcessor.Job job() {
    return new ConversionProcessor.Job(
        UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
        "quarantine", "input.docx", "a".repeat(64), "etag-input", UUID.randomUUID(),
        UUID.randomUUID(), "docx-web-v1", java.time.Instant.parse("2026-08-17T08:00:00Z"),
        "worker-test");
  }

  private static final class FakeRepository implements ConversionProcessor.Repository {
    private final ConversionProcessor.Job job;
    private final List<String> operations;
    private String archivedContainer;
    private String archivedKey;
    private int securityEvents;

    private FakeRepository(ConversionProcessor.Job job, List<String> operations) {
      this.job = job;
      this.operations = operations;
    }

    @Override public ConversionProcessor.Job load(UUID jobId) { return job; }
    @Override public void markScanning(ConversionProcessor.Job ignored) { operations.add("scanning"); }
    @Override public void markRejected(ConversionProcessor.Job ignored, String code) {
      operations.add("rejected");
      securityEvents += 1;
    }
    @Override public void markArchived(
        ConversionProcessor.Job ignored, String container, String key, String etag) {
      operations.add("archived");
      archivedContainer = container;
      archivedKey = key;
    }
    @Override public void markRendering(ConversionProcessor.Job ignored) {
      operations.add("rendering");
    }
    @Override public void completeConversion(
        ConversionProcessor.Job ignored, ConversionProcessor.CompletedConversion conversion) {
      operations.add("completed");
    }
  }

  private static final class FakeBlobStore implements BlobStore {
    private final List<String> operations;
    private final String sha256;
    private boolean targetAlreadyArchived;
    private boolean sourceAvailable = true;
    private String uploadedContentType;

    private FakeBlobStore(List<String> operations, String sha256) {
      this.operations = operations;
      this.sha256 = sha256;
    }

    @Override public java.util.Optional<StoredBlob> probe(String container, String objectKey) {
      operations.add("probe-" + container);
      if ("originals".equals(container) && targetAlreadyArchived) {
        return java.util.Optional.of(new StoredBlob("etag-output", sha256));
      }
      if ("quarantine".equals(container) && sourceAvailable) {
        return java.util.Optional.of(new StoredBlob("etag-input", sha256));
      }
      return java.util.Optional.empty();
    }

    @Override public InputStream open(String container, String objectKey) {
      operations.add("open");
      return new ByteArrayInputStream(new byte[] {1, 2, 3});
    }
    @Override public StoredBlob copyIfAbsent(
        String sourceContainer, String sourceKey, String targetContainer,
        String targetKey, String expectedSha256) {
      operations.add("copy");
      return new StoredBlob("etag-output", sha256);
    }
    @Override public boolean deleteIfMatch(String container, String objectKey, String etag) {
      operations.add("delete");
      return true;
    }
    @Override public StoredBlob putIfAbsent(
        String container, String objectKey, Path source, String expectedSha256, String contentType) {
      operations.add("put-" + container);
      uploadedContentType = contentType;
      return new StoredBlob("etag-derivative", expectedSha256);
    }
  }
}

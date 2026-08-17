package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ConversionProcessorTest {
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

  private static ConversionProcessor.Job job() {
    return new ConversionProcessor.Job(
        UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
        "quarantine", "input.docx", "a".repeat(64), "etag-input", UUID.randomUUID());
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
  }

  private static final class FakeBlobStore implements BlobStore {
    private final List<String> operations;
    private final String sha256;
    private boolean targetAlreadyArchived;
    private boolean sourceAvailable = true;

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
  }
}

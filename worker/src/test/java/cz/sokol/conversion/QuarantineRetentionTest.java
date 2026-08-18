package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class QuarantineRetentionTest {
  @Test
  void purgesOnlyExpiredRejectedObjectsWithoutALegalHold() throws Exception {
    Instant now = Instant.parse("2026-08-17T08:00:00Z");
    var eligible = candidate("rejected", false, now.minusSeconds(8 * 86_400));
    var recent = candidate("rejected", false, now.minusSeconds(6 * 86_400));
    var archived = candidate("archived", false, now.minusSeconds(30 * 86_400));
    var held = candidate("rejected", true, now.minusSeconds(30 * 86_400));
    var repository = new FakeRetentionRepository(List.of(eligible, recent, archived, held));
    var blobStore = new FakeBlobStore();
    var retention = new QuarantineRetention(
        repository, blobStore, Clock.fixed(now, ZoneOffset.UTC));

    assertEquals(1, retention.purge());
    assertEquals(List.of(eligible.objectKey()), blobStore.deletedKeys);
    assertEquals(List.of(eligible.id()), repository.deletedIds);
  }

  @Test
  void completesDatabaseRetentionAfterAPriorDeleteAlreadyRemovedTheBlob() throws Exception {
    Instant now = Instant.parse("2026-08-17T08:00:00Z");
    var eligible = candidate("rejected", false, now.minusSeconds(8 * 86_400));
    var repository = new FakeRetentionRepository(List.of(eligible));
    var blobStore = new FakeBlobStore();
    blobStore.exists = false;

    assertEquals(1, new QuarantineRetention(
        repository, blobStore, Clock.fixed(now, ZoneOffset.UTC)).purge());
    assertEquals(List.of(), blobStore.deletedKeys);
    assertEquals(List.of(eligible.id()), repository.deletedIds);
  }

  private static QuarantineRetention.Candidate candidate(
      String status, boolean legalHold, Instant createdAt) {
    UUID id = UUID.randomUUID();
    return new QuarantineRetention.Candidate(
        id, "quarantine", id + ".docx", "etag-" + id, status, legalHold, createdAt);
  }

  private static final class FakeRetentionRepository implements QuarantineRetention.Repository {
    private final List<QuarantineRetention.Candidate> candidates;
    private final List<UUID> deletedIds = new ArrayList<>();

    private FakeRetentionRepository(List<QuarantineRetention.Candidate> candidates) {
      this.candidates = candidates;
    }

    @Override
    public List<QuarantineRetention.Candidate> candidates() {
      return candidates;
    }

    @Override
    public void markDeleted(UUID id, Instant deletedAt) {
      deletedIds.add(id);
    }
  }

  private static final class FakeBlobStore implements BlobStore {
    private final List<String> deletedKeys = new ArrayList<>();
    private boolean exists = true;

    @Override
    public java.util.Optional<StoredBlob> probe(String container, String objectKey) {
      return exists
          ? java.util.Optional.of(new StoredBlob(
              "etag-" + objectKey.replace(".docx", ""), "a".repeat(64)))
          : java.util.Optional.empty();
    }

    @Override
    public java.io.InputStream open(String container, String objectKey) {
      throw new UnsupportedOperationException();
    }

    @Override
    public StoredBlob copyIfAbsent(
        String sourceContainer, String sourceKey, String targetContainer,
        String targetKey, String expectedSha256) {
      throw new UnsupportedOperationException();
    }

    @Override
    public boolean deleteIfMatch(String container, String objectKey, String etag) {
      if (!exists) return false;
      deletedKeys.add(objectKey);
      exists = false;
      return true;
    }

    @Override
    public StoredBlob putIfAbsent(
        String container, String objectKey, java.nio.file.Path source,
        String expectedSha256, String contentType) {
      throw new UnsupportedOperationException();
    }
  }
}

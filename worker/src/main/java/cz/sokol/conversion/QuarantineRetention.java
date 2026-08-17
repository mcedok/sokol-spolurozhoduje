package cz.sokol.conversion;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class QuarantineRetention {
  private static final Duration RETENTION = Duration.ofDays(7);

  private final Repository repository;
  private final BlobStore blobStore;
  private final Clock clock;

  public QuarantineRetention(Repository repository, BlobStore blobStore, Clock clock) {
    this.repository = repository;
    this.blobStore = blobStore;
    this.clock = clock;
  }

  public int purge() throws Exception {
    Instant now = clock.instant();
    Instant cutoff = now.minus(RETENTION);
    int purged = 0;
    for (Candidate candidate : repository.candidates()) {
      if (!"rejected".equals(candidate.objectStatus())
          || candidate.legalHold()
          || !candidate.createdAt().isBefore(cutoff)) {
        continue;
      }
      var stored = blobStore.probe(candidate.container(), candidate.objectKey());
      if (stored.isPresent() && !candidate.etag().equals(stored.orElseThrow().etag())) {
        continue;
      }
      if (stored.isEmpty() || blobStore.deleteIfMatch(
          candidate.container(), candidate.objectKey(), candidate.etag())) {
        repository.markDeleted(candidate.id(), now);
        purged += 1;
      }
    }
    return purged;
  }

  public interface Repository {
    List<Candidate> candidates() throws Exception;
    void markDeleted(UUID id, Instant deletedAt) throws Exception;
  }

  public record Candidate(
      UUID id,
      String container,
      String objectKey,
      String etag,
      String objectStatus,
      boolean legalHold,
      Instant createdAt) {}
}

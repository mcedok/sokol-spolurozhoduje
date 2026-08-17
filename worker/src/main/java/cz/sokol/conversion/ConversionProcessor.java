package cz.sokol.conversion;

import java.io.InputStream;
import java.util.Optional;
import java.util.UUID;

public final class ConversionProcessor {
  private final Repository repository;
  private final BlobStore blobStore;
  private final VirusScanner scanner;

  public ConversionProcessor(Repository repository, BlobStore blobStore, VirusScanner scanner) {
    this.repository = repository;
    this.blobStore = blobStore;
    this.scanner = scanner;
  }

  public void scanAndArchive(UUID jobId) throws Exception {
    Job job = repository.load(jobId);
    String targetContainer = "originals";
    String targetKey = job.documentId() + "/" + job.versionId() + "/" + job.sha256() + ".docx";
    Optional<BlobStore.StoredBlob> existing = blobStore.probe(targetContainer, targetKey);
    if (existing.isPresent()) {
      if (!job.sha256().equals(existing.orElseThrow().sha256())) throw new IntegrityException();
      Optional<BlobStore.StoredBlob> quarantine = blobStore.probe(
          job.sourceContainer(), job.sourceKey());
      if (quarantine.isPresent()) {
        if (!job.sourceEtag().equals(quarantine.orElseThrow().etag())
            || !blobStore.deleteIfMatch(
                job.sourceContainer(), job.sourceKey(), job.sourceEtag())) {
          throw new IntegrityException();
        }
      }
      repository.markArchived(
          job, targetContainer, targetKey, existing.orElseThrow().etag());
      return;
    }
    repository.markScanning(job);
    ClamAvClient.AvStatus status;
    try (InputStream content = blobStore.open(job.sourceContainer(), job.sourceKey())) {
      status = scanner.scan(content);
    }
    if (status == ClamAvClient.AvStatus.INFECTED) {
      repository.markRejected(job, "MALWARE_DETECTED");
      return;
    }
    BlobStore.StoredBlob archived = blobStore.copyIfAbsent(
        job.sourceContainer(), job.sourceKey(), targetContainer, targetKey, job.sha256());
    if (!job.sha256().equals(archived.sha256())) {
      throw new IntegrityException();
    }
    if (!blobStore.deleteIfMatch(job.sourceContainer(), job.sourceKey(), job.sourceEtag())) {
      throw new IntegrityException();
    }
    repository.markArchived(job, targetContainer, targetKey, archived.etag());
  }

  public interface Repository {
    Job load(UUID jobId) throws Exception;
    void markScanning(Job job) throws Exception;
    void markRejected(Job job, String code) throws Exception;
    void markArchived(Job job, String container, String objectKey, String etag) throws Exception;
  }

  public record Job(
      UUID id,
      UUID documentId,
      UUID versionId,
      UUID fileId,
      String sourceContainer,
      String sourceKey,
      String sha256,
      String sourceEtag,
      UUID correlationId) {}

  public static final class IntegrityException extends Exception {
    public IntegrityException() {
      super("Kontrola neměnnosti originálu selhala.");
    }
  }
}

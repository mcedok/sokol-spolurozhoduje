package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import cz.sokol.conversion.BlobStore;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class XlsxExportProcessorKeyRotationTest {
  @Test
  void signsAQueuedExportWithTheSecretMatchingItsPersistedKeyId() throws Exception {
    byte[] oldSecret = "old-secret".getBytes();
    var job = new XlsxExportProcessor.Job(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
        UUID.randomUUID(), "{}", XlsxCanonicalJson.sha256("{}"), "old-key");
    byte[][] observed = {null};
    var processor = new XlsxExportProcessor(new OneJobRepository(job), new NoopBlobStore(),
        (snapshot, output, exportId, keyId, secret) -> {
          observed[0] = secret.clone();
          java.nio.file.Files.write(output, new byte[]{1});
        }, Map.of("current-key", "new-secret".getBytes(), "old-key", oldSecret));

    assertTrue(processor.processNext(java.nio.file.Files.createTempDirectory("xlsx-export-key-")));
    assertArrayEquals(oldSecret, observed[0]);
  }

  private static final class OneJobRepository implements XlsxExportProcessor.Repository {
    private final XlsxExportProcessor.Job job;
    OneJobRepository(XlsxExportProcessor.Job job) { this.job = job; }
    public Optional<XlsxExportProcessor.Job> claimNext() { return Optional.of(job); }
    public void complete(XlsxExportProcessor.Job ignored, UUID id, String c, String k,
        String hash, long size, String etag) {}
    public void fail(XlsxExportProcessor.Job ignored, String code, String detail) {}
  }

  private static final class NoopBlobStore implements BlobStore {
    public Optional<StoredBlob> probe(String c, String k) { return Optional.empty(); }
    public InputStream open(String c, String k) { throw new UnsupportedOperationException(); }
    public StoredBlob copyIfAbsent(String sc, String sk, String tc, String tk, String hash) {
      throw new UnsupportedOperationException();
    }
    public StoredBlob putIfAbsent(String c, String k, Path path, String hash, String type) {
      return new StoredBlob("etag", hash);
    }
    public boolean deleteIfMatch(String c, String k, String e) { return true; }
  }
}

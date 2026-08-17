package cz.sokol.conversion;

import java.io.InputStream;
import java.util.Optional;

public interface BlobStore {
  Optional<StoredBlob> probe(String container, String objectKey) throws Exception;

  InputStream open(String container, String objectKey) throws Exception;

  StoredBlob copyIfAbsent(
      String sourceContainer,
      String sourceKey,
      String targetContainer,
      String targetKey,
      String expectedSha256) throws Exception;

  boolean deleteIfMatch(String container, String objectKey, String etag) throws Exception;

  record StoredBlob(String etag, String sha256) {}
}

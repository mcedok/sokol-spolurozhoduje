package cz.sokol.conversion;

import com.azure.core.http.rest.Response;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;
import com.azure.storage.blob.models.BlobRequestConditions;
import com.azure.storage.blob.models.BlobStorageException;
import com.azure.storage.blob.models.DeleteSnapshotsOptionType;
import com.azure.storage.blob.options.BlobBeginCopyOptions;
import com.azure.storage.blob.sas.BlobSasPermission;
import com.azure.storage.blob.sas.BlobServiceSasSignatureValues;
import java.io.InputStream;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;

public final class AzureBlobStore implements BlobStore {
  private final BlobServiceClient service;

  public AzureBlobStore(String connectionString) {
    service = new BlobServiceClientBuilder().connectionString(connectionString).buildClient();
  }

  @Override
  public Optional<StoredBlob> probe(String container, String objectKey) throws Exception {
    BlobClient blob = client(container, objectKey);
    if (!blob.exists()) return Optional.empty();
    String sha256;
    try (InputStream content = blob.openInputStream()) {
      sha256 = digest(content);
    }
    return Optional.of(new StoredBlob(blob.getProperties().getETag(), sha256));
  }

  @Override
  public InputStream open(String container, String objectKey) {
    return client(container, objectKey).openInputStream();
  }

  @Override
  public StoredBlob copyIfAbsent(
      String sourceContainer,
      String sourceKey,
      String targetContainer,
      String targetKey,
      String expectedSha256) throws Exception {
    BlobClient source = client(sourceContainer, sourceKey);
    BlobClient target = client(targetContainer, targetKey);
    if (!target.exists()) {
      BlobSasPermission permission = new BlobSasPermission().setReadPermission(true);
      String sas = source.generateSas(new BlobServiceSasSignatureValues(
          OffsetDateTime.now().plusMinutes(5), permission));
      BlobBeginCopyOptions options = new BlobBeginCopyOptions(source.getBlobUrl() + "?" + sas)
          .setMetadata(Map.of("sha256", expectedSha256))
          .setDestinationRequestConditions(new BlobRequestConditions().setIfNoneMatch("*"))
          .setPollInterval(Duration.ofMillis(250));
      try {
        target.beginCopy(options).waitForCompletion();
      } catch (BlobStorageException error) {
        if (error.getStatusCode() != 409 && error.getStatusCode() != 412) throw error;
      }
    }
    String actualSha256;
    try (InputStream archived = target.openInputStream()) {
      actualSha256 = digest(archived);
    }
    return new StoredBlob(target.getProperties().getETag(), actualSha256);
  }

  @Override
  public boolean deleteIfMatch(String container, String objectKey, String etag) {
    try {
      Response<Void> ignored = client(container, objectKey).deleteWithResponse(
          DeleteSnapshotsOptionType.INCLUDE,
          new BlobRequestConditions().setIfMatch(etag),
          Duration.ofSeconds(30),
          com.azure.core.util.Context.NONE);
      return ignored.getStatusCode() >= 200 && ignored.getStatusCode() < 300;
    } catch (BlobStorageException error) {
      if (error.getStatusCode() == 404 || error.getStatusCode() == 412) return false;
      throw error;
    }
  }

  private BlobClient client(String container, String key) {
    return service.getBlobContainerClient(container).getBlobClient(key);
  }

  private static String digest(InputStream input) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    byte[] buffer = new byte[64 * 1024];
    int count;
    while ((count = input.read(buffer)) != -1) {
      if (count > 0) digest.update(buffer, 0, count);
    }
    return HexFormat.of().formatHex(digest.digest());
  }
}

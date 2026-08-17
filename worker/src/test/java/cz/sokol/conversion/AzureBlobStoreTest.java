package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.azure.storage.blob.BlobServiceClientBuilder;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class AzureBlobStoreTest {
  private static final String CONNECTION = System.getenv().getOrDefault(
      "TEST_STORAGE_CONNECTION_STRING",
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
          + "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/"
          + "K1SZFPTOtr/KBHBeksoGMGw==;"
          + "BlobEndpoint=http://host.docker.internal:10000/devstoreaccount1;");

  @Test
  void copiesAPrivateBlobOnceAndVerifiesItsActualDigest() throws Exception {
    var service = new BlobServiceClientBuilder().connectionString(CONNECTION).buildClient();
    service.getBlobContainerClient("quarantine").createIfNotExists();
    service.getBlobContainerClient("originals").createIfNotExists();
    String id = UUID.randomUUID().toString();
    String sourceKey = "worker-test/" + id + ".docx";
    String targetKey = "worker-test/" + id + "/original.docx";
    byte[] content = "private-docx-content".getBytes(StandardCharsets.UTF_8);
    String sha256 = HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(content));
    var source = service.getBlobContainerClient("quarantine").getBlobClient(sourceKey);
    var target = service.getBlobContainerClient("originals").getBlobClient(targetKey);
    source.upload(new ByteArrayInputStream(content), content.length, true);
    String sourceEtag = source.getProperties().getETag();
    AzureBlobStore store = new AzureBlobStore(CONNECTION);
    try {
      BlobStore.StoredBlob first = store.copyIfAbsent(
          "quarantine", sourceKey, "originals", targetKey, sha256);
      BlobStore.StoredBlob replay = store.copyIfAbsent(
          "quarantine", sourceKey, "originals", targetKey, sha256);
      assertEquals(sha256, first.sha256());
      assertEquals(first.etag(), replay.etag());
      assertEquals(true, store.deleteIfMatch("quarantine", sourceKey, sourceEtag));
      assertFalse(source.exists());
    } finally {
      target.deleteIfExists();
      source.deleteIfExists();
    }
  }
}

package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.azure.storage.blob.BlobServiceClientBuilder;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AzureBlobStoreTest {
  @TempDir Path temporaryDirectory;
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

  @Test
  void uploadsAContentAddressedDerivativeOnlyWhenItsDigestMatches() throws Exception {
    var service = new BlobServiceClientBuilder().connectionString(CONNECTION).buildClient();
    service.getBlobContainerClient("derivatives").createIfNotExists();
    byte[] content = "%PDF-private-reference".getBytes(StandardCharsets.UTF_8);
    Path source = Files.write(temporaryDirectory.resolve("reference.pdf"), content);
    String sha256 = HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(content));
    String key = "worker-test/" + UUID.randomUUID() + "/" + sha256 + ".pdf";
    var target = service.getBlobContainerClient("derivatives").getBlobClient(key);
    AzureBlobStore store = new AzureBlobStore(CONNECTION);
    try {
      var first = store.putIfAbsent("derivatives", key, source, sha256, "application/pdf");
      var replay = store.putIfAbsent("derivatives", key, source, sha256, "application/pdf");

      assertEquals(sha256, first.sha256());
      assertEquals(first.etag(), replay.etag());
      assertEquals("application/pdf", target.getProperties().getContentType());
      assertThrows(IllegalArgumentException.class, () -> store.putIfAbsent(
          "derivatives", key + "-bad", source, "0".repeat(64), "application/pdf"));
    } finally {
      target.deleteIfExists();
      service.getBlobContainerClient("derivatives").getBlobClient(key + "-bad").deleteIfExists();
    }
  }
}

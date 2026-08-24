package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import cz.sokol.conversion.BlobStore;
import cz.sokol.conversion.ClamAvClient;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class XlsxImportProcessorTest {
  @Test
  void scansArchivesVerifiesAndStagesAValidWorkbook() throws Exception {
    byte[] secret = "trusted-secret".getBytes();
    String snapshot = """
        {"comments":[],"document":{"id":"018f6f9d-7e10-7000-8000-000000000010","number":"SOKOL-2026-110","title":"Řád","versionId":"018f6f9d-7e10-7000-8000-000000000011","versionNumber":1},"generatedAt":"2026-08-19T12:00:00Z","rowCount":0,"schemaVersion":"xlsx-working-v1"}
        """;
    Path workbook = Files.createTempFile("import-processor-", ".xlsx");
    try {
      UUID exportId = UUID.randomUUID();
      new XlsxWorkbookRenderer().render(snapshot, workbook, exportId.toString(), "key-1", secret);
      byte[] bytes = Files.readAllBytes(workbook);
      String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
      var repository = new RecordingRepository(new XlsxImportProcessor.Job(
          UUID.randomUUID(), UUID.fromString("018f6f9d-7e10-7000-8000-000000000010"), exportId,
          UUID.fromString("018f6f9d-7e10-7000-8000-000000000011"), UUID.randomUUID(),
          "quarantine", "upload.xlsx", "etag-1", hash, snapshot, XlsxCanonicalJson.sha256(snapshot),
          0, "key-1", UUID.randomUUID(), 1_000L));
      BlobStore blobs = new MemoryBlobStore(bytes, hash);
      int[] safeCallbacks = {0};
      XlsxImportProcessor processor = new XlsxImportProcessor(
          repository, blobs, ignored -> ClamAvClient.AvStatus.CLEAN,
          new XlsxImportParser(), XlsxSecurityPolicy.defaults(), "key-1", secret,
          command -> safeCallbacks[0]++);

      assertTrue(processor.processNext(Files.createTempDirectory("xlsx-import-work-")));
      assertEquals(1, repository.completed);
      assertEquals(0, repository.failed);
      assertEquals(1, safeCallbacks[0]);
    } finally {
      Files.deleteIfExists(workbook);
    }
  }

  @Test
  void dispatchesADurableSafeApplyCommandBeforeClaimingAnotherUpload() throws Exception {
    var command = new XlsxImportProcessor.SafeApplyCommand(
        UUID.randomUUID(), 7, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
    var repository = new SafeApplyRepository(command);
    int[] callbacks = {0};
    XlsxImportProcessor processor = new XlsxImportProcessor(
        repository, new MemoryBlobStore(new byte[0], ""), ignored -> ClamAvClient.AvStatus.CLEAN,
        new XlsxImportParser(), XlsxSecurityPolicy.defaults(), "key-1", "secret".getBytes(),
        ignored -> callbacks[0]++);

    assertTrue(processor.processNext(Files.createTempDirectory("xlsx-safe-apply-work-")));
    assertEquals(1, callbacks[0]);
    assertEquals(0, repository.uploadClaims);
  }

  private static final class RecordingRepository implements XlsxImportProcessor.Repository {
    private final XlsxImportProcessor.Job job;
    int completed;
    int failed;
    RecordingRepository(XlsxImportProcessor.Job job) { this.job = job; }
    public Optional<XlsxImportProcessor.SafeApplyCommand> claimSafeApply() { return Optional.empty(); }
    public void releaseSafeApply(XlsxImportProcessor.SafeApplyCommand ignored, String detail) {}
    public void renewLease(XlsxImportProcessor.Job ignored) {}
    public Optional<XlsxImportProcessor.Job> claimNext() { return Optional.of(job); }
    public void markArchived(XlsxImportProcessor.Job ignored, String container, String key, String etag) {}
    public XlsxImportProcessor.SafeApplyCommand complete(
        XlsxImportProcessor.Job ignored, XlsxImportParser.ParsedWorkbook workbook) {
      completed++;
      return new XlsxImportProcessor.SafeApplyCommand(
          job.id(), 3, UUID.randomUUID(), UUID.randomUUID(), null);
    }
    public void fail(XlsxImportProcessor.Job ignored, String code, String detail) { failed++; }
  }

  private static final class SafeApplyRepository implements XlsxImportProcessor.Repository {
    private final XlsxImportProcessor.SafeApplyCommand command;
    int uploadClaims;
    SafeApplyRepository(XlsxImportProcessor.SafeApplyCommand command) { this.command = command; }
    public Optional<XlsxImportProcessor.SafeApplyCommand> claimSafeApply() { return Optional.of(command); }
    public void releaseSafeApply(XlsxImportProcessor.SafeApplyCommand ignored, String detail) {}
    public void renewLease(XlsxImportProcessor.Job ignored) {}
    public Optional<XlsxImportProcessor.Job> claimNext() { uploadClaims++; return Optional.empty(); }
    public void markArchived(XlsxImportProcessor.Job ignored, String c, String k, String e) {}
    public XlsxImportProcessor.SafeApplyCommand complete(
        XlsxImportProcessor.Job ignored, XlsxImportParser.ParsedWorkbook workbook) {
      throw new AssertionError();
    }
    public void fail(XlsxImportProcessor.Job ignored, String code, String detail) {
      throw new AssertionError();
    }
  }

  private static final class MemoryBlobStore implements BlobStore {
    private final byte[] bytes; private final String hash;
    MemoryBlobStore(byte[] bytes, String hash) { this.bytes = bytes; this.hash = hash; }
    public Optional<StoredBlob> probe(String container, String key) { return Optional.empty(); }
    public InputStream open(String container, String key) { return new ByteArrayInputStream(bytes); }
    public StoredBlob copyIfAbsent(String sc, String sk, String tc, String tk, String expected) { return new StoredBlob("etag-2", hash); }
    public StoredBlob putIfAbsent(String c, String k, Path p, String expected, String type) { throw new UnsupportedOperationException(); }
    public boolean deleteIfMatch(String container, String key, String etag) { return true; }
  }
}

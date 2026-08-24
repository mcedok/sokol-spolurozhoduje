package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Map;
import org.junit.jupiter.api.Test;

class WorkerConfigTest {
  @Test
  void requiresProductionConnectionsAndUsesOnlySafeOperationalDefaults() {
    assertThrows(IllegalArgumentException.class, () -> WorkerConfig.fromEnvironment(Map.of()));
    WorkerConfig config = WorkerConfig.fromEnvironment(Map.ofEntries(
        Map.entry("DATABASE_URL", "jdbc:postgresql://postgres:5432/sokol"),
        Map.entry("DATABASE_USER", "worker"),
        Map.entry("DATABASE_PASSWORD", "secret"),
        Map.entry("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true"),
        Map.entry("CLAMAV_HOST", "clamav"),
        Map.entry("WORKER_ID", "worker-1"),
        Map.entry("XLSX_MANIFEST_KEY_ID", "key-1"),
        Map.entry("XLSX_MANIFEST_SECRET", "a-long-production-secret"),
        Map.entry("APPLICATION_INTERNAL_URL", "https://app.internal"),
        Map.entry("WORKER_CALLBACK_SECRET", "separate-callback-secret")));

    assertEquals(3310, config.clamAvPort());
    assertEquals("worker-1", config.workerId());
    assertEquals(120, config.leaseSeconds());
    assertEquals("/opt/verapdf/verapdf", config.veraPdfCommand());
    assertEquals("/app/fonts", config.fontRoot());
    assertEquals(90, config.pdfValidationTimeoutSeconds());
    assertEquals("key-1", config.xlsxManifestKeyId());
    assertEquals("a-long-production-secret", config.xlsxManifestSecret());
    assertEquals(25 * 1024 * 1024, config.xlsxMaxBytes());
    assertEquals(1_000, config.xlsxMaxRows());
    assertEquals(2_000, config.xlsxMaxZipEntries());
    assertEquals(100L * 1024L * 1024L, config.xlsxMaxUnpackedBytes());
    assertEquals("https://app.internal", config.applicationInternalUrl());
  }

  @Test
  void refusesToStartWithoutManifestSigningTrust() {
    var base = new java.util.HashMap<>(Map.of(
        "DATABASE_URL", "jdbc:postgresql://postgres:5432/sokol",
        "DATABASE_USER", "worker", "DATABASE_PASSWORD", "secret",
        "AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true",
        "CLAMAV_HOST", "clamav", "WORKER_ID", "worker-1"));
    assertThrows(IllegalArgumentException.class, () -> WorkerConfig.fromEnvironment(base));
    base.put("XLSX_MANIFEST_KEY_ID", "key-1");
    assertThrows(IllegalArgumentException.class, () -> WorkerConfig.fromEnvironment(base));
    base.put("XLSX_MANIFEST_SECRET", "manifest-secret");
    base.put("APPLICATION_INTERNAL_URL", "https://app.internal");
    assertThrows(IllegalArgumentException.class, () -> WorkerConfig.fromEnvironment(base));
  }
}

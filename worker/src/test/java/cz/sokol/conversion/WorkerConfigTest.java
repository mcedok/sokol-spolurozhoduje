package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Map;
import org.junit.jupiter.api.Test;

class WorkerConfigTest {
  @Test
  void requiresProductionConnectionsAndUsesOnlySafeOperationalDefaults() {
    assertThrows(IllegalArgumentException.class, () -> WorkerConfig.fromEnvironment(Map.of()));
    WorkerConfig config = WorkerConfig.fromEnvironment(Map.of(
        "DATABASE_URL", "jdbc:postgresql://postgres:5432/sokol",
        "DATABASE_USER", "worker",
        "DATABASE_PASSWORD", "secret",
        "AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true",
        "CLAMAV_HOST", "clamav",
        "WORKER_ID", "worker-1"));

    assertEquals(3310, config.clamAvPort());
    assertEquals("worker-1", config.workerId());
    assertEquals(120, config.leaseSeconds());
    assertEquals("/opt/verapdf/verapdf", config.veraPdfCommand());
    assertEquals("/app/fonts", config.fontRoot());
    assertEquals(90, config.pdfValidationTimeoutSeconds());
  }
}

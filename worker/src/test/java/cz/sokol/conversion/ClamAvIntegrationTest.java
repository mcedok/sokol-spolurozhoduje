package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class ClamAvIntegrationTest {
  @Test
  void realClamAvRejectsTheEicarSignature() throws Exception {
    String eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    ClamAvClient client = new ClamAvClient(
        System.getenv().getOrDefault("TEST_CLAMAV_HOST", "host.docker.internal"),
        Integer.parseInt(System.getenv().getOrDefault("TEST_CLAMAV_PORT", "3310")),
        Duration.ofSeconds(10));
    assertEquals(ClamAvClient.AvStatus.INFECTED,
        client.scan(new ByteArrayInputStream(eicar.getBytes(StandardCharsets.US_ASCII))));
  }
}

package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;

class ClamAvClientTest {
  @Test
  void classifiesClamResponsesWithoutLeakingRawOutput() {
    assertEquals(ClamAvClient.AvStatus.CLEAN, ClamAvClient.classify("stream: OK"));
    assertEquals(ClamAvClient.AvStatus.INFECTED,
        ClamAvClient.classify("stream: Eicar-Signature FOUND"));
    var error = assertThrows(ClamAvClient.AvProtocolException.class,
        () -> ClamAvClient.classify("unexpected secret path"));
    assertEquals("Neplatná odpověď antivirové služby.", error.getMessage());
  }

  @Test
  void streamsTheClamAvInstreamProtocolInBoundedChunks() throws Exception {
    byte[] content = new byte[70_000];
    try (ServerSocket server = new ServerSocket(0);
         var executor = Executors.newSingleThreadExecutor()) {
      var received = executor.submit(() -> {
        try (var socket = server.accept()) {
          DataInputStream input = new DataInputStream(socket.getInputStream());
          byte[] command = input.readNBytes("zINSTREAM\0".length());
          assertEquals("zINSTREAM\0", new String(command, StandardCharsets.US_ASCII));
          List<Integer> chunkSizes = new ArrayList<>();
          int total = 0;
          while (true) {
            int size = input.readInt();
            if (size == 0) break;
            chunkSizes.add(size);
            total += input.readNBytes(size).length;
          }
          OutputStream output = socket.getOutputStream();
          output.write("stream: OK\0".getBytes(StandardCharsets.US_ASCII));
          output.flush();
          return new ScanCapture(total, chunkSizes);
        }
      });
      ClamAvClient client = new ClamAvClient(
          "127.0.0.1", server.getLocalPort(), Duration.ofSeconds(2));

      assertEquals(ClamAvClient.AvStatus.CLEAN,
          client.scan(new ByteArrayInputStream(content)));
      ScanCapture capture = received.get();
      assertEquals(content.length, capture.total());
      assertEquals(List.of(65_536, 4_464), capture.chunkSizes());
    }
  }

  private record ScanCapture(int total, List<Integer> chunkSizes) {}
}

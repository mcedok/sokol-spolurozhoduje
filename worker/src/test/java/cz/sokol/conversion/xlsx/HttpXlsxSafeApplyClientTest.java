package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class HttpXlsxSafeApplyClientTest {
  @Test
  void postsTheSafeApplyCommandOverPlainHttp11WithoutAnUpgradeHeader() throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    AtomicReference<String> body = new AtomicReference<>();
    AtomicReference<String> authorization = new AtomicReference<>();
    AtomicReference<String> upgrade = new AtomicReference<>();
    server.createContext("/api/internal/xlsx-imports/018f6f9d-7e10-7000-8000-000000000010/apply-safe", exchange -> {
      body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
      authorization.set(exchange.getRequestHeaders().getFirst("authorization"));
      upgrade.set(exchange.getRequestHeaders().getFirst("upgrade"));
      exchange.sendResponseHeaders(200, 0);
      exchange.getResponseBody().close();
    });
    server.start();
    try {
      var command = new XlsxImportProcessor.SafeApplyCommand(
          UUID.fromString("018f6f9d-7e10-7000-8000-000000000010"), 3,
          UUID.fromString("018f6f9d-7e10-7000-8000-000000000011"),
          UUID.fromString("018f6f9d-7e10-7000-8000-000000000012"), UUID.randomUUID());
      new HttpXlsxSafeApplyClient(
          "http://127.0.0.1:" + server.getAddress().getPort(), "callback-secret")
          .apply(command);

      assertEquals("Bearer callback-secret", authorization.get());
      assertFalse(body.get().isBlank());
      assertEquals(null, upgrade.get());
    } finally {
      server.stop(0);
    }
  }
}

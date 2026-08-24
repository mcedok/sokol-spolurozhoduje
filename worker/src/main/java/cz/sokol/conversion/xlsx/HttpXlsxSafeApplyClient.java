package cz.sokol.conversion.xlsx;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** Calls the same-domain server API that owns transactional domain writes and hash-chained audit. */
public final class HttpXlsxSafeApplyClient implements XlsxImportProcessor.SafeApplyClient {
  private final HttpClient client;
  private final URI baseUri;
  private final String secret;

  public HttpXlsxSafeApplyClient(String baseUrl, String secret) {
    this.client = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(10))
        .build();
    this.baseUri = URI.create(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    this.secret = secret;
  }

  @Override
  public void apply(XlsxImportProcessor.SafeApplyCommand command) throws Exception {
    String body = "{\"expectedBatchRowVersion\":" + command.expectedBatchRowVersion()
        + ",\"correlationId\":\"" + command.correlationId()
        + "\",\"idempotencyKey\":\"" + command.idempotencyKey() + "\"}";
    HttpRequest request = HttpRequest.newBuilder(
            baseUri.resolve("api/internal/xlsx-imports/" + command.batchId() + "/apply-safe"))
        .timeout(Duration.ofSeconds(30))
        .header("authorization", "Bearer " + secret)
        .header("content-type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build();
    HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() < 200 || response.statusCode() >= 300) {
      throw new IllegalStateException("SAFE_APPLY_CALLBACK_" + response.statusCode());
    }
  }
}

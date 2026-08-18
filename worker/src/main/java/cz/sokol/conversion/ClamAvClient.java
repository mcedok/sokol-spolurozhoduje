package cz.sokol.conversion;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

public final class ClamAvClient implements VirusScanner {
  private static final int CHUNK_SIZE = 64 * 1024;
  private static final int MAX_RESPONSE_BYTES = 4096;

  private final String host;
  private final int port;
  private final Duration timeout;

  public ClamAvClient(String host, int port, Duration timeout) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
  }

  @Override
  public AvStatus scan(InputStream content) throws IOException {
    try (Socket socket = new Socket()) {
      int timeoutMillis = Math.toIntExact(timeout.toMillis());
      socket.connect(new InetSocketAddress(host, port), timeoutMillis);
      socket.setSoTimeout(timeoutMillis);
      DataOutputStream output = new DataOutputStream(socket.getOutputStream());
      output.write("zINSTREAM\0".getBytes(StandardCharsets.US_ASCII));
      byte[] buffer = new byte[CHUNK_SIZE];
      int count;
      while ((count = content.read(buffer)) != -1) {
        if (count == 0) continue;
        output.writeInt(count);
        output.write(buffer, 0, count);
      }
      output.writeInt(0);
      output.flush();
      ByteArrayOutputStream response = new ByteArrayOutputStream();
      InputStream input = socket.getInputStream();
      while (response.size() <= MAX_RESPONSE_BYTES) {
        int value = input.read();
        if (value == -1 || value == 0) break;
        response.write(value);
      }
      if (response.size() > MAX_RESPONSE_BYTES) {
        throw new AvProtocolException();
      }
      return classify(response.toString(StandardCharsets.US_ASCII));
    }
  }

  static AvStatus classify(String response) {
    if ("stream: OK".equals(response)) return AvStatus.CLEAN;
    if (response.startsWith("stream: ") && response.endsWith(" FOUND")) {
      return AvStatus.INFECTED;
    }
    throw new AvProtocolException();
  }

  public enum AvStatus { CLEAN, INFECTED }

  public static final class AvProtocolException extends RuntimeException {
    public AvProtocolException() {
      super("Neplatná odpověď antivirové služby.");
    }
  }
}

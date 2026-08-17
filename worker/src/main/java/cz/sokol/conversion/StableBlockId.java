package cz.sokol.conversion;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.UUID;

public final class StableBlockId {
  private final long timestamp;

  public StableBlockId(Instant versionCreatedAt) {
    timestamp = versionCreatedAt.toEpochMilli();
    if (timestamp < 0 || timestamp > 0xffffffffffffL) {
      throw new IllegalArgumentException("Čas verze je mimo rozsah UUIDv7.");
    }
  }

  public String create(String profileVersion, String seed) {
    try {
      byte[] hash = MessageDigest.getInstance("SHA-256").digest(
          (profileVersion + "\u0000" + seed).getBytes(StandardCharsets.UTF_8));
      byte[] bytes = new byte[16];
      long value = timestamp;
      for (int index = 5; index >= 0; index -= 1) {
        bytes[index] = (byte) (value & 0xff);
        value >>>= 8;
      }
      bytes[6] = (byte) (0x70 | (hash[0] & 0x0f));
      bytes[7] = hash[1];
      bytes[8] = (byte) (0x80 | (hash[2] & 0x3f));
      System.arraycopy(hash, 3, bytes, 9, 7);
      ByteBuffer buffer = ByteBuffer.wrap(bytes);
      return new UUID(buffer.getLong(), buffer.getLong()).toString();
    } catch (Exception error) {
      throw new IllegalStateException("Nelze vytvořit stabilní identifikátor bloku.", error);
    }
  }
}

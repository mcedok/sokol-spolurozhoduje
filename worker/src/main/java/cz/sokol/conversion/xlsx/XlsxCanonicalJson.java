package cz.sokol.conversion.xlsx;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.HexFormat;

public final class XlsxCanonicalJson {
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private XlsxCanonicalJson() {}

  public static String sha256(String json) throws Exception {
    byte[] canonical = canonical(json).getBytes(java.nio.charset.StandardCharsets.UTF_8);
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical));
  }

  public static String canonical(String json) throws Exception {
    return MAPPER.writeValueAsString(canonicalize(MAPPER.readTree(json)));
  }

  private static JsonNode canonicalize(JsonNode node) {
    if (node.isObject()) {
      ObjectNode result = MAPPER.createObjectNode();
      node.properties().stream().sorted(Comparator.comparing(java.util.Map.Entry::getKey))
          .forEach(entry -> result.set(entry.getKey(), canonicalize(entry.getValue())));
      return result;
    }
    if (node.isArray()) {
      ArrayNode result = MAPPER.createArrayNode();
      node.forEach(item -> result.add(canonicalize(item)));
      return result;
    }
    return node;
  }
}

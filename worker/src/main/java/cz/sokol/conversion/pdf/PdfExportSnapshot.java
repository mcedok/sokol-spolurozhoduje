package cz.sokol.conversion.pdf;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

public record PdfExportSnapshot(
    String schemaVersion,
    String visibility,
    String generatedAt,
    DocumentInfo document,
    Filters filters,
    Options options,
    Statistics statistics,
    List<Comment> comments) {
  private static final ObjectMapper JSON = new ObjectMapper()
      .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true)
      .configure(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true)
      .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);

  public PdfExportSnapshot {
    comments = comments == null ? List.of() : List.copyOf(comments);
    validate(schemaVersion, visibility, document, filters, options, statistics, comments);
  }

  public static PdfExportSnapshot fromJson(String source) {
    try {
      return JSON.readValue(source, PdfExportSnapshot.class);
    } catch (Exception error) {
      throw new IllegalArgumentException("Neplatný snapshot PDF exportu.", error);
    }
  }

  public static String checksumOfJson(String source) {
    try {
      JsonNode canonical = canonical(JSON.readTree(source));
      byte[] bytes = JSON.writeValueAsBytes(canonical);
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (Exception error) {
      throw new IllegalArgumentException("Snapshot PDF exportu nelze kontrolně sečíst.", error);
    }
  }

  private static JsonNode canonical(JsonNode value) {
    if (value.isObject()) {
      ObjectNode result = JSON.createObjectNode();
      java.util.stream.StreamSupport.stream(
          java.util.Spliterators.spliteratorUnknownSize(value.fieldNames(), 0), false)
          .sorted()
          .forEach(name -> result.set(name, canonical(value.get(name))));
      return result;
    }
    if (value.isArray()) {
      ArrayNode result = JSON.createArrayNode();
      value.forEach(item -> result.add(canonical(item)));
      return result;
    }
    return value;
  }
  public String checksum() {
    try {
      byte[] canonical = JSON.writeValueAsString(this).getBytes(StandardCharsets.UTF_8);
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical));
    } catch (Exception error) {
      throw new IllegalStateException("Snapshot PDF exportu nelze kontrolně sečíst.", error);
    }
  }

  public boolean internal() {
    return "internal".equals(visibility);
  }

  private static void validate(
      String schemaVersion, String visibility, DocumentInfo document, Filters filters,
      Options options, Statistics statistics, List<Comment> comments) {
    if (!"pdf-export-v1".equals(schemaVersion)) fail("Nepodporovaná verze snapshotu.");
    if (!"public".equals(visibility) && !"internal".equals(visibility)) {
      fail("Neplatná viditelnost exportu.");
    }
    if (document == null || blank(document.number()) || blank(document.title())
        || document.versionNumber() < 1) fail("Neplatné údaje dokumentu.");
    if (filters == null || options == null || statistics == null) {
      fail("Snapshot neobsahuje povinné nastavení.");
    }
    if (statistics.total() != comments.size()
        || statistics.settled() + statistics.open() != statistics.total()) {
      fail("Statistiky snapshotu neodpovídají připomínkám.");
    }
    for (Comment comment : comments) {
      if (comment == null || blank(comment.publicId()) || blank(comment.authorName())
          || blank(comment.organizationName()) || blank(comment.body())) {
        fail("Snapshot obsahuje neplatnou připomínku.");
      }
      if ("public".equals(visibility)
          && (comment.authorEmail() != null || comment.membershipId() != null
              || comment.internalNote() != null)) {
        fail("Veřejný snapshot obsahuje interní údaje.");
      }
      if ("internal".equals(visibility)
          && ((!options.includeAuthorEmail() && comment.authorEmail() != null)
              || (!options.includeMembershipId() && comment.membershipId() != null)
              || (!options.includeInternalNote() && comment.internalNote() != null))) {
        fail("Interní snapshot obsahuje pole, které nebylo výslovně zapnuto.");
      }    }
    if ("public".equals(visibility)
        && (options.includeAuthorEmail() || options.includeMembershipId()
            || options.includeInternalNote())) {
      fail("Veřejný snapshot nesmí aktivovat interní pole.");
    }
  }

  private static boolean blank(String value) {
    return value == null || value.isBlank();
  }

  private static void fail(String message) {
    throw new IllegalArgumentException(message);
  }

  public record DocumentInfo(
      String number, String title, String explanatoryReport, int versionNumber) {}

  public record Filters(List<String> statuses, List<String> priorities, List<String> types) {
    public Filters {
      statuses = statuses == null ? List.of() : List.copyOf(statuses);
      priorities = priorities == null ? List.of() : List.copyOf(priorities);
      types = types == null ? List.of() : List.copyOf(types);
    }
  }

  public record Options(
      boolean includeAuthorEmail,
      boolean includeMembershipId,
      boolean includeInternalNote) {}

  public record Statistics(int total, int settled, int open) {}

  public record Comment(
      String publicId,
      int blockOrder,
      String blockText,
      String authorName,
      String organizationName,
      String authorEmail,
      String membershipId,
      String createdAt,
      String body,
      String type,
      String priority,
      String status,
      Settlement settlement,
      String internalNote) {}

  public record Settlement(
      String outcome,
      String statement,
      String settledAt,
      Integer targetVersionNumber) {}
}
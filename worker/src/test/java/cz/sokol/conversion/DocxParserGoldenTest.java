package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.InputFormat;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import cz.sokol.conversion.model.ConversionResult;
import java.nio.file.Path;
import java.nio.file.Files;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class DocxParserGoldenTest {
  private static final String SOURCE_SHA = "1".repeat(64);
  private static final String PROFILE = "docx-web-v1";
  private static final Instant VERSION_TIME = Instant.parse("2026-08-17T08:00:00Z");
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final Path FIXTURES = Path.of(System.getenv().getOrDefault(
      "SOKOL_FIXTURE_ROOT", "../test/fixtures/docx"));
  private static final Path SCHEMAS = Path.of(System.getenv().getOrDefault(
      "SOKOL_SCHEMA_ROOT", "../contracts/schemas"));

  @Test
  void parsesSupportedElementsIntoTheHandReviewedGoldenStructure() throws Exception {
    DocxParser parser = new DocxParser(VERSION_TIME);
    ConversionResult first = parser.parse(fixture("supported-elements.docx"), SOURCE_SHA, PROFILE);
    ConversionResult second = parser.parse(fixture("supported-elements.docx"), SOURCE_SHA, PROFILE);
    JsonNode expected = JSON.readTree(
        fixture("expected/supported-elements.json").toFile());

    assertEquals(expected, goldenProjection(first));
    assertEquals(
        first.blocks().stream().map(ConversionResult.Block::blockUid).toList(),
        second.blocks().stream().map(ConversionResult.Block::blockUid).toList());
    assertTrue(first.blocks().stream()
        .map(ConversionResult.Block::blockUid)
        .map(UUID::fromString)
        .allMatch(id -> id.version() == 7));
    assertFalse(first.blocks().get(first.blocks().size() - 1).commentable());
  }

  @Test
  void usesBookmarksAndParaIdsBeforeTextFallbacks() throws Exception {
    ConversionResult result = new DocxParser(VERSION_TIME).parse(
        fixture("bookmarks-and-ids.docx"), SOURCE_SHA, PROFILE);

    assertEquals("clanek-1", result.blocks().get(0).sourceBookmark());
    assertEquals("1122AABB", result.blocks().get(1).sourceParaId());
    assertNotEquals(result.blocks().get(0).blockUid(), result.blocks().get(1).blockUid());
  }

  @Test
  void removesUnsafeProtocolsButKeepsMailtoAndReportsTheRemoval() throws Exception {
    ConversionResult result = new DocxParser(VERSION_TIME).parse(
        fixture("unsafe-links.docx"), SOURCE_SHA, PROFILE);
    String json = JSON.writeValueAsString(result);

    assertTrue(result.findings().stream()
        .anyMatch(finding -> finding.code().equals("UNSAFE_LINK_REMOVED")));
    assertFalse(json.toLowerCase().contains("javascript:"));
    assertTrue(json.contains("mailto:info@sokol.eu"));
  }

  @Test
  void conversionOutputMatchesTheClosedPortableJsonSchema() throws Exception {
    ConversionResult result = new DocxParser(VERSION_TIME).parse(
        fixture("supported-elements.docx"), SOURCE_SHA, PROFILE);
    var schema = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
        .getSchema(Files.readString(SCHEMAS.resolve("conversion-result.schema.json")));
    String validJson = JSON.writeValueAsString(result);

    var validationErrors = schema.validate(validJson, InputFormat.JSON);
    assertTrue(validationErrors.isEmpty(), () -> validationErrors.toString());
    ObjectNode withInternalField = (ObjectNode) JSON.readTree(validJson);
    withInternalField.put("internalObjectKey", "secret");
    assertFalse(schema.validate(JSON.writeValueAsString(withInternalField), InputFormat.JSON).isEmpty());
  }

  private static JsonNode goldenProjection(ConversionResult result) {
    ObjectNode root = JSON.createObjectNode();
    ArrayNode blocks = root.putArray("blocks");
    for (ConversionResult.Block block : result.blocks()) {
      ObjectNode projected = JSON.valueToTree(block);
      projected.remove("blockUid");
      projected.remove("normalizedHash");
      projected.remove("commentable");
      blocks.add(projected);
    }
    return root;
  }

  private static Path fixture(String name) {
    return FIXTURES.resolve(name);
  }
}

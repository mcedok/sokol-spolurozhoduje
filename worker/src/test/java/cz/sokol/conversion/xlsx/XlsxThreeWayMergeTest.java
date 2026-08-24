package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

class XlsxThreeWayMergeTest {
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void treatsDisjointConcurrentChangesAsAWholeRowConflict() {
    ObjectNode base = row("normal", "open");
    ObjectNode current = row("normal", "under_review");
    ObjectNode incoming = row("high", "open");
    ArrayNode errors = mapper.createArrayNode();

    assertEquals("conflict", XlsxThreeWayMerge.classify(base, current, incoming, errors));
  }

  private ObjectNode row(String priority, String status) {
    ObjectNode row = mapper.createObjectNode();
    row.put("type", "comment");
    row.put("priority", priority);
    row.put("status", status);
    row.putNull("outcome");
    row.putNull("statement");
    row.putNull("targetVersionNumber");
    row.putNull("responsibleUserId");
    row.putNull("declaredSettlementDate");
    return row;
  }
}

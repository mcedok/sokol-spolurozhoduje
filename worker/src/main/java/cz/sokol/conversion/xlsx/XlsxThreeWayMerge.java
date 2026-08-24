package cz.sokol.conversion.xlsx;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Whole-row three-way merge classification shared by XLSX staging tests and repository code. */
final class XlsxThreeWayMerge {
  private XlsxThreeWayMerge() {}

  static String classify(ObjectNode base, ObjectNode current, ObjectNode incoming, ArrayNode errors) {
    if (!errors.isEmpty()) return "invalid";
    if (incoming.equals(base)) return "unchanged";
    if (incoming.equals(current)) return "already_current";
    if (current.equals(base)) return "safe_change";
    return "conflict";
  }
}

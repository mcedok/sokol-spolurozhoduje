package cz.sokol.conversion;

import java.io.InputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipFile;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

public final class TableComplexityAnalyzer {
  private static final String W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  public List<Analysis> analyze(Path docx) throws Exception {
    return analyze(docx, Set.of());
  }

  public List<Analysis> analyze(Path docx, Set<Integer> renderMismatches) throws Exception {
    try (ZipFile zip = new ZipFile(docx.toFile())) {
      var entry = zip.getEntry("word/document.xml");
      if (entry == null) throw new IllegalArgumentException("DOCX nemá povinný document.xml.");
      DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
      factory.setNamespaceAware(true);
      factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
      factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
      factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
      factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
      factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
      try (InputStream input = zip.getInputStream(entry)) {
        Element body = (Element) factory.newDocumentBuilder().parse(input)
            .getElementsByTagNameNS(W, "body").item(0);
        List<Analysis> results = new ArrayList<>();
        List<Element> tables = direct(body, "tbl");
        if (renderMismatches.stream().anyMatch(index -> index < 0 || index >= tables.size())) {
          throw new IllegalArgumentException("Index odchylky renderu neodpovídá tabulce.");
        }
        for (int index = 0; index < tables.size(); index += 1) {
          Metrics metrics = metrics(tables.get(index));
          if (renderMismatches.contains(index)) metrics = new Metrics(
              metrics.mergedCells(), metrics.nestedTables(), metrics.columns(), metrics.rows(),
              metrics.richCellFeatures(), true);
          results.add(analyze(metrics));
        }
        return List.copyOf(results);
      }
    }
  }

  public Analysis analyze(Metrics metrics) {
    if (metrics.mergedCells() < 0 || metrics.nestedTables() < 0 || metrics.columns() < 0
        || metrics.rows() < 0 || metrics.richCellFeatures() < 0) {
      throw new IllegalArgumentException("Metriky tabulky nesmí být záporné.");
    }
    List<Reason> reasons = new ArrayList<>();
    add(reasons, "MERGED_CELLS", 3 * metrics.mergedCells(), metrics.mergedCells());
    add(reasons, "NESTED_TABLES", 10 * metrics.nestedTables(), metrics.nestedTables());
    if (metrics.columns() > 20) add(reasons, "MORE_THAN_20_COLUMNS", 10, metrics.columns());
    if (metrics.rows() > 200) add(reasons, "MORE_THAN_200_ROWS", 10, metrics.rows());
    add(reasons, "RICH_CELL_CONTENT", 5 * metrics.richCellFeatures(), metrics.richCellFeatures());
    if (metrics.renderMismatch()) add(reasons, "RENDER_MISMATCH", 15, 1);
    int score = reasons.stream().mapToInt(Reason::points).sum();
    Recommendation recommendation = score >= 30
        ? new Recommendation("attachment_only")
        : score >= 10
            ? new Recommendation("image_with_attachment")
            : new Recommendation("html");
    return new Analysis(score, recommendation, List.copyOf(reasons));
  }

  private static void add(List<Reason> reasons, String code, int points, int occurrences) {
    if (points > 0) reasons.add(new Reason(code, points, occurrences));
  }

  private static Metrics metrics(Element table) {
    int merges = table.getElementsByTagNameNS(W, "gridSpan").getLength()
        + table.getElementsByTagNameNS(W, "vMerge").getLength();
    int nested = table.getElementsByTagNameNS(W, "tbl").getLength();
    List<Element> rows = direct(table, "tr");
    int columns = 0;
    int richFeatures = 0;
    for (Element row : rows) {
      int rowColumns = 0;
      for (Element cell : direct(row, "tc")) {
        NodeList spans = cell.getElementsByTagNameNS(W, "gridSpan");
        int span = 1;
        if (spans.getLength() > 0) {
          try { span = Integer.parseInt(((Element) spans.item(0)).getAttributeNS(W, "val")); }
          catch (NumberFormatException ignored) { span = 1; }
        }
        rowColumns += Math.max(1, span);
        if (cell.getElementsByTagNameNS(W, "drawing").getLength() > 0
            || cell.getElementsByTagNameNS(W, "pict").getLength() > 0) richFeatures += 1;
        if (cell.getElementsByTagNameNS(W, "txbxContent").getLength() > 0) richFeatures += 1;
        if (direct(cell, "p").size() > 1) richFeatures += 1;
      }
      columns = Math.max(columns, rowColumns);
    }
    return new Metrics(merges, nested, columns, rows.size(), richFeatures, false);
  }

  private static List<Element> direct(Element parent, String name) {
    List<Element> result = new ArrayList<>();
    for (Node child = parent.getFirstChild(); child != null; child = child.getNextSibling()) {
      if (child instanceof Element element && W.equals(element.getNamespaceURI())
          && name.equals(element.getLocalName())) result.add(element);
    }
    return result;
  }

  public record Metrics(
      int mergedCells,
      int nestedTables,
      int columns,
      int rows,
      int richCellFeatures,
      boolean renderMismatch) {}

  public record Reason(String code, int points, int occurrences) {}
  public record Recommendation(String code) {}
  public record Analysis(int score, Recommendation recommendation, List<Reason> reasons) {}
}

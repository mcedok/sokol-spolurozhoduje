package cz.sokol.conversion;

import cz.sokol.conversion.model.ConversionResult;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

public final class DocxParser {
  private static final String W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  private static final String W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
  private static final String R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  private final StableBlockId ids;

  public DocxParser(Instant versionCreatedAt) {
    ids = new StableBlockId(versionCreatedAt);
  }

  public ConversionResult parse(Path path, String sourceSha256, String profileVersion) throws Exception {
    if (!sourceSha256.matches("[a-f0-9]{64}") || !profileVersion.startsWith("docx-web-v1")) {
      throw new IllegalArgumentException("Neplatná identita vstupu nebo profil převodu.");
    }
    try (ZipFile zip = new ZipFile(path.toFile())) {
      Document document = xml(zip, "word/document.xml", true);
      Map<String, String> relationships = relationships(xml(
          zip, "word/_rels/document.xml.rels", false));
      StyleCatalog styles = styles(xml(zip, "word/styles.xml", false));
      Map<String, String> numbering = numbering(xml(zip, "word/numbering.xml", false));
      List<ConversionResult.Finding> findings = new ArrayList<>();
      List<Draft> drafts = drafts(document, relationships, styles, numbering, findings);
      List<String> hashes = drafts.stream().map(draft -> sha256(normalize(draft.text()))).toList();
      Map<String, Integer> collisions = new HashMap<>();
      List<ConversionResult.Block> blocks = new ArrayList<>();
      for (int index = 0; index < drafts.size(); index += 1) {
        Draft draft = drafts.get(index);
        String seed;
        if (draft.bookmark() != null) seed = "bookmark:" + draft.bookmark();
        else if (draft.paraId() != null) seed = "paraId:" + draft.paraId();
        else {
          String previous = index == 0 ? "" : hashes.get(index - 1);
          String next = index + 1 == hashes.size() ? "" : hashes.get(index + 1);
          String base = String.join("/", draft.headingPath()) + "\u0000" + draft.type()
              + "\u0000" + normalize(draft.text()) + "\u0000" + previous + "\u0000" + next;
          int collision = collisions.merge(base, 1, Integer::sum) - 1;
          seed = base + "\u0000" + collision;
        }
        blocks.add(new ConversionResult.Block(
            ids.create(profileVersion, seed), draft.type(), draft.text(), hashes.get(index),
            !"technical_separator".equals(draft.type()), List.copyOf(draft.headingPath()),
            draft.bookmark(), draft.paraId(), Map.copyOf(draft.content()), List.of()));
      }
      return new ConversionResult(profileVersion, sourceSha256, List.copyOf(blocks), List.copyOf(findings));
    }
  }

  private static List<Draft> drafts(
      Document document,
      Map<String, String> relationships,
      StyleCatalog styles,
      Map<String, String> numbering,
      List<ConversionResult.Finding> findings) {
    List<Draft> result = new ArrayList<>();
    List<String> headingPath = new ArrayList<>();
    Element body = first(document.getDocumentElement(), W, "body");
    for (Node child = body.getFirstChild(); child != null; child = child.getNextSibling()) {
      if (!(child instanceof Element element) || !W.equals(element.getNamespaceURI())) continue;
      if ("p".equals(element.getLocalName())) {
        Draft paragraph = paragraph(element, relationships, styles, numbering, findings, headingPath);
        if (paragraph != null) {
          if ("heading".equals(paragraph.type())) {
            int level = (int) paragraph.content().get("level");
            while (headingPath.size() >= level) headingPath.remove(headingPath.size() - 1);
            headingPath.add(paragraph.text());
            paragraph = paragraph.withHeadingPath(List.copyOf(headingPath));
          }
          result.add(paragraph);
        }
      } else if ("tbl".equals(element.getLocalName())) {
        result.add(table(element, headingPath));
      }
    }
    return result;
  }

  private static Draft paragraph(
      Element paragraph,
      Map<String, String> relationships,
      StyleCatalog styles,
      Map<String, String> numbering,
      List<ConversionResult.Finding> findings,
      List<String> headingPath) {
    String style = value(first(first(paragraph, W, "pPr"), W, "pStyle"));
    String bookmark = trustedBookmark(paragraph);
    String paraId = blankToNull(paragraph.getAttributeNS(W14, "paraId"));
    List<Map<String, Object>> runs = new ArrayList<>();
    collectRuns(paragraph, null, relationships, findings, runs);
    String text = runs.stream().map(run -> (String) run.get("text")).reduce("", String::concat);
    if (text.isBlank()) {
      if (paragraph.getElementsByTagNameNS(W, "br").getLength() > 0) {
        return new Draft("technical_separator", "", List.copyOf(headingPath), bookmark, paraId, Map.of());
      }
      return null;
    }
    Element numPr = first(first(paragraph, W, "pPr"), W, "numPr");
    String type = "paragraph";
    Map<String, Object> content = new LinkedHashMap<>();
    if (numPr != null) {
      type = "list_item";
      String numId = value(first(numPr, W, "numId"));
      content.put("listKind", "bullet".equals(numbering.get(numId)) ? "bullet" : "ordered");
      content.put("level", integer(value(first(numPr, W, "ilvl")), 0));
    } else if (styles.headingLevels().containsKey(style)) {
      type = "heading";
      content.put("level", styles.headingLevels().get(style));
    } else if (styles.quotes().contains(style)) {
      type = "quote";
    } else if (styles.callouts().contains(style)) {
      type = "callout";
    }
    content.put("runs", runs);
    return new Draft(type, text, List.copyOf(headingPath), bookmark, paraId, content);
  }

  private static Draft table(Element table, List<String> headingPath) {
    List<List<Map<String, Object>>> rows = new ArrayList<>();
    List<String> plainRows = new ArrayList<>();
    for (Element row : direct(table, W, "tr")) {
      List<Map<String, Object>> cells = new ArrayList<>();
      List<String> plainCells = new ArrayList<>();
      for (Element cell : direct(row, W, "tc")) {
        String text = text(cell).trim();
        cells.add(Map.of("text", text));
        plainCells.add(text);
      }
      rows.add(cells);
      plainRows.add(String.join(" | ", plainCells));
    }
    return new Draft("table", String.join("\n", plainRows), List.copyOf(headingPath),
        null, null, Map.of("rows", rows));
  }

  private static void collectRuns(
      Element parent,
      String inheritedHref,
      Map<String, String> relationships,
      List<ConversionResult.Finding> findings,
      List<Map<String, Object>> output) {
    for (Node child = parent.getFirstChild(); child != null; child = child.getNextSibling()) {
      if (!(child instanceof Element element) || !W.equals(element.getNamespaceURI())) continue;
      if ("hyperlink".equals(element.getLocalName())) {
        String target = relationships.get(element.getAttributeNS(R, "id"));
        Optional<String> safe = SafeLink.sanitize(target);
        if (target != null && safe.isEmpty()) {
          findings.add(new ConversionResult.Finding(
              "UNSAFE_LINK_REMOVED", "warning", "Nebezpečný odkaz byl odstraněn.", Map.of()));
        }
        collectRuns(element, safe.orElse(null), relationships, findings, output);
      } else if ("r".equals(element.getLocalName())) {
        String runText = text(element);
        if (runText.isEmpty()) continue;
        Element properties = first(element, W, "rPr");
        Map<String, Object> run = new LinkedHashMap<>();
        run.put("text", runText);
        run.put("bold", first(properties, W, "b") != null);
        run.put("italic", first(properties, W, "i") != null);
        run.put("underline", first(properties, W, "u") != null);
        Element highlight = first(properties, W, "highlight");
        run.put("highlight", highlight == null ? null : value(highlight));
        run.put("href", inheritedHref);
        output.add(run);
      }
    }
  }

  private static Map<String, String> relationships(Document document) {
    Map<String, String> result = new HashMap<>();
    if (document == null) return result;
    NodeList nodes = document.getElementsByTagNameNS("*", "Relationship");
    for (int index = 0; index < nodes.getLength(); index += 1) {
      Element relationship = (Element) nodes.item(index);
      result.put(relationship.getAttribute("Id"), relationship.getAttribute("Target"));
    }
    return result;
  }

  private static StyleCatalog styles(Document document) {
    Map<String, Integer> headings = new HashMap<>();
    List<String> quotes = new ArrayList<>();
    List<String> callouts = new ArrayList<>();
    if (document == null) return new StyleCatalog(headings, quotes, callouts);
    NodeList nodes = document.getElementsByTagNameNS(W, "style");
    for (int index = 0; index < nodes.getLength(); index += 1) {
      Element style = (Element) nodes.item(index);
      String id = style.getAttributeNS(W, "styleId");
      String outline = value(first(first(style, W, "pPr"), W, "outlineLvl"));
      if (outline != null) headings.put(id, integer(outline, 0) + 1);
      String name = value(first(style, W, "name"));
      Integer namedHeadingLevel = headingLevel(id, name);
      if (outline == null && namedHeadingLevel != null) headings.put(id, namedHeadingLevel);
      if (name != null && (name.equalsIgnoreCase("quote") || name.equalsIgnoreCase("intense quote"))) {
        quotes.add(id);
      }
      if (name != null && name.equalsIgnoreCase("callout")) callouts.add(id);
    }
    return new StyleCatalog(headings, quotes, callouts);
  }

  private static Integer headingLevel(String id, String name) {
    for (String candidate : List.of(id == null ? "" : id, name == null ? "" : name)) {
      var match = java.util.regex.Pattern.compile("(?i)^(?:heading|nadpis)\\s*([1-9])$")
          .matcher(candidate.trim());
      if (match.matches()) return Integer.parseInt(match.group(1));
    }
    return null;
  }

  private static Map<String, String> numbering(Document document) {
    Map<String, String> abstractFormats = new HashMap<>();
    Map<String, String> result = new HashMap<>();
    if (document == null) return result;
    for (Element abstractNum : elements(document, W, "abstractNum")) {
      String id = abstractNum.getAttributeNS(W, "abstractNumId");
      String format = value(first(first(abstractNum, W, "lvl"), W, "numFmt"));
      abstractFormats.put(id, format);
    }
    for (Element num : elements(document, W, "num")) {
      result.put(num.getAttributeNS(W, "numId"),
          abstractFormats.get(value(first(num, W, "abstractNumId"))));
    }
    return result;
  }

  private static Document xml(ZipFile zip, String name, boolean required) throws Exception {
    ZipEntry entry = zip.getEntry(name);
    if (entry == null) {
      if (required) throw new IllegalArgumentException("DOCX nemá povinný dokument.xml.");
      return null;
    }
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
    factory.setNamespaceAware(true);
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
    factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
    factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
    factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
    try (InputStream input = zip.getInputStream(entry)) {
      return factory.newDocumentBuilder().parse(input);
    }
  }

  private static String trustedBookmark(Element paragraph) {
    Element bookmark = first(paragraph, W, "bookmarkStart");
    if (bookmark == null) return null;
    String name = bookmark.getAttributeNS(W, "name");
    return name.matches("[A-Za-z][A-Za-z0-9_.-]{0,127}") && !name.startsWith("_") ? name : null;
  }

  private static String normalize(String text) {
    return Normalizer.normalize(text, Normalizer.Form.NFC).trim().replaceAll("\\s+", " ");
  }

  private static String sha256(String text) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
          .digest(text.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }

  private static String text(Element element) {
    StringBuilder result = new StringBuilder();
    NodeList nodes = element.getElementsByTagNameNS(W, "t");
    for (int index = 0; index < nodes.getLength(); index += 1) result.append(nodes.item(index).getTextContent());
    return result.toString();
  }

  private static List<Element> elements(Document document, String namespace, String name) {
    List<Element> result = new ArrayList<>();
    NodeList nodes = document.getElementsByTagNameNS(namespace, name);
    for (int index = 0; index < nodes.getLength(); index += 1) result.add((Element) nodes.item(index));
    return result;
  }

  private static List<Element> direct(Element parent, String namespace, String name) {
    List<Element> result = new ArrayList<>();
    if (parent == null) return result;
    for (Node child = parent.getFirstChild(); child != null; child = child.getNextSibling()) {
      if (child instanceof Element element && namespace.equals(element.getNamespaceURI())
          && name.equals(element.getLocalName())) result.add(element);
    }
    return result;
  }

  private static Element first(Element parent, String namespace, String name) {
    if (parent == null) return null;
    NodeList nodes = parent.getElementsByTagNameNS(namespace, name);
    return nodes.getLength() == 0 ? null : (Element) nodes.item(0);
  }

  private static String value(Element element) {
    if (element == null) return null;
    String value = element.getAttributeNS(W, "val");
    return blankToNull(value);
  }

  private static String blankToNull(String value) {
    return value == null || value.isBlank() ? null : value;
  }

  private static int integer(String value, int fallback) {
    try { return value == null ? fallback : Integer.parseInt(value); }
    catch (NumberFormatException error) { return fallback; }
  }

  private record StyleCatalog(
      Map<String, Integer> headingLevels,
      List<String> quotes,
      List<String> callouts) {}

  private record Draft(
      String type,
      String text,
      List<String> headingPath,
      String bookmark,
      String paraId,
      Map<String, Object> content) {
    Draft withHeadingPath(List<String> path) {
      return new Draft(type, text, path, bookmark, paraId, content);
    }
  }
}

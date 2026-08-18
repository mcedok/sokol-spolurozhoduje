package cz.sokol.conversion;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

final class TableDocumentExtractor {
  private static final String W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  void extract(Path source, int tableIndex, Path output) throws Exception {
    if (tableIndex < 0) throw new IllegalArgumentException("Neplatné pořadí tabulky.");
    Files.createDirectories(output.toAbsolutePath().normalize().getParent());
    try (ZipFile input = new ZipFile(source.toFile());
        ZipOutputStream target = new ZipOutputStream(Files.newOutputStream(output))) {
      Enumeration<? extends ZipEntry> entries = input.entries();
      while (entries.hasMoreElements()) {
        ZipEntry entry = entries.nextElement();
        ZipEntry copy = new ZipEntry(entry.getName());
        copy.setTime(0L);
        target.putNextEntry(copy);
        if ("word/document.xml".equals(entry.getName())) {
          try (InputStream content = input.getInputStream(entry)) {
            writeIsolatedDocument(content, tableIndex, target);
          }
        } else if (!entry.isDirectory()) {
          try (InputStream content = input.getInputStream(entry)) {
            content.transferTo(target);
          }
        }
        target.closeEntry();
      }
    }
  }

  private static void writeIsolatedDocument(
      InputStream input, int tableIndex, ZipOutputStream output) throws Exception {
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
    factory.setNamespaceAware(true);
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
    factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
    factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
    factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
    Document document = factory.newDocumentBuilder().parse(input);
    Element body = (Element) document.getElementsByTagNameNS(W, "body").item(0);
    List<Node> children = new ArrayList<>();
    List<Node> tables = new ArrayList<>();
    for (Node child = body.getFirstChild(); child != null; child = child.getNextSibling()) {
      children.add(child);
      if (child instanceof Element element && W.equals(element.getNamespaceURI())
          && "tbl".equals(element.getLocalName())) tables.add(child);
    }
    if (tableIndex >= tables.size()) throw new IllegalArgumentException("Tabulka nebyla nalezena.");
    Node selected = tables.get(tableIndex);
    for (Node child : children) {
      boolean section = child instanceof Element element && W.equals(element.getNamespaceURI())
          && "sectPr".equals(element.getLocalName());
      if (child != selected && !section) body.removeChild(child);
    }
    TransformerFactory transformers = TransformerFactory.newInstance();
    transformers.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
    try {
      transformers.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
      transformers.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "");
    } catch (IllegalArgumentException unsupportedByBundledTransformer) {
      // DOMSource contains no external resource; secure processing remains mandatory.
    }
    var transformer = transformers.newTransformer();
    transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
    transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "no");
    transformer.transform(new DOMSource(document), new StreamResult(output));
  }
}

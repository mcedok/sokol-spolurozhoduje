package cz.sokol.conversion.xlsx;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.openxml4j.opc.OPCPackage;
import org.apache.poi.openxml4j.opc.PackageAccess;
import org.apache.poi.ss.util.CellReference;
import org.apache.poi.xssf.eventusermodel.ReadOnlySharedStringsTable;
import org.apache.poi.xssf.eventusermodel.XSSFReader;
import org.apache.poi.xssf.eventusermodel.XSSFSheetXMLHandler;
import org.apache.poi.xssf.model.StylesTable;
import org.apache.poi.xssf.usermodel.XSSFComment;
import org.apache.poi.util.XMLHelper;
import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.XMLReader;
import org.xml.sax.helpers.XMLFilterImpl;

public final class XlsxImportParser {
  private static final List<String> REQUIRED_SHEETS = List.of("Pokyny", "Vypořádání", "Statistika", "Číselníky", "Manifest");
  private static final List<String> HEADERS = List.of(
      "ID připomínky", "Pořadí bloku", "Text bloku", "Autor", "Organizace", "Datum podání",
      "Text připomínky", "Typ", "Priorita", "Stav", "Výsledek", "Stanovisko",
      "Cílová verze", "Odpovědná osoba", "Datum vypořádání");
  private static final Set<String> BLOCKED_ZIP_PARTS = Set.of(
      "vbaProject.bin", "externalLinks", "connections.xml", "customXml");
  private final DataFormatter formatter = new DataFormatter();

  public ParsedWorkbook parse(Path input, XlsxSecurityPolicy policy) throws Exception {
    return parseInternal(input, policy, null, null);
  }

  public ParsedWorkbook parse(Path input, XlsxSecurityPolicy policy,
      ManifestExpectation expectation, byte[] signingSecret) throws Exception {
    if (expectation == null || signingSecret == null || signingSecret.length == 0) {
      throw new XlsxValidationException("MANIFEST_TRUST_REQUIRED");
    }
    return parseInternal(input, policy, expectation, signingSecret);
  }

  private ParsedWorkbook parseInternal(Path input, XlsxSecurityPolicy policy,
      ManifestExpectation expectation, byte[] signingSecret) throws Exception {
    validateContainer(input, policy);
    try (OPCPackage container = OPCPackage.open(input.toFile(), PackageAccess.READ)) {
      XSSFReader reader = new XSSFReader(container);
      StylesTable styles = reader.getStylesTable();
      ReadOnlySharedStringsTable strings = new ReadOnlySharedStringsTable(container);
      XSSFReader.SheetIterator sheets = (XSSFReader.SheetIterator) reader.getSheetsData();
      List<String> names = new ArrayList<>();
      TextBudget textBudget = new TextBudget(policy);
      SettlementSheetHandler settlement = new SettlementSheetHandler(policy, textBudget);
      ManifestSheetHandler manifest = new ManifestSheetHandler(textBudget);
      while (sheets.hasNext()) {
        try (InputStream stream = sheets.next()) {
          String name = sheets.getSheetName();
          names.add(name);
          if ("Vypořádání".equals(name)) parseSheet(stream, styles, strings, settlement, true);
          else if ("Manifest".equals(name)) parseSheet(stream, styles, strings, manifest, false);
          else parseSheet(stream, styles, strings, new CountingSheetHandler(textBudget), false);
        }
      }
      if (!REQUIRED_SHEETS.equals(names)) throw new XlsxValidationException("UNEXPECTED_SHEETS");
      settlement.validateHeader();
      validateManifest(manifest.values(), expectation, signingSecret);
      return new ParsedWorkbook(settlement.rows());
    } catch (XlsxValidationException error) {
      throw error;
    } catch (ParsingAbort error) {
      throw error.validation;
    } catch (Exception error) {
      Throwable nested = error;
      while (nested != null) {
        if (nested instanceof ParsingAbort abort) throw abort.validation;
        nested = nested.getCause();
      }
      throw new XlsxValidationException("INVALID_XLSX", error);
    }
  }

  private void parseSheet(InputStream stream, StylesTable styles, ReadOnlySharedStringsTable strings,
      XSSFSheetXMLHandler.SheetContentsHandler handler, boolean rejectEditableFormulas) throws Exception {
    XMLReader reader = XMLHelper.newXMLReader();
    var content = new XSSFSheetXMLHandler(styles, null, strings, handler, formatter, false);
    if (rejectEditableFormulas) {
      FormulaRejectingFilter filter = new FormulaRejectingFilter();
      filter.setParent(reader); filter.setContentHandler(content);
      filter.parse(new InputSource(stream));
    } else {
      reader.setContentHandler(content);
      reader.parse(new InputSource(stream));
    }
  }

  private void validateContainer(Path input, XlsxSecurityPolicy policy) throws Exception {
    if (!Files.exists(input) || Files.size(input) > policy.maxBytes()) throw new XlsxValidationException("FILE_LIMIT");
    byte[] header;
    try (InputStream stream = Files.newInputStream(input)) {
      header = stream.readNBytes(4);
    }
    if (header.length < 4 || header[0] != 'P' || header[1] != 'K') throw new XlsxValidationException("XLSX_REQUIRED");
    try (ZipFile zip = new ZipFile(input.toFile())) {
      long expanded = 0;
      int entries = 0;
      ZipEntry contentTypes = null;
      var enumeration = zip.entries();
      while (enumeration.hasMoreElements()) {
        ZipEntry entry = enumeration.nextElement();
        entries++;
        expanded += Math.max(0, entry.getSize());
        if (entries > policy.maxZipEntries() || expanded > policy.maxUncompressedBytes()) {
          throw new XlsxValidationException("ZIP_EXPANSION_LIMIT");
        }
        String name = entry.getName();
        String normalizedName = name.toLowerCase(java.util.Locale.ROOT);
        if ("[content_types].xml".equals(normalizedName)) contentTypes = entry;
        if (BLOCKED_ZIP_PARTS.stream()
            .map(part -> part.toLowerCase(java.util.Locale.ROOT))
            .anyMatch(normalizedName::contains) || normalizedName.endsWith(".bin")) {
          throw new XlsxValidationException("MACRO_OR_EXTERNAL_PART");
        }
        if (normalizedName.endsWith(".rels")) {
          byte[] relationshipBytes = zip.getInputStream(entry).readNBytes(1_048_577);
          if (relationshipBytes.length > 1_048_576) {
            throw new XlsxValidationException("ZIP_EXPANSION_LIMIT");
          }
          String relationships = new String(relationshipBytes, StandardCharsets.UTF_8)
              .toLowerCase(java.util.Locale.ROOT);
          if (relationships.matches("(?s).*targetmode\\s*=\\s*[\"']external[\"'].*")) {
            throw new XlsxValidationException("MACRO_OR_EXTERNAL_PART");
          }
        }
      }
      if (contentTypes == null) throw new XlsxValidationException("INVALID_XLSX");
      byte[] contentTypeBytes = zip.getInputStream(contentTypes).readNBytes(1_048_577);
      if (contentTypeBytes.length > 1_048_576) throw new XlsxValidationException("ZIP_EXPANSION_LIMIT");
      String content = new String(contentTypeBytes, StandardCharsets.UTF_8)
          .toLowerCase(java.util.Locale.ROOT);
      if (content.contains("macroenabled") || content.contains("vbaproject")) {
        throw new XlsxValidationException("MACRO_OR_EXTERNAL_PART");
      }
    } catch (IOException error) {
      throw new XlsxValidationException("INVALID_XLSX", error);
    }
  }

  private void validateManifest(Map<String, String> values, ManifestExpectation expectation, byte[] signingSecret)
      throws XlsxValidationException {
    if (values.isEmpty()) {
      throw new XlsxValidationException("MANIFEST_MISSING");
    }
    if (values.getOrDefault("signature", "").isBlank()) throw new XlsxValidationException("MANIFEST_SIGNATURE_MISSING");
    if (expectation == null) return;
    String createdAt = values.getOrDefault("createdAt", "");
    try { java.time.Instant.parse(createdAt); }
    catch (Exception error) { throw new XlsxValidationException("MANIFEST_SOURCE_MISMATCH"); }
    String expectedPayload = expectation.exportJobId() + "|" + expectation.snapshotSha256()
        + "|" + expectation.rowCount() + "|" + expectation.documentVersionId()
        + "|" + expectation.signingKeyId() + "|" + expectation.rowMappingSha256()
        + "|" + createdAt + "|" + XlsxWorkbookRenderer.CODE_LIST_VERSION;
    if (!"xlsx-working-v1".equals(values.get("schemaVersion"))
        || !expectation.exportJobId().equals(values.get("exportJobId"))
        || !expectation.documentId().equals(values.get("documentId"))
        || !expectation.documentVersionId().equals(values.get("documentVersionId"))
        || !expectation.snapshotSha256().equals(values.get("snapshotSha256"))
        || !expectation.rowMappingSha256().equals(values.get("rowMappingSha256"))
        || !Integer.toString(expectation.rowCount()).equals(values.get("rowCount"))
        || !XlsxWorkbookRenderer.CODE_LIST_VERSION.equals(values.get("codeListVersion"))
        || !expectation.signingKeyId().equals(values.get("signingKeyId"))
        || !expectedPayload.equals(values.get("signaturePayload"))) {
      throw new XlsxValidationException("MANIFEST_SOURCE_MISMATCH");
    }
    new XlsxManifestCodec().verify(new XlsxManifestCodec.SignedManifest(
        values.get("signaturePayload"), values.get("signature")), signingSecret);
  }

  private static final class FormulaRejectingFilter extends XMLFilterImpl {
    private int column = -1;

    @Override
    public void startElement(String uri, String localName, String qName, Attributes attributes)
        throws SAXException {
      String element = localName == null || localName.isEmpty() ? qName : localName;
      if ("c".equals(element)) {
        String reference = attributes.getValue("r");
        column = reference == null ? -1 : new CellReference(reference).getCol();
      } else if ("f".equals(element) && column >= 7 && column <= 14) {
        throw new SAXException(new ParsingAbort(new XlsxValidationException("FORMULA_IN_EDITABLE_CELL")));
      }
      super.startElement(uri, localName, qName, attributes);
    }
  }

  private static final class SettlementSheetHandler implements XSSFSheetXMLHandler.SheetContentsHandler {
    private final XlsxSecurityPolicy policy;
    private final TextBudget textBudget;
    private final List<ParsedRow> rows = new ArrayList<>();
    private String[] current;
    private int currentRow;
    private boolean extraValue;
    private boolean headerSeen;

    private SettlementSheetHandler(XlsxSecurityPolicy policy, TextBudget textBudget) {
      this.policy = policy; this.textBudget = textBudget;
    }

    @Override public void startRow(int rowNum) {
      currentRow = rowNum; current = new String[HEADERS.size()];
      java.util.Arrays.fill(current, ""); extraValue = false;
    }

    @Override public void endRow(int rowNum) {
      if (currentRow == 0) {
        headerSeen = true;
        if (extraValue || !java.util.Arrays.asList(current).equals(HEADERS)) abort("UNEXPECTED_HEADERS");
        return;
      }
      if (current[0].isBlank()) return;
      if (rows.size() >= policy.maxRows()) abort("ROW_LIMIT");
      rows.add(new ParsedRow(currentRow + 1, current));
    }

    @Override public void cell(String cellReference, String formattedValue, XSSFComment comment) {
      int column = cellReference == null ? -1 : new CellReference(cellReference).getCol();
      String value = formattedValue == null ? "" : formattedValue.trim();
      textBudget.add(value);
      if (column >= 0 && column < current.length) current[column] = value;
      else if (!value.isBlank()) extraValue = true;
    }

    void validateHeader() throws XlsxValidationException {
      if (!headerSeen) throw new XlsxValidationException("UNEXPECTED_HEADERS");
    }
    List<ParsedRow> rows() { return List.copyOf(rows); }
  }

  private static final class ManifestSheetHandler implements XSSFSheetXMLHandler.SheetContentsHandler {
    private final TextBudget textBudget;
    private final Map<String, String> values = new HashMap<>();
    private String key = "";
    private String value = "";

    private ManifestSheetHandler(TextBudget textBudget) { this.textBudget = textBudget; }
    @Override public void startRow(int rowNum) { key = ""; value = ""; }
    @Override public void endRow(int rowNum) { if (!key.isBlank()) values.put(key, value); }
    @Override public void cell(String cellReference, String formattedValue, XSSFComment comment) {
      int column = cellReference == null ? -1 : new CellReference(cellReference).getCol();
      String cell = formattedValue == null ? "" : formattedValue.trim();
      textBudget.add(cell);
      if (column == 0) key = cell;
      else if (column == 1) value = cell;
      else if (!cell.isBlank()) abort("MANIFEST_SOURCE_MISMATCH");
    }
    Map<String, String> values() { return Map.copyOf(values); }
  }

  private static final class CountingSheetHandler implements XSSFSheetXMLHandler.SheetContentsHandler {
    private final TextBudget textBudget;
    private CountingSheetHandler(TextBudget textBudget) { this.textBudget = textBudget; }
    @Override public void startRow(int rowNum) {}
    @Override public void endRow(int rowNum) {}
    @Override public void cell(String cellReference, String formattedValue, XSSFComment comment) {
      textBudget.add(formattedValue == null ? "" : formattedValue.trim());
    }
  }

  private static final class TextBudget {
    private final XlsxSecurityPolicy policy;
    private long characters;
    private TextBudget(XlsxSecurityPolicy policy) { this.policy = policy; }
    private void add(String value) {
      if (value.length() > policy.maxCellCharacters()) abort("CELL_TEXT_LIMIT");
      characters += value.length();
      if (characters > policy.maxWorkbookTextCharacters()) abort("WORKBOOK_TEXT_LIMIT");
    }
  }

  private static void abort(String code) {
    throw new ParsingAbort(new XlsxValidationException(code));
  }

  private static final class ParsingAbort extends RuntimeException {
    private final XlsxValidationException validation;
    private ParsingAbort(XlsxValidationException validation) {
      super(validation); this.validation = validation;
    }
  }

  public record ParsedWorkbook(List<ParsedRow> rows) {}
  public record ParsedRow(int sourceRowNumber, String[] values) {}
  public record ManifestExpectation(String exportJobId, String snapshotSha256, int rowCount,
      String documentId, String documentVersionId, String signingKeyId,
      String rowMappingSha256) {}
}

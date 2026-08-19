package cz.sokol.conversion.xlsx;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;

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
    validateContainer(input, policy);
    try (Workbook workbook = WorkbookFactory.create(input.toFile())) {
      if (workbook.getNumberOfSheets() != REQUIRED_SHEETS.size()) {
        throw new XlsxValidationException("UNEXPECTED_SHEETS");
      }
      for (int index = 0; index < REQUIRED_SHEETS.size(); index++) {
        if (!REQUIRED_SHEETS.get(index).equals(workbook.getSheetName(index))) {
          throw new XlsxValidationException("UNEXPECTED_SHEETS");
        }
      }
      Sheet sheet = workbook.getSheet("Vypořádání");
      Row header = sheet.getRow(0);
      if (header == null || header.getLastCellNum() != HEADERS.size()) {
        throw new XlsxValidationException("UNEXPECTED_HEADERS");
      }
      for (int column = 0; column < HEADERS.size(); column++) {
        if (!HEADERS.get(column).equals(text(header.getCell(column)))) {
          throw new XlsxValidationException("UNEXPECTED_HEADERS");
        }
      }
      List<ParsedRow> rows = new ArrayList<>();
      for (int rowIndex = 1; rowIndex <= sheet.getLastRowNum(); rowIndex++) {
        Row row = sheet.getRow(rowIndex);
        if (row == null || text(row.getCell(0)).isBlank()) continue;
        if (rows.size() >= policy.maxRows()) throw new XlsxValidationException("ROW_LIMIT");
        for (int column = 7; column <= 14; column++) {
          Cell cell = row.getCell(column);
          if (cell != null && cell.getCellType() == CellType.FORMULA) {
            throw new XlsxValidationException("FORMULA_IN_EDITABLE_CELL");
          }
        }
        String[] values = new String[HEADERS.size()];
        for (int column = 0; column < HEADERS.size(); column++) values[column] = text(row.getCell(column));
        rows.add(new ParsedRow(rowIndex + 1, values));
      }
      validateManifest(workbook.getSheet("Manifest"));
      return new ParsedWorkbook(rows);
    } catch (XlsxValidationException error) {
      throw error;
    } catch (Exception error) {
      throw new XlsxValidationException("INVALID_XLSX", error);
    }
  }

  private void validateContainer(Path input, XlsxSecurityPolicy policy) throws Exception {
    if (!Files.exists(input) || Files.size(input) > policy.maxBytes()) throw new XlsxValidationException("FILE_LIMIT");
    byte[] header = Files.readAllBytes(input).length >= 4 ? Files.readAllBytes(input) : new byte[0];
    if (header.length < 4 || header[0] != 'P' || header[1] != 'K') throw new XlsxValidationException("XLSX_REQUIRED");
    try (ZipFile zip = new ZipFile(input.toFile())) {
      long expanded = 0;
      int entries = 0;
      var enumeration = zip.entries();
      while (enumeration.hasMoreElements()) {
        ZipEntry entry = enumeration.nextElement();
        entries++;
        expanded += Math.max(0, entry.getSize());
        if (entries > policy.maxZipEntries() || expanded > policy.maxUncompressedBytes()) {
          throw new XlsxValidationException("ZIP_EXPANSION_LIMIT");
        }
        String name = entry.getName();
        if (BLOCKED_ZIP_PARTS.stream().anyMatch(name::contains) || name.endsWith(".bin")) {
          throw new XlsxValidationException("MACRO_OR_EXTERNAL_PART");
        }
      }
      ZipEntry contentTypes = zip.getEntry("[Content_Types].xml");
      if (contentTypes == null) throw new XlsxValidationException("INVALID_XLSX");
      String content = new String(zip.getInputStream(contentTypes).readAllBytes(), StandardCharsets.UTF_8);
      if (content.contains("macroEnabled") || content.contains("vbaProject")) {
        throw new XlsxValidationException("MACRO_OR_EXTERNAL_PART");
      }
    } catch (IOException error) {
      throw new XlsxValidationException("INVALID_XLSX", error);
    }
  }

  private void validateManifest(Sheet manifest) throws XlsxValidationException {
    if (manifest == null || text(manifest.getRow(0).getCell(0)).isBlank()) {
      throw new XlsxValidationException("MANIFEST_MISSING");
    }
    boolean signature = false;
    for (Row row : manifest) {
      if ("signature".equals(text(row.getCell(0))) && !text(row.getCell(1)).isBlank()) signature = true;
    }
    if (!signature) throw new XlsxValidationException("MANIFEST_SIGNATURE_MISSING");
  }

  private String text(Cell cell) {
    return cell == null ? "" : formatter.formatCellValue(cell).trim();
  }

  public record ParsedWorkbook(List<ParsedRow> rows) {}
  public record ParsedRow(int sourceRowNumber, String[] values) {}
}

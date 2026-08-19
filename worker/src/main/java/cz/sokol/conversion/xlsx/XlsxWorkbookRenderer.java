package cz.sokol.conversion.xlsx;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.DataValidation;
import org.apache.poi.ss.usermodel.DataValidationConstraint;
import org.apache.poi.ss.usermodel.DataValidationHelper;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.HorizontalAlignment;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.SheetVisibility;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.util.CellRangeAddressList;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

public final class XlsxWorkbookRenderer {
  private static final String[] HEADERS = {
      "ID připomínky", "Pořadí bloku", "Text bloku", "Autor", "Organizace", "Datum podání",
      "Text připomínky", "Typ", "Priorita", "Stav", "Výsledek", "Stanovisko",
      "Cílová verze", "Odpovědná osoba", "Datum vypořádání"
  };
  private static final String SHEET_PASSWORD = "sokol-working-xlsx";
  private final ObjectMapper mapper = new ObjectMapper();

  public void render(String snapshotJson, Path output, String exportJobId, byte[] signingSecret)
      throws Exception {
    JsonNode snapshot = mapper.readTree(snapshotJson);
    JsonNode comments = snapshot.path("comments");
    if (!comments.isArray() || comments.size() > 1000) {
      throw new XlsxValidationException("ROW_LIMIT");
    }
    try (Workbook workbook = new XSSFWorkbook()) {
      Sheet instructions = workbook.createSheet("Pokyny");
      Sheet working = workbook.createSheet("Vypořádání");
      Sheet statistics = workbook.createSheet("Statistika");
      Sheet codeLists = workbook.createSheet("Číselníky");
      Sheet manifest = workbook.createSheet("Manifest");
      workbook.setSheetVisibility(3, SheetVisibility.VERY_HIDDEN);
      workbook.setSheetVisibility(4, SheetVisibility.VERY_HIDDEN);
      ((XSSFWorkbook) workbook).lockStructure();

      renderInstructions(instructions, snapshot);
      renderCodeLists(codeLists);
      renderWorking(working, comments, codeLists);
      renderStatistics(statistics, comments.size());

      String snapshotSha256 = HexFormat.of().formatHex(
          MessageDigest.getInstance("SHA-256").digest(snapshotJson.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
      String versionId = snapshot.path("document").path("versionId").asText();
      String payload = exportJobId + "|" + snapshotSha256 + "|" + comments.size() + "|" + versionId;
      XlsxManifestCodec.SignedManifest signed = new XlsxManifestCodec().sign(payload, signingSecret);
      writeManifest(manifest, snapshot, exportJobId, snapshotSha256, signed);

      try (OutputStream outputStream = Files.newOutputStream(output)) {
        workbook.write(outputStream);
      }
    }
  }

  private static void renderInstructions(Sheet sheet, JsonNode snapshot) {
    sheet.createRow(0).createCell(0).setCellValue("Pracovní XLSX pro vypořádání připomínek");
    sheet.createRow(1).createCell(0).setCellValue("Dokument: " + snapshot.path("document").path("number").asText());
    sheet.createRow(2).createCell(0).setCellValue("Editovat lze pouze barevně označená pole v listu Vypořádání.");
    sheet.createRow(3).createCell(0).setCellValue("Po úpravě nahrajte celý sešit zpět v administračním rozhraní.");
    sheet.setColumnWidth(0, 24 * 256);
  }

  private static void renderCodeLists(Sheet sheet) {
    String[][] values = {
        {"Typ", "comment", "proposal", "question"},
        {"Priorita", "low", "normal", "high", "critical"},
        {"Stav", "open", "under_review", "settled", "withdrawn", "hidden"},
        {"Výsledek", "accepted", "partially_accepted", "rejected", "explained_no_change", "duplicate", "out_of_scope", "withdrawn"},
    };
    for (int row = 0; row < values.length; row++) {
      for (int column = 0; column < values[row].length; column++) {
        sheet.createRow(row).createCell(column).setCellValue(values[row][column]);
      }
    }
  }

  private static void renderWorking(Sheet sheet, JsonNode comments, Sheet codeLists) {
    CellStyle header = sheet.getWorkbook().createCellStyle();
    Font headerFont = sheet.getWorkbook().createFont();
    headerFont.setBold(true);
    header.setFont(headerFont);
    header.setFillForegroundColor(IndexedColors.LIGHT_CORNFLOWER_BLUE.getIndex());
    header.setFillPattern(FillPatternType.SOLID_FOREGROUND);
    header.setAlignment(HorizontalAlignment.CENTER);
    CellStyle locked = sheet.getWorkbook().createCellStyle();
    locked.setLocked(true);
    CellStyle editable = sheet.getWorkbook().createCellStyle();
    editable.setLocked(false);
    editable.setFillForegroundColor(IndexedColors.LIGHT_YELLOW.getIndex());
    editable.setFillPattern(FillPatternType.SOLID_FOREGROUND);
    Row headerRow = sheet.createRow(0);
    for (int column = 0; column < HEADERS.length; column++) {
      Cell cell = headerRow.createCell(column);
      cell.setCellValue(HEADERS[column]);
      cell.setCellStyle(header);
    }
    for (int index = 0; index < comments.size(); index++) {
      JsonNode comment = comments.get(index);
      Row row = sheet.createRow(index + 1);
      JsonNode base = comment.path("base");
      JsonNode settlement = base.path("settlement");
      String[] values = {
          comment.path("publicId").asText(), Integer.toString(comment.path("blockOrder").asInt()),
          comment.path("blockText").asText(), comment.path("authorName").asText(),
          comment.path("organizationName").asText(), comment.path("createdAt").asText(),
          comment.path("body").asText(), base.path("type").asText(), base.path("priority").asText(),
          base.path("status").asText(), settlement.isMissingNode() || settlement.isNull() ? "" : settlement.path("outcome").asText(),
          settlement.isMissingNode() || settlement.isNull() ? "" : settlement.path("statement").asText(),
          settlement.isMissingNode() || settlement.isNull() || settlement.path("targetVersionNumber").isNull()
              ? "" : settlement.path("targetVersionNumber").asText(),
          settlement.isMissingNode() || settlement.isNull() ? "" : settlement.path("responsibleAdminName").asText(),
          settlement.isMissingNode() || settlement.isNull() || settlement.path("declaredSettlementDate").isNull()
              ? "" : settlement.path("declaredSettlementDate").asText(),
      };
      for (int column = 0; column < values.length; column++) {
        Cell cell = row.createCell(column);
        cell.setCellValue(values[column]);
        cell.setCellStyle(column >= 7 ? editable : locked);
      }
    }
    DataValidationHelper helper = sheet.getDataValidationHelper();
    addListValidation(sheet, helper, "Číselníky!$B$1:$D$1", 1, Math.max(1, comments.size()), 7);
    addListValidation(sheet, helper, "Číselníky!$B$2:$E$2", 1, Math.max(1, comments.size()), 8);
    addListValidation(sheet, helper, "Číselníky!$B$3:$F$3", 1, Math.max(1, comments.size()), 9);
    addListValidation(sheet, helper, "Číselníky!$B$4:$H$4", 1, Math.max(1, comments.size()), 10);
    sheet.createFreezePane(0, 1);
    sheet.setAutoFilter(new CellRangeAddressList(0, Math.max(1, comments.size()), 0, HEADERS.length - 1).getCellRangeAddress(0));
    for (int column = 0; column < HEADERS.length; column++) sheet.setColumnWidth(column, column == 6 || column == 11 ? 38 * 256 : 18 * 256);
    sheet.protectSheet(SHEET_PASSWORD);
  }

  private static void addListValidation(Sheet sheet, DataValidationHelper helper, String formula, int firstRow, int lastRow, int column) {
    DataValidationConstraint constraint = helper.createFormulaListConstraint(formula);
    DataValidation validation = helper.createValidation(constraint, new CellRangeAddressList(firstRow, lastRow, column, column));
    validation.setShowErrorBox(true);
    sheet.addValidationData(validation);
  }

  private static void renderStatistics(Sheet sheet, int rowCount) {
    sheet.createRow(0).createCell(0).setCellValue("Statistika připomínek");
    sheet.createRow(1).createCell(0).setCellValue("Celkem");
    sheet.getRow(1).createCell(1).setCellFormula("COUNTA(Vypořádání!A2:A" + Math.max(2, rowCount + 1) + ")");
    sheet.createRow(2).createCell(0).setCellValue("Vypořádané");
    sheet.getRow(2).createCell(1).setCellFormula("COUNTIF(Vypořádání!J2:J" + Math.max(2, rowCount + 1) + ",\"settled\")");
  }

  private static void writeManifest(
      Sheet sheet, JsonNode snapshot, String exportJobId, String snapshotSha256,
      XlsxManifestCodec.SignedManifest signed) {
    String[][] values = {
        {"schemaVersion", snapshot.path("schemaVersion").asText()},
        {"exportJobId", exportJobId},
        {"documentId", snapshot.path("document").path("id").asText()},
        {"documentVersionId", snapshot.path("document").path("versionId").asText()},
        {"snapshotSha256", snapshotSha256},
        {"rowCount", Integer.toString(snapshot.path("rowCount").asInt())},
        {"signaturePayload", signed.payload()},
        {"signature", signed.signature()},
    };
    for (int row = 0; row < values.length; row++) {
      sheet.createRow(row).createCell(0).setCellValue(values[row][0]);
      sheet.getRow(row).createCell(1).setCellValue(values[row][1]);
    }
  }
}

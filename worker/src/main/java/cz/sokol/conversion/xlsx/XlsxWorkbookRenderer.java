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
import org.apache.poi.ss.usermodel.ConditionalFormattingRule;
import org.apache.poi.ss.usermodel.DataValidation;
import org.apache.poi.ss.usermodel.DataValidationConstraint;
import org.apache.poi.ss.usermodel.DataValidationHelper;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.HorizontalAlignment;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Name;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.SheetVisibility;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.util.CellRangeAddressList;
import org.apache.poi.ss.util.CellRangeAddress;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

public final class XlsxWorkbookRenderer {
  private static final String[] HEADERS = {
      "ID připomínky", "Pořadí bloku", "Text bloku", "Autor", "Organizace", "Datum podání",
      "Text připomínky", "Typ", "Priorita", "Stav", "Výsledek", "Stanovisko",
      "Cílová verze", "Odpovědná osoba", "Datum vypořádání"
  };
  private static final String SHEET_PASSWORD = "sokol-working-xlsx";
  static final String CODE_LIST_VERSION = "xlsx-codelists-v1";
  private final ObjectMapper mapper = new ObjectMapper();

  public void render(String snapshotJson, Path output, String exportJobId, byte[] signingSecret)
      throws Exception {
    render(snapshotJson, output, exportJobId, "test-key", signingSecret);
  }

  public void render(String snapshotJson, Path output, String exportJobId, String signingKeyId,
      byte[] signingSecret) throws Exception {
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
      createCodeListNames(workbook);
      renderWorking(working, comments, codeLists);
      renderStatistics(statistics, comments.size());

      String snapshotSha256 = XlsxCanonicalJson.sha256(snapshotJson);
      String rowMappingSha256 = XlsxCanonicalJson.sha256(comments.toString());
      String versionId = snapshot.path("document").path("versionId").asText();
      String generatedAt = snapshot.path("generatedAt").asText();
      String payload = exportJobId + "|" + snapshotSha256 + "|" + comments.size() + "|"
          + versionId + "|" + signingKeyId + "|" + rowMappingSha256 + "|"
          + generatedAt + "|" + CODE_LIST_VERSION;
      XlsxManifestCodec.SignedManifest signed = new XlsxManifestCodec().sign(payload, signingSecret);
      writeManifest(manifest, snapshot, exportJobId, snapshotSha256, rowMappingSha256,
          signingKeyId, signed);

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
    sheet.createRow(4).createCell(0).setCellValue("Legenda:");
    CellStyle lockedLegend = sheet.getWorkbook().createCellStyle();
    lockedLegend.setFillForegroundColor(IndexedColors.GREY_25_PERCENT.getIndex());
    lockedLegend.setFillPattern(FillPatternType.SOLID_FOREGROUND);
    Row lockedRow = sheet.createRow(5);
    lockedRow.createCell(0).setCellValue("Uzamčená pole");
    lockedRow.createCell(1).setCellStyle(lockedLegend);
    CellStyle editableLegend = sheet.getWorkbook().createCellStyle();
    editableLegend.setFillForegroundColor(IndexedColors.LIGHT_YELLOW.getIndex());
    editableLegend.setFillPattern(FillPatternType.SOLID_FOREGROUND);
    Row editableRow = sheet.createRow(6);
    editableRow.createCell(0).setCellValue("Editovatelná pole");
    editableRow.createCell(1).setCellStyle(editableLegend);
    sheet.setColumnWidth(0, 48 * 256);
    sheet.setColumnWidth(1, 10 * 256);
  }

  private static void renderCodeLists(Sheet sheet) {
    String[][] values = {
        {"Typ", "comment", "proposal", "question"},
        {"Priorita", "low", "normal", "high", "critical"},
        {"Stav", "open", "under_review", "settled", "withdrawn", "hidden"},
        {"Výsledek", "accepted", "partially_accepted", "rejected", "explained_no_change", "duplicate", "out_of_scope", "withdrawn"},
    };
    for (int row = 0; row < values.length; row++) {
      Row outputRow = sheet.createRow(row);
      for (int column = 0; column < values[row].length; column++) {
        outputRow.createCell(column).setCellValue(values[row][column]);
      }
    }
  }

  private static void createCodeListNames(Workbook workbook) {
    createName(workbook, "TypeList", "'Číselníky'!$B$1:$D$1");
    createName(workbook, "PriorityList", "'Číselníky'!$B$2:$E$2");
    createName(workbook, "StatusList", "'Číselníky'!$B$3:$F$3");
    createName(workbook, "OutcomeList", "'Číselníky'!$B$4:$H$4");
  }

  private static void createName(Workbook workbook, String name, String formula) {
    Name range = workbook.createName();
    range.setNameName(name);
    range.setRefersToFormula(formula);
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
    locked.setWrapText(true);
    CellStyle editable = sheet.getWorkbook().createCellStyle();
    editable.setLocked(false);
    editable.setWrapText(true);
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
    addListValidation(sheet, helper, "TypeList", 1, Math.max(1, comments.size()), 7);
    addListValidation(sheet, helper, "PriorityList", 1, Math.max(1, comments.size()), 8);
    addListValidation(sheet, helper, "StatusList", 1, Math.max(1, comments.size()), 9);
    addListValidation(sheet, helper, "OutcomeList", 1, Math.max(1, comments.size()), 10);
    var formatting = sheet.getSheetConditionalFormatting();
    ConditionalFormattingRule incompleteSettlement = formatting.createConditionalFormattingRule(
        "AND($J2=\"settled\",OR($K2=\"\",$L2=\"\",$N2=\"\",$O2=\"\"))");
    incompleteSettlement.createPatternFormatting().setFillForegroundColor(IndexedColors.ROSE.getIndex());
    incompleteSettlement.getPatternFormatting().setFillPattern(FillPatternType.SOLID_FOREGROUND.getCode());
    ConditionalFormattingRule straySettlement = formatting.createConditionalFormattingRule(
        "AND($J2<>\"settled\",COUNTA($K2:$O2)>0)");
    straySettlement.createPatternFormatting().setFillForegroundColor(IndexedColors.ROSE.getIndex());
    straySettlement.getPatternFormatting().setFillPattern(FillPatternType.SOLID_FOREGROUND.getCode());
    formatting.addConditionalFormatting(
        new CellRangeAddress[]{new CellRangeAddress(1, Math.max(1, comments.size()), 7, 14)},
        incompleteSettlement, straySettlement);
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
    int row = 4;
    row = addStatisticsGroup(sheet, row, "Podle stavu", "J", new String[]{"open", "under_review", "settled", "withdrawn", "hidden"}, rowCount);
    row = addStatisticsGroup(sheet, row + 1, "Podle výsledku", "K", new String[]{"accepted", "partially_accepted", "rejected", "explained_no_change", "duplicate", "out_of_scope", "withdrawn"}, rowCount);
    row = addStatisticsGroup(sheet, row + 1, "Podle typu", "H", new String[]{"comment", "proposal", "question"}, rowCount);
    addStatisticsGroup(sheet, row + 1, "Podle priority", "I", new String[]{"low", "normal", "high", "critical"}, rowCount);
  }

  private static int addStatisticsGroup(Sheet sheet, int row, String title, String column,
      String[] values, int rowCount) {
    sheet.createRow(row++).createCell(0).setCellValue(title);
    int lastDataRow = Math.max(2, rowCount + 1);
    for (String value : values) {
      Row output = sheet.createRow(row++);
      output.createCell(0).setCellValue(value);
      output.createCell(1).setCellFormula(
          "COUNTIF(Vypořádání!" + column + "2:" + column + lastDataRow + ",\"" + value + "\")");
    }
    return row;
  }

  private static void writeManifest(
      Sheet sheet, JsonNode snapshot, String exportJobId, String snapshotSha256,
      String rowMappingSha256, String signingKeyId, XlsxManifestCodec.SignedManifest signed) {
    String[][] values = {
        {"schemaVersion", snapshot.path("schemaVersion").asText()},
        {"exportJobId", exportJobId},
        {"documentId", snapshot.path("document").path("id").asText()},
        {"documentVersionId", snapshot.path("document").path("versionId").asText()},
        {"snapshotSha256", snapshotSha256},
        {"rowMappingSha256", rowMappingSha256},
        {"rowCount", Integer.toString(snapshot.path("rowCount").asInt())},
        {"createdAt", snapshot.path("generatedAt").asText()},
        {"codeListVersion", CODE_LIST_VERSION},
        {"signingKeyId", signingKeyId},
        {"signaturePayload", signed.payload()},
        {"signature", signed.signature()},
    };
    for (int row = 0; row < values.length; row++) {
      sheet.createRow(row).createCell(0).setCellValue(values[row][0]);
      sheet.getRow(row).createCell(1).setCellValue(values[row][1]);
    }
  }
}

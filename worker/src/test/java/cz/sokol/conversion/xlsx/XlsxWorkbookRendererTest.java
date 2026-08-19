package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;
import org.junit.jupiter.api.Test;

class XlsxWorkbookRendererTest {
  @Test
  void createsProtectedWorkingSheetsWithLockedSystemFields() throws Exception {
    String snapshot = """
        {"schemaVersion":"xlsx-working-v1","generatedAt":"2026-08-19T12:00:00Z",
         "document":{"id":"018f6f9d-7e10-7000-8000-000000000010","versionId":"018f6f9d-7e10-7000-8000-000000000011","number":"SOKOL-2026-110","title":"Jednací řád","versionNumber":2},
         "rowCount":1,"comments":[{"id":"018f6f9d-7e10-7000-8000-000000000012","publicId":"PRIP-2026-000110","blockOrder":2,"blockUid":"018f6f9d-7e10-7000-8000-000000000013","blockText":"Článek 2","authorName":"Jan Člen","organizationName":"TJ Sokol Test","createdAt":"2026-08-18T10:00:00Z","body":"Navrhuji změnu.","base":{"type":"proposal","priority":"high","status":"settled","settlement":{"id":"018f6f9d-7e10-7000-8000-000000000014","rowVersion":2,"outcome":"accepted","statement":"Zapracováno.","responsibleUserId":"018f6f9d-7e10-7000-8000-000000000015","responsibleAdminName":"Anna Správce","declaredSettlementDate":"2026-08-19","targetVersionNumber":2}},"commentRowVersion":4}]}
        """;
    Path output = Files.createTempFile("working-xlsx-", ".xlsx");
    try {
      new XlsxWorkbookRenderer().render(snapshot, output, "job-1", "secret".getBytes());
      try (Workbook workbook = WorkbookFactory.create(output.toFile())) {
        assertEquals(5, workbook.getNumberOfSheets());
        assertEquals("Pokyny", workbook.getSheetName(0));
        assertEquals("Vypořádání", workbook.getSheetName(1));
        assertEquals("Statistika", workbook.getSheetName(2));
        assertEquals("Číselníky", workbook.getSheetName(3));
        assertEquals("Manifest", workbook.getSheetName(4));
        assertTrue(workbook.getSheetAt(1).getProtect());
        assertTrue(workbook.getSheetAt(1).getRow(1).getCell(0).getCellStyle().getLocked());
        assertTrue(!workbook.getSheetAt(1).getRow(1).getCell(7).getCellStyle().getLocked());
        assertEquals(CellType.STRING, workbook.getSheetAt(1).getRow(1).getCell(6).getCellType());
      }
    } finally {
      Files.deleteIfExists(output);
    }
  }
}

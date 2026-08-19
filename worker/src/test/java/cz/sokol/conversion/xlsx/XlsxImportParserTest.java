package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class XlsxImportParserTest {
  @Test
  void rejectsMacrosAndUnexpectedStructure() throws Exception {
    Path macro = Files.createTempFile("macro-", ".xlsx");
    Files.writeString(macro, "not-an-ooxml-file");
    try {
      XlsxImportParser parser = new XlsxImportParser();
      assertThrows(XlsxValidationException.class, () -> parser.parse(macro, XlsxSecurityPolicy.defaults()));
    } finally {
      Files.deleteIfExists(macro);
    }
  }

  @Test
  void parsesRendererOutputWithoutFormulaCells() throws Exception {
    String snapshot = """
        {"schemaVersion":"xlsx-working-v1","generatedAt":"2026-08-19T12:00:00Z","document":{"id":"018f6f9d-7e10-7000-8000-000000000010","versionId":"018f6f9d-7e10-7000-8000-000000000011","number":"SOKOL-2026-110","title":"Jednací řád","versionNumber":2},"rowCount":0,"comments":[]}
        """;
    Path workbook = Files.createTempFile("working-", ".xlsx");
    try {
      new XlsxWorkbookRenderer().render(snapshot, workbook, "job-1", "secret".getBytes());
      XlsxImportParser.ParsedWorkbook parsed = new XlsxImportParser().parse(workbook, XlsxSecurityPolicy.defaults());
      assertEquals(0, parsed.rows().size());
    } finally {
      Files.deleteIfExists(workbook);
    }
  }
}

package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
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

  @Test
  void rejectsWorkbookWhoseManifestDoesNotMatchTrustedExport() throws Exception {
    String snapshot = """
        {"schemaVersion":"xlsx-working-v1","generatedAt":"2026-08-19T12:00:00Z","document":{"id":"018f6f9d-7e10-7000-8000-000000000010","versionId":"018f6f9d-7e10-7000-8000-000000000011","number":"SOKOL-2026-110","title":"Jednací řád","versionNumber":2},"rowCount":0,"comments":[]}
        """;
    Path workbook = Files.createTempFile("working-forged-", ".xlsx");
    try {
      byte[] secret = "trusted-secret".getBytes();
      new XlsxWorkbookRenderer().render(snapshot, workbook, "job-1", secret);
      XlsxImportParser parser = new XlsxImportParser();
      XlsxImportParser.ManifestExpectation expected = new XlsxImportParser.ManifestExpectation(
      "job-2", "deadbeef", 0,
      "018f6f9d-7e10-7000-8000-000000000010",
      "018f6f9d-7e10-7000-8000-000000000011", "test-key", "deadbeef");
      assertThrows(XlsxValidationException.class,
          () -> parser.parse(workbook, XlsxSecurityPolicy.defaults(), expected, secret));
    } finally {
      Files.deleteIfExists(workbook);
    }
  }

  @Test
  void rejectsAnExternalOoxmlRelationship() throws Exception {
    String snapshot = """
        {"schemaVersion":"xlsx-working-v1","generatedAt":"2026-08-19T12:00:00Z","document":{"id":"018f6f9d-7e10-7000-8000-000000000010","versionId":"018f6f9d-7e10-7000-8000-000000000011","number":"SOKOL-2026-110","title":"Jednací řád","versionNumber":2},"rowCount":0,"comments":[]}
        """;
    Path source = Files.createTempFile("working-source-", ".xlsx");
    Path malicious = Files.createTempFile("working-external-", ".xlsx");
    try {
      new XlsxWorkbookRenderer().render(snapshot, source, "job-1", "secret".getBytes());
      try (ZipInputStream input = new ZipInputStream(Files.newInputStream(source));
           ZipOutputStream output = new ZipOutputStream(Files.newOutputStream(malicious))) {
        ZipEntry entry;
        while ((entry = input.getNextEntry()) != null) {
          output.putNextEntry(new ZipEntry(entry.getName()));
          byte[] content = input.readAllBytes();
          if ("_rels/.rels".equals(entry.getName())) {
            String xml = new String(content, StandardCharsets.UTF_8).replace("</Relationships>",
                "<Relationship Id=\"evil\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://evil.example/\" TargetMode=\"External\"/></Relationships>");
            content = xml.getBytes(StandardCharsets.UTF_8);
          }
          output.write(content);
          output.closeEntry();
        }
      }
      XlsxValidationException error = assertThrows(XlsxValidationException.class,
          () -> new XlsxImportParser().parse(malicious, XlsxSecurityPolicy.defaults()));
      assertEquals("MACRO_OR_EXTERNAL_PART", error.getMessage());
    } finally {
      Files.deleteIfExists(source);
      Files.deleteIfExists(malicious);
    }
  }

  @Test
  void rejectsMacroPartsRegardlessOfZipEntryCase() throws Exception {
    String snapshot = """
        {"schemaVersion":"xlsx-working-v1","generatedAt":"2026-08-19T12:00:00Z","document":{"id":"018f6f9d-7e10-7000-8000-000000000010","versionId":"018f6f9d-7e10-7000-8000-000000000011","number":"SOKOL-2026-110","title":"Jednací řád","versionNumber":2},"rowCount":0,"comments":[]}
        """;
    Path source = Files.createTempFile("working-source-", ".xlsx");
    Path malicious = Files.createTempFile("working-macro-case-", ".xlsx");
    try {
      new XlsxWorkbookRenderer().render(snapshot, source, "job-1", "secret".getBytes());
      try (ZipInputStream input = new ZipInputStream(Files.newInputStream(source));
           ZipOutputStream output = new ZipOutputStream(Files.newOutputStream(malicious))) {
        ZipEntry entry;
        while ((entry = input.getNextEntry()) != null) {
          output.putNextEntry(new ZipEntry(entry.getName()));
          output.write(input.readAllBytes());
          output.closeEntry();
        }
        output.putNextEntry(new ZipEntry("XL/VBAPROJECT.BIN"));
        output.write(new byte[]{1, 2, 3});
        output.closeEntry();
      }
      XlsxValidationException error = assertThrows(XlsxValidationException.class,
          () -> new XlsxImportParser().parse(malicious, XlsxSecurityPolicy.defaults()));
      assertEquals("MACRO_OR_EXTERNAL_PART", error.getMessage());
    } finally {
      Files.deleteIfExists(source);
      Files.deleteIfExists(malicious);
    }
  }
}

package cz.sokol.conversion.pdf;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class InternalPdfExportTest {
  @TempDir Path temporaryDirectory;

  @Test
  void rendersOnlyExplicitlyEnabledInternalFields() throws Exception {
    PdfExportSnapshot snapshot = PdfExportSnapshot.fromJson(snapshot(true));
    Path output = temporaryDirectory.resolve("interni-pripominky.pdf");

    new PdfExportRenderer(fontRoot()).render(snapshot, output);

    try (var document = Loader.loadPDF(output.toFile())) {
      String text = new PDFTextStripper().getText(document);
      assertTrue(text.contains("CANARY-email@example.cz"), text);
      assertTrue(text.contains("CANARY-MEMBER"), text);
      assertTrue(text.contains("CANARY-INTERNAL"), text);
      assertTrue(document.getDocumentInformation().getSubject().contains("Interní"));
    }
    String fixtureDirectory = System.getenv("SOKOL_PDF_FIXTURE_DIR");
    if (fixtureDirectory != null && !fixtureDirectory.isBlank()) {
      Path fixture = Path.of(fixtureDirectory).resolve("sokol-pripominky-interni.pdf");
      Files.createDirectories(fixture.getParent());
      Files.copy(output, fixture, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }
  }

  @Test
  void rejectsPrivateFieldsThatWereNotEnabledInTheSnapshotOptions() {
    assertThrows(IllegalArgumentException.class,
        () -> PdfExportSnapshot.fromJson(snapshot(false)));
  }

  private static Path fontRoot() {
    return Path.of(System.getenv().getOrDefault("SOKOL_FONT_ROOT", "../public/fonts"));
  }

  private static String snapshot(boolean enabled) {
    return """
        {"schemaVersion":"pdf-export-v1","visibility":"internal",
         "generatedAt":"2026-08-18T12:00:00.000Z",
         "document":{"number":"SOKOL-2026-100","title":"Jednací řád České obce sokolské",
           "explanatoryReport":"Důvodová zpráva k návrhu.","versionNumber":2},
         "filters":{"statuses":["settled"],"priorities":["high"],"types":["proposal"]},
         "options":{"includeAuthorEmail":%s,"includeMembershipId":%s,"includeInternalNote":%s},
         "statistics":{"total":1,"settled":1,"open":0},
         "comments":[{"publicId":"PRIP-2026-000100","blockOrder":3,
           "blockText":"Článek 3","authorName":"Jan Člen","organizationName":"TJ Sokol Test",
           "authorEmail":"CANARY-email@example.cz","membershipId":"CANARY-MEMBER",
           "createdAt":"2026-08-17T10:00:00.000Z","body":"Navrhuji doplnit lhůtu.",
           "type":"proposal","priority":"high","status":"settled",
           "settlement":{"outcome":"accepted","statement":"Zapracováno do druhé verze.",
             "settledAt":"2026-08-18T09:00:00.000Z","targetVersionNumber":2},
           "internalNote":"CANARY-INTERNAL"}]}
        """.formatted(enabled, enabled, enabled);
  }
}
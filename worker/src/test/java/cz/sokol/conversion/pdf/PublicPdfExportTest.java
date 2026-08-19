package cz.sokol.conversion.pdf;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PublicPdfExportTest {
  @TempDir Path temporaryDirectory;

  @Test
  void rendersAReadableMultipageCzechPublicExportWithoutPrivateFields() throws Exception {
    PdfExportSnapshot snapshot = PdfExportSnapshot.fromJson(publicSnapshot(45));
    Path output = temporaryDirectory.resolve("verejne-pripominky.pdf");

    new PdfExportRenderer(fontRoot()).render(snapshot, output);

    assertTrue(Files.size(output) > 4_000);
    try (var document = Loader.loadPDF(output.toFile())) {
      String text = new PDFTextStripper().getText(document);
      assertTrue(document.getNumberOfPages() >= 3);
      assertTrue(text.contains("Přehled připomínek"), text);
      assertTrue(text.contains("České obce sokolské"), text);
      assertTrue(text.contains("Navrhuji zpřesnit článek číslo 45"), text);
      assertFalse(text.contains("CANARY-email"));
      assertFalse(text.contains("CANARY-MEMBER"));
      assertFalse(text.contains("CANARY-INTERNAL"));
      assertTrue(document.getDocumentCatalog().getDocumentOutline() != null);
    }
    String bytes = new String(Files.readAllBytes(output), StandardCharsets.ISO_8859_1);
    assertFalse(bytes.contains("CANARY"));

    String fixtureDirectory = System.getenv("SOKOL_PDF_FIXTURE_DIR");
    if (fixtureDirectory != null && !fixtureDirectory.isBlank()) {
      Path fixture = Path.of(fixtureDirectory).resolve("sokol-pripominky-verejne.pdf");
      Files.createDirectories(fixture.getParent());
      Files.copy(output, fixture, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }
  }

  @Test
  void rejectsForbiddenFieldsBeforeRenderingAPublicExport() {
    String unsafe = publicSnapshot(1).replace(
        "\"organizationName\":\"TJ Sokol Test\",",
        "\"organizationName\":\"TJ Sokol Test\","
            + "\"authorEmail\":\"CANARY-email@example.cz\","
            + "\"membershipId\":\"CANARY-MEMBER\",")
        .replace(
            "\"targetVersionNumber\":2",
            "\"targetVersionNumber\":2,\"internalNote\":\"CANARY-INTERNAL\"");

    assertThrows(IllegalArgumentException.class, () -> PdfExportSnapshot.fromJson(unsafe));
  }

  private static Path fontRoot() {
    return Path.of(System.getenv().getOrDefault("SOKOL_FONT_ROOT", "../public/fonts"));
  }

  private static String publicSnapshot(int count) {
    StringBuilder comments = new StringBuilder();
    for (int index = 1; index <= count; index++) {
      if (index > 1) comments.append(',');
      comments.append("""
          {"publicId":"PRIP-2026-%06d","blockOrder":%d,
           "blockText":"Článek %d – působnost jednoty",
           "authorName":"Jan Člen","organizationName":"TJ Sokol Test",
           "createdAt":"2026-08-17T10:00:00.000Z",
           "body":"Navrhuji zpřesnit článek číslo %d kvůli srozumitelnosti a českým znakům č, ř, ž.",
           "type":"proposal","priority":"high","status":"settled",
           "settlement":{"outcome":"accepted","statement":"Zapracováno do druhé verze.",
             "settledAt":"2026-08-18T09:00:00.000Z","targetVersionNumber":2}}
          """.formatted(index, index, index, index));
    }
    return """
        {"schemaVersion":"pdf-export-v1","visibility":"public","generatedAt":"2026-08-18T12:00:00.000Z",
         "document":{"number":"SOKOL-2026-100","title":"Jednací řád České obce sokolské",
           "explanatoryReport":"Důvodová zpráva k návrhu.","versionNumber":2},
         "filters":{"statuses":[],"priorities":[],"types":[]},"options":{"includeAuthorEmail":false,"includeMembershipId":false,"includeInternalNote":false},"statistics":{"total":%d,"settled":%d,"open":0},"comments":[%s]}
        """.formatted(count, count, comments);
  }
}
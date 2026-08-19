package cz.sokol.conversion.pdf;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.Set;
import org.apache.pdfbox.Loader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PdfAValidationTest {
  @TempDir Path temporaryDirectory;

  @Test
  void rendererAddsPdfA2uMetadataAndAnOutputIntent() throws Exception {
    Path output = temporaryDirectory.resolve("pdfa.pdf");
    new PdfExportRenderer(fontRoot()).render(PdfExportSnapshot.fromJson(minimalSnapshot()), output);

    try (var document = Loader.loadPDF(output.toFile())) {
      assertTrue(document.getVersion() >= 1.7f);
      assertFalse(document.getDocumentCatalog().getOutputIntents().isEmpty());
      byte[] metadata = document.getDocumentCatalog().getMetadata().toByteArray();
      String xmp = new String(metadata, StandardCharsets.UTF_8);
      assertTrue(xmp.contains("pdfaid:part=\"2\""), xmp);
      assertTrue(xmp.contains("pdfaid:conformance=\"U\""), xmp);
    }
  }

  @Test
  void externalValidatorControlsWhetherTheArtifactIsAccepted() throws Exception {
    Path passing = script("passing.sh", "echo 'PASS PDF/A-2u'\nexit 0\n");
    Path failing = script("failing.sh", "echo 'FAIL PDF/A-2u'\nexit 1\n");
    Path candidate = Files.writeString(temporaryDirectory.resolve("candidate.pdf"), "%PDF");

    PdfAValidator.Validation passed = new PdfAValidator(
        java.util.List.of(passing.toString()), Duration.ofSeconds(5)).validate(candidate);
    PdfAValidator.Validation failed = new PdfAValidator(
        java.util.List.of(failing.toString()), Duration.ofSeconds(5)).validate(candidate);

    assertTrue(passed.valid());
    assertFalse(failed.valid());
    assertTrue(failed.report().contains("FAIL"));
  }

  private Path script(String name, String body) throws Exception {
    Path script = Files.writeString(temporaryDirectory.resolve(name), "#!/bin/sh\n" + body);
    Files.setPosixFilePermissions(script, Set.of(
        PosixFilePermission.OWNER_READ,
        PosixFilePermission.OWNER_WRITE,
        PosixFilePermission.OWNER_EXECUTE));
    return script;
  }

  private static Path fontRoot() {
    return Path.of(System.getenv().getOrDefault("SOKOL_FONT_ROOT", "../public/fonts"));
  }

  private static String minimalSnapshot() {
    return """
        {"schemaVersion":"pdf-export-v1","visibility":"public",
         "generatedAt":"2026-08-18T12:00:00.000Z",
         "document":{"number":"SOKOL-2026-100","title":"Jednací řád",
           "explanatoryReport":"Důvodová zpráva.","versionNumber":2},
         "filters":{"statuses":[],"priorities":[],"types":[]},
         "options":{"includeAuthorEmail":false,"includeMembershipId":false,"includeInternalNote":false},
         "statistics":{"total":0,"settled":0,"open":0},"comments":[]}
        """;
  }
}
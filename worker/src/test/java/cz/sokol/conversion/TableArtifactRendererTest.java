package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import cz.sokol.conversion.model.ConversionResult;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TableArtifactRendererTest {
  @TempDir Path temporaryDirectory;

  @Test
  void isolatesEveryTableCreatesCroppedImagesAndReportsTextMismatch() throws Exception {
    Path fixture = Path.of(System.getenv().getOrDefault(
        "SOKOL_FIXTURE_ROOT", "../test/fixtures/docx")).resolve("complex-tables.docx");
    ConversionResult parsed = new DocxParser(Instant.parse("2026-08-17T08:00:00Z"))
        .parse(fixture, "a".repeat(64), "docx-web-v1");
    var renderer = new LibreOfficeRenderer(command -> {
      assertEquals(1, new TableComplexityAnalyzer().analyze(
          command.arguments().stream().map(Path::of)
              .filter(path -> path.toString().endsWith(".docx")).findFirst().orElseThrow(),
          java.util.Set.of()).size());
      Path pdf = command.workingDirectory().resolve("table.pdf");
      Files.writeString(pdf, "%PDF-isolated");
      return new LibreOfficeRenderer.ProcessResult(0, false, "converted");
    });
    var images = new TableImageExtractor(command -> {
      BufferedImage page = new BufferedImage(80, 60, BufferedImage.TYPE_INT_RGB);
      var graphics = page.createGraphics();
      graphics.setColor(Color.WHITE);
      graphics.fillRect(0, 0, 80, 60);
      graphics.setColor(Color.BLACK);
      graphics.fillRect(10, 10, 40, 20);
      graphics.dispose();
      ImageIO.write(page, "png", Path.of(command.outputPrefix() + ".png").toFile());
      return new TableImageExtractor.ProcessResult(0, false);
    });
    var text = new PdfTextExtractor((pdf, output) -> {
      int ordinal = Integer.parseInt(pdf.getParent().getFileName().toString().substring(6));
      String expected = parsed.blocks().stream().filter(block -> block.type().equals("table"))
          .toList().get(ordinal).plainText();
      Files.writeString(output, ordinal == 1 ? "jiný text" : expected.replace(" | ", "  "));
      return new PdfTextExtractor.ProcessResult(0, false);
    });

    var result = new TableArtifactRenderer(renderer, images, text).generate(
        fixture, parsed.blocks(), temporaryDirectory.resolve("tables"));

    assertEquals(3, result.images().size());
    assertEquals(java.util.Set.of(1), result.renderMismatches());
    assertTrue(result.images().stream().allMatch(image -> Files.isRegularFile(image.path())));
    assertFalse(result.images().stream().anyMatch(image -> image.sha256().isBlank()));
  }
}

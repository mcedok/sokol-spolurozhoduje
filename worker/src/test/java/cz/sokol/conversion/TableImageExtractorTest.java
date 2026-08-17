package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Color;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TableImageExtractorTest {
  @TempDir Path temporaryDirectory;

  @Test
  void rendersOnePdfPageAndCropsTheRequestedTableArea() throws Exception {
    Path pdf = Files.write(temporaryDirectory.resolve("reference.pdf"), "%PDF".getBytes());
    Path output = temporaryDirectory.resolve("table.png");
    var captured = new AtomicReference<TableImageExtractor.Command>();
    TableImageExtractor.CommandRunner runner = command -> {
      captured.set(command);
      BufferedImage page = new BufferedImage(100, 80, BufferedImage.TYPE_INT_RGB);
      var graphics = page.createGraphics();
      graphics.setColor(Color.WHITE);
      graphics.fillRect(0, 0, 100, 80);
      graphics.setColor(Color.RED);
      graphics.fillRect(10, 5, 30, 20);
      graphics.dispose();
      ImageIO.write(page, "png", Path.of(command.outputPrefix() + ".png").toFile());
      return new TableImageExtractor.ProcessResult(0, false);
    };

    var result = new TableImageExtractor(runner).extract(
        pdf, 2, new TableImageExtractor.CropBox(10, 5, 30, 20), output);

    assertEquals(30, result.width());
    assertEquals(20, result.height());
    assertEquals(64, result.sha256().length());
    assertEquals(Duration.ofSeconds(60), captured.get().timeout());
    assertTrue(captured.get().arguments().containsAll(java.util.List.of("-f", "2", "-l", "2")));
    assertEquals(Color.RED.getRGB(), ImageIO.read(output.toFile()).getRGB(0, 0));
  }

  @Test
  void rejectsACropOutsideTheRenderedPageWithAStableCode() throws Exception {
    Path pdf = Files.write(temporaryDirectory.resolve("reference.pdf"), "%PDF".getBytes());
    TableImageExtractor extractor = new TableImageExtractor(command -> {
      BufferedImage page = new BufferedImage(10, 10, BufferedImage.TYPE_INT_RGB);
      ImageIO.write(page, "png", Path.of(command.outputPrefix() + ".png").toFile());
      return new TableImageExtractor.ProcessResult(0, false);
    });

    var error = assertThrows(TableImageExtractor.ExtractionException.class, () -> extractor.extract(
        pdf, 1, new TableImageExtractor.CropBox(8, 8, 5, 5), temporaryDirectory.resolve("bad.png")));

    assertEquals("TABLE_IMAGE_CROP_INVALID", error.code());
  }

  @Test
  void automaticallyCropsWhitespaceAroundAnIsolatedTable() throws Exception {
    Path pdf = Files.write(temporaryDirectory.resolve("isolated-table.pdf"), "%PDF".getBytes());
    Path output = temporaryDirectory.resolve("auto-table.png");
    TableImageExtractor extractor = new TableImageExtractor(command -> {
      BufferedImage page = new BufferedImage(120, 90, BufferedImage.TYPE_INT_RGB);
      var graphics = page.createGraphics();
      graphics.setColor(Color.WHITE);
      graphics.fillRect(0, 0, 120, 90);
      graphics.setColor(Color.BLACK);
      graphics.fillRect(20, 15, 50, 30);
      graphics.dispose();
      ImageIO.write(page, "png", Path.of(command.outputPrefix() + ".png").toFile());
      return new TableImageExtractor.ProcessResult(0, false);
    });

    var result = extractor.extractContent(pdf, 1, output);

    assertEquals(66, result.width());
    assertEquals(46, result.height());
    assertEquals(Color.BLACK.getRGB(), ImageIO.read(output.toFile()).getRGB(8, 8));
  }
}

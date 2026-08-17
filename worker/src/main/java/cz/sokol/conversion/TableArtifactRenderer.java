package cz.sokol.conversion;

import cz.sokol.conversion.model.ConversionResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class TableArtifactRenderer implements ConversionProcessor.TableArtifactGenerator {
  private final LibreOfficeRenderer renderer;
  private final TableImageExtractor images;
  private final PdfTextExtractor text;

  public TableArtifactRenderer(
      LibreOfficeRenderer renderer, TableImageExtractor images, PdfTextExtractor text) {
    this.renderer = renderer;
    this.images = images;
    this.text = text;
  }

  @Override public ConversionProcessor.GeneratedTableArtifacts generate(
      Path originalDocx, List<ConversionResult.Block> blocks, Path outputDirectory) throws Exception {
    List<ConversionResult.Block> tables = blocks.stream()
        .filter(block -> "table".equals(block.type())).toList();
    Files.createDirectories(outputDirectory);
    List<ConversionProcessor.GeneratedTableImage> generated = new ArrayList<>();
    Set<Integer> mismatches = new HashSet<>();
    TableDocumentExtractor extractor = new TableDocumentExtractor();
    for (int index = 0; index < tables.size(); index += 1) {
      Path tableDirectory = Files.createDirectory(outputDirectory.resolve("table-" + index));
      Path isolated = tableDirectory.resolve("table.docx");
      extractor.extract(originalDocx, index, isolated);
      LibreOfficeRenderer.RenderedPdf rendered = renderer.render(isolated, tableDirectory);
      String renderedText = text.extract(rendered.path(), tableDirectory.resolve("table.txt"));
      if (!canonical(tables.get(index).plainText()).equals(canonical(renderedText))) {
        mismatches.add(index);
      }
      TableImageExtractor.ExtractedImage image = images.extractContent(
          rendered.path(), 1, tableDirectory.resolve("table.png"));
      generated.add(new ConversionProcessor.GeneratedTableImage(
          index, image.path(), image.sha256(), image.width(), image.height()));
    }
    return new ConversionProcessor.GeneratedTableArtifacts(
        List.copyOf(generated), Set.copyOf(mismatches));
  }

  private static String canonical(String value) {
    return Normalizer.normalize(value, Normalizer.Form.NFC)
        .replace("|", "").replaceAll("\\s+", "").trim();
  }
}

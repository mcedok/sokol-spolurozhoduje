package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class TableComplexityAnalyzerTest {
  private static final Path FIXTURES = Path.of(System.getenv().getOrDefault(
      "SOKOL_FIXTURE_ROOT", "../test/fixtures/docx"));
  private final TableComplexityAnalyzer analyzer = new TableComplexityAnalyzer();

  @Test
  void keepsTheDocumentedScoreBoundariesStable() {
    assertRecommendation(metrics(3, 0, 5, 20, 0, false), 9, "html");
    assertRecommendation(metrics(0, 1, 5, 20, 0, false), 10, "image_with_attachment");
    assertRecommendation(metrics(3, 1, 5, 20, 2, false), 29, "image_with_attachment");
    assertRecommendation(metrics(0, 0, 25, 220, 1, true), 40, "attachment_only");
  }

  @Test
  void exposesEachReasonThatContributedToTheRecommendation() {
    var result = analyzer.analyze(metrics(2, 1, 21, 201, 3, true));

    assertEquals(66, result.score());
    assertEquals(6, result.reasons().size());
    assertTrue(result.reasons().stream().anyMatch(reason -> reason.code().equals("MERGED_CELLS")));
    assertTrue(result.reasons().stream().anyMatch(reason -> reason.code().equals("RENDER_MISMATCH")));
  }

  @Test
  void derivesAllThreeRecommendationsFromTheDocxFixture() throws Exception {
    var recommendations = analyzer.analyze(FIXTURES.resolve("complex-tables.docx")).stream()
        .map(result -> result.recommendation().code())
        .toList();

    assertEquals(
        java.util.List.of("html", "image_with_attachment", "attachment_only"),
        recommendations);
  }

  private void assertRecommendation(
      TableComplexityAnalyzer.Metrics metrics, int score, String recommendation) {
    var result = analyzer.analyze(metrics);
    assertEquals(score, result.score());
    assertEquals(recommendation, result.recommendation().code());
  }

  private static TableComplexityAnalyzer.Metrics metrics(
      int merges, int nested, int columns, int rows, int richCellFeatures,
      boolean renderMismatch) {
    return new TableComplexityAnalyzer.Metrics(
        merges, nested, columns, rows, richCellFeatures, renderMismatch);
  }
}

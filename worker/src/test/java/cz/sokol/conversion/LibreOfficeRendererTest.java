package cz.sokol.conversion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LibreOfficeRendererTest {
  @TempDir Path temporaryDirectory;

  @Test
  void invokesLibreOfficeWithAnIsolatedProfileAndReturnsThePdfDigest() throws Exception {
    Path docx = Files.write(temporaryDirectory.resolve("source.docx"), new byte[] {1, 2, 3});
    Path jobDirectory = Files.createDirectory(temporaryDirectory.resolve("job"));
    var captured = new AtomicReference<LibreOfficeRenderer.Command>();
    LibreOfficeRenderer.CommandRunner runner = command -> {
      captured.set(command);
      Files.write(jobDirectory.resolve("source.pdf"), "%PDF-1.7".getBytes());
      return new LibreOfficeRenderer.ProcessResult(0, false, "converted");
    };

    var result = new LibreOfficeRenderer(runner).render(docx, jobDirectory);

    assertEquals(jobDirectory.resolve("source.pdf"), result.path());
    assertEquals(64, result.sha256().length());
    assertEquals(Duration.ofSeconds(180), captured.get().timeout());
    assertEquals(jobDirectory, captured.get().workingDirectory());
    assertTrue(captured.get().arguments().contains("--headless"));
    assertTrue(captured.get().arguments().contains("--convert-to"));
    assertTrue(captured.get().arguments().stream()
        .anyMatch(value -> value.startsWith("-env:UserInstallation=file:")));
  }

  @Test
  void reportsOnlyAStableCodeWhenLibreOfficeTimesOut() throws Exception {
    Path docx = Files.write(temporaryDirectory.resolve("private-name.docx"), new byte[] {1});
    Path jobDirectory = Files.createDirectory(temporaryDirectory.resolve("timeout-job"));
    var renderer = new LibreOfficeRenderer(command ->
        new LibreOfficeRenderer.ProcessResult(-1, true, "secret /private/path"));

    var error = assertThrows(
        LibreOfficeRenderer.RenderException.class,
        () -> renderer.render(docx, jobDirectory));

    assertEquals("RENDER_TIMEOUT", error.code());
    assertFalse(error.getMessage().contains("private"));
  }
}

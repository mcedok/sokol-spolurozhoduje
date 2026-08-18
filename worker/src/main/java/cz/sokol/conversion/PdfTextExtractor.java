package cz.sokol.conversion;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

public final class PdfTextExtractor {
  private static final Duration TIMEOUT = Duration.ofSeconds(60);
  private final CommandRunner runner;

  public PdfTextExtractor() {
    this(new SystemCommandRunner());
  }

  PdfTextExtractor(CommandRunner runner) {
    this.runner = runner;
  }

  public String extract(Path pdf, Path output) throws Exception {
    Path target = output.toAbsolutePath().normalize();
    Files.createDirectories(target.getParent());
    ProcessResult process = runner.run(pdf.toAbsolutePath().normalize(), target);
    if (process.timedOut()) throw new TextExtractionException("TABLE_TEXT_TIMEOUT");
    if (process.exitCode() != 0 || !Files.isRegularFile(target)) {
      throw new TextExtractionException("TABLE_TEXT_FAILED");
    }
    return Files.readString(target);
  }

  @FunctionalInterface
  interface CommandRunner {
    ProcessResult run(Path pdf, Path output) throws Exception;
  }

  record ProcessResult(int exitCode, boolean timedOut) {}

  public static final class TextExtractionException extends IOException {
    private final String code;

    TextExtractionException(String code) {
      super("Kontrola textu tabulky selhala (" + code + ").");
      this.code = code;
    }

    public String code() { return code; }
  }

  private static final class SystemCommandRunner implements CommandRunner {
    @Override public ProcessResult run(Path pdf, Path output) throws Exception {
      ProcessBuilder builder = new ProcessBuilder(List.of(
          "pdftotext", "-layout", pdf.toString(), output.toString()));
      builder.directory(output.getParent().toFile());
      builder.redirectErrorStream(true);
      Path log = Files.createTempFile(output.getParent(), "pdftotext-", ".log");
      try {
        builder.redirectOutput(log.toFile());
        Process process = builder.start();
        boolean completed = process.waitFor(TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        if (!completed) {
          process.destroyForcibly();
          process.waitFor(10, TimeUnit.SECONDS);
          return new ProcessResult(-1, true);
        }
        return new ProcessResult(process.exitValue(), false);
      } finally {
        Files.deleteIfExists(log);
      }
    }
  }
}

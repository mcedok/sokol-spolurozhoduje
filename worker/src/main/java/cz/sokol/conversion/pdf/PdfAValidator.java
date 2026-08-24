package cz.sokol.conversion.pdf;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

public final class PdfAValidator {
  private final List<String> command;
  private final Duration timeout;

  public PdfAValidator(List<String> command, Duration timeout) {
    if (command == null || command.isEmpty()) throw new IllegalArgumentException("Chybí příkaz veraPDF.");
    if (timeout == null || timeout.isNegative() || timeout.isZero()) {
      throw new IllegalArgumentException("Časový limit validace musí být kladný.");
    }
    this.command = List.copyOf(command);
    this.timeout = timeout;
  }

  public Validation validate(Path candidate) throws IOException, InterruptedException {
    Path pdf = candidate.toAbsolutePath().normalize();
    if (!Files.isRegularFile(pdf)) throw new IOException("PDF k validaci neexistuje.");
    List<String> arguments = new ArrayList<>(command);
    arguments.add("--format");
    arguments.add("text");
    arguments.add("--flavour");
    arguments.add("2u");
    arguments.add(pdf.toString());
    Process process = new ProcessBuilder(arguments).redirectErrorStream(true).start();
    boolean finished = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
    if (!finished) {
      process.destroyForcibly();
      process.waitFor();
      return new Validation(false, "veraPDF překročil časový limit.", -1);
    }
    String report = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    String normalized = report.toUpperCase(Locale.ROOT);
    boolean valid = process.exitValue() == 0 && normalized.contains("PASS")
        && !normalized.contains("FAIL");
    return new Validation(valid, report, process.exitValue());
  }

  public record Validation(boolean valid, String report, int exitCode) {}
}
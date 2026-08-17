package cz.sokol.conversion;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.TimeUnit;

public final class LibreOfficeRenderer {
  private static final Duration TIMEOUT = Duration.ofSeconds(180);
  private final CommandRunner runner;

  public LibreOfficeRenderer() {
    this(new SystemCommandRunner());
  }

  LibreOfficeRenderer(CommandRunner runner) {
    this.runner = runner;
  }

  public RenderedPdf render(Path docx, Path jobDirectory) throws Exception {
    Path workingDirectory = jobDirectory.toAbsolutePath().normalize();
    Files.createDirectories(workingDirectory);
    Path profile = workingDirectory.resolve("libreoffice-profile");
    if (Files.exists(profile)) {
      try (var entries = Files.list(profile)) {
        if (entries.findAny().isPresent()) throw new RenderException("RENDER_PROFILE_NOT_EMPTY");
      }
    } else {
      Files.createDirectory(profile);
    }
    Path input = docx.toAbsolutePath().normalize();
    List<String> arguments = List.of(
        "soffice",
        "-env:UserInstallation=" + profile.toUri(),
        "--headless", "--nologo", "--nodefault", "--nolockcheck", "--nofirststartwizard",
        "--convert-to", "pdf", "--outdir", workingDirectory.toString(), input.toString());
    ProcessResult process = runner.run(new Command(arguments, workingDirectory, TIMEOUT));
    if (process.timedOut()) throw new RenderException("RENDER_TIMEOUT");
    if (process.exitCode() != 0) throw new RenderException("RENDER_FAILED");
    String fileName = input.getFileName().toString();
    int extension = fileName.toLowerCase(java.util.Locale.ROOT).lastIndexOf(".docx");
    String baseName = extension < 0 ? fileName : fileName.substring(0, extension);
    Path pdf = workingDirectory.resolve(baseName + ".pdf");
    if (!Files.isRegularFile(pdf)) throw new RenderException("RENDER_OUTPUT_MISSING");
    return new RenderedPdf(pdf, sha256(pdf));
  }

  private static String sha256(Path path) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (var input = Files.newInputStream(path)) {
      byte[] buffer = new byte[64 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) if (count > 0) digest.update(buffer, 0, count);
    }
    return HexFormat.of().formatHex(digest.digest());
  }

  @FunctionalInterface
  interface CommandRunner {
    ProcessResult run(Command command) throws Exception;
  }

  record Command(List<String> arguments, Path workingDirectory, Duration timeout) {}
  record ProcessResult(int exitCode, boolean timedOut, String output) {}
  public record RenderedPdf(Path path, String sha256) {}

  public static final class RenderException extends IOException {
    private final String code;

    RenderException(String code) {
      super("Referenční render selhal (" + code + ").");
      this.code = code;
    }

    public String code() { return code; }
  }

  private static final class SystemCommandRunner implements CommandRunner {
    @Override public ProcessResult run(Command command) throws Exception {
      Path log = Files.createTempFile(command.workingDirectory(), "soffice-", ".log");
      try {
        ProcessBuilder builder = new ProcessBuilder(new ArrayList<>(command.arguments()));
        builder.directory(command.workingDirectory().toFile());
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        Process process = builder.start();
        boolean completed = process.waitFor(command.timeout().toMillis(), TimeUnit.MILLISECONDS);
        if (!completed) {
          process.destroyForcibly();
          process.waitFor(10, TimeUnit.SECONDS);
          return new ProcessResult(-1, true, "");
        }
        byte[] output = Files.readAllBytes(log);
        int length = Math.min(output.length, 8192);
        return new ProcessResult(process.exitValue(), false,
            new String(output, 0, length, java.nio.charset.StandardCharsets.UTF_8));
      } finally {
        Files.deleteIfExists(log);
      }
    }
  }
}

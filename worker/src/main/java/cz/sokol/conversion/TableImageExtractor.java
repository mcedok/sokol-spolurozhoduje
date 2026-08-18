package cz.sokol.conversion;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;

public final class TableImageExtractor {
  private static final Duration TIMEOUT = Duration.ofSeconds(60);
  private final CommandRunner runner;

  public TableImageExtractor() {
    this(new SystemCommandRunner());
  }

  TableImageExtractor(CommandRunner runner) {
    this.runner = runner;
  }

  public ExtractedImage extract(
      Path pdf, int page, CropBox crop, Path output) throws Exception {
    if (page < 1 || crop.x() < 0 || crop.y() < 0 || crop.width() < 1 || crop.height() < 1) {
      throw new ExtractionException("TABLE_IMAGE_CROP_INVALID");
    }
    Path target = output.toAbsolutePath().normalize();
    Path directory = target.getParent();
    if (directory == null) throw new ExtractionException("TABLE_IMAGE_PATH_INVALID");
    Files.createDirectories(directory);
    Path prefix = Files.createTempFile(directory, "reference-page-", "");
    Files.deleteIfExists(prefix);
    Path renderedPage = Path.of(prefix + ".png");
    List<String> arguments = List.of(
        "pdftoppm", "-f", Integer.toString(page), "-l", Integer.toString(page),
        "-singlefile", "-png", "-r", "144", pdf.toAbsolutePath().normalize().toString(),
        prefix.toString());
    try {
      ProcessResult process = runner.run(new Command(arguments, directory, TIMEOUT, prefix.toString()));
      if (process.timedOut()) throw new ExtractionException("TABLE_IMAGE_RENDER_TIMEOUT");
      if (process.exitCode() != 0 || !Files.isRegularFile(renderedPage)) {
        throw new ExtractionException("TABLE_IMAGE_RENDER_FAILED");
      }
      BufferedImage pageImage = ImageIO.read(renderedPage.toFile());
      if (pageImage == null || crop.x() + crop.width() > pageImage.getWidth()
          || crop.y() + crop.height() > pageImage.getHeight()) {
        throw new ExtractionException("TABLE_IMAGE_CROP_INVALID");
      }
      BufferedImage cropped = pageImage.getSubimage(crop.x(), crop.y(), crop.width(), crop.height());
      if (!ImageIO.write(cropped, "png", target.toFile())) {
        throw new ExtractionException("TABLE_IMAGE_WRITE_FAILED");
      }
      return new ExtractedImage(target, sha256(target), cropped.getWidth(), cropped.getHeight());
    } finally {
      Files.deleteIfExists(renderedPage);
    }
  }

  public ExtractedImage extractContent(Path pdf, int page, Path output) throws Exception {
    if (page < 1) throw new ExtractionException("TABLE_IMAGE_CROP_INVALID");
    Path target = output.toAbsolutePath().normalize();
    Path directory = target.getParent();
    if (directory == null) throw new ExtractionException("TABLE_IMAGE_PATH_INVALID");
    Files.createDirectories(directory);
    Path prefix = Files.createTempFile(directory, "reference-page-", "");
    Files.deleteIfExists(prefix);
    Path renderedPage = Path.of(prefix + ".png");
    List<String> arguments = List.of(
        "pdftoppm", "-f", Integer.toString(page), "-l", Integer.toString(page),
        "-singlefile", "-png", "-r", "144", pdf.toAbsolutePath().normalize().toString(),
        prefix.toString());
    try {
      ProcessResult process = runner.run(new Command(arguments, directory, TIMEOUT, prefix.toString()));
      if (process.timedOut()) throw new ExtractionException("TABLE_IMAGE_RENDER_TIMEOUT");
      if (process.exitCode() != 0 || !Files.isRegularFile(renderedPage)) {
        throw new ExtractionException("TABLE_IMAGE_RENDER_FAILED");
      }
      BufferedImage pageImage = ImageIO.read(renderedPage.toFile());
      CropBox crop = contentBounds(pageImage);
      BufferedImage cropped = pageImage.getSubimage(crop.x(), crop.y(), crop.width(), crop.height());
      if (!ImageIO.write(cropped, "png", target.toFile())) {
        throw new ExtractionException("TABLE_IMAGE_WRITE_FAILED");
      }
      return new ExtractedImage(target, sha256(target), cropped.getWidth(), cropped.getHeight());
    } finally {
      Files.deleteIfExists(renderedPage);
    }
  }

  private static CropBox contentBounds(BufferedImage image) throws ExtractionException {
    if (image == null) throw new ExtractionException("TABLE_IMAGE_RENDER_FAILED");
    int minX = image.getWidth();
    int minY = image.getHeight();
    int maxX = -1;
    int maxY = -1;
    for (int y = 0; y < image.getHeight(); y += 1) {
      for (int x = 0; x < image.getWidth(); x += 1) {
        int argb = image.getRGB(x, y);
        int alpha = (argb >>> 24) & 0xff;
        int red = (argb >>> 16) & 0xff;
        int green = (argb >>> 8) & 0xff;
        int blue = argb & 0xff;
        if (alpha > 8 && (red < 248 || green < 248 || blue < 248)) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < minX || maxY < minY) throw new ExtractionException("TABLE_IMAGE_CONTENT_EMPTY");
    int padding = 8;
    int x = Math.max(0, minX - padding);
    int y = Math.max(0, minY - padding);
    int right = Math.min(image.getWidth() - 1, maxX + padding);
    int bottom = Math.min(image.getHeight() - 1, maxY + padding);
    return new CropBox(x, y, right - x + 1, bottom - y + 1);
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

  record Command(List<String> arguments, Path workingDirectory, Duration timeout, String outputPrefix) {}
  record ProcessResult(int exitCode, boolean timedOut) {}
  public record CropBox(int x, int y, int width, int height) {}
  public record ExtractedImage(Path path, String sha256, int width, int height) {}

  public static final class ExtractionException extends IOException {
    private final String code;

    ExtractionException(String code) {
      super("Vytvoření obrazu tabulky selhalo (" + code + ").");
      this.code = code;
    }

    public String code() { return code; }
  }

  private static final class SystemCommandRunner implements CommandRunner {
    @Override public ProcessResult run(Command command) throws Exception {
      Path log = Files.createTempFile(command.workingDirectory(), "pdftoppm-", ".log");
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
          return new ProcessResult(-1, true);
        }
        return new ProcessResult(process.exitValue(), false);
      } finally {
        Files.deleteIfExists(log);
      }
    }
  }
}

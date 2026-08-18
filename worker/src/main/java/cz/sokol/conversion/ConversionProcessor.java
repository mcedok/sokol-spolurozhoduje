package cz.sokol.conversion;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import cz.sokol.conversion.model.ConversionResult;

public final class ConversionProcessor {
  private final Repository repository;
  private final BlobStore blobStore;
  private final VirusScanner scanner;

  public ConversionProcessor(Repository repository, BlobStore blobStore, VirusScanner scanner) {
    this.repository = repository;
    this.blobStore = blobStore;
    this.scanner = scanner;
  }

  public void scanAndArchive(UUID jobId) throws Exception {
    Job job = repository.load(jobId);
    scanAndArchive(job);
  }

  private Optional<ArchivedSource> scanAndArchive(Job job) throws Exception {
    String targetContainer = "originals";
    String targetKey = job.documentId() + "/" + job.versionId() + "/" + job.sha256() + ".docx";
    Optional<BlobStore.StoredBlob> existing = blobStore.probe(targetContainer, targetKey);
    if (existing.isPresent()) {
      if (!job.sha256().equals(existing.orElseThrow().sha256())) throw new IntegrityException();
      boolean sourceIsArchivedTarget = targetContainer.equals(job.sourceContainer())
          && targetKey.equals(job.sourceKey());
      if (!sourceIsArchivedTarget) {
        Optional<BlobStore.StoredBlob> quarantine = blobStore.probe(
            job.sourceContainer(), job.sourceKey());
        if (quarantine.isPresent()) {
          if (!job.sourceEtag().equals(quarantine.orElseThrow().etag())
              || !blobStore.deleteIfMatch(
                  job.sourceContainer(), job.sourceKey(), job.sourceEtag())) {
            throw new IntegrityException();
          }
        }
      }
      repository.markArchived(
          job, targetContainer, targetKey, existing.orElseThrow().etag());
      return Optional.of(new ArchivedSource(targetContainer, targetKey));
    }
    if (targetContainer.equals(job.sourceContainer()) && targetKey.equals(job.sourceKey())) {
      throw new IntegrityException();
    }
    repository.markScanning(job);
    ClamAvClient.AvStatus status;
    try (InputStream content = blobStore.open(job.sourceContainer(), job.sourceKey())) {
      status = scanner.scan(content);
    }
    if (status == ClamAvClient.AvStatus.INFECTED) {
      repository.markRejected(job, "MALWARE_DETECTED");
      return Optional.empty();
    }
    BlobStore.StoredBlob archived = blobStore.copyIfAbsent(
        job.sourceContainer(), job.sourceKey(), targetContainer, targetKey, job.sha256());
    if (!job.sha256().equals(archived.sha256())) {
      throw new IntegrityException();
    }
    if (!blobStore.deleteIfMatch(job.sourceContainer(), job.sourceKey(), job.sourceEtag())) {
      throw new IntegrityException();
    }
    repository.markArchived(job, targetContainer, targetKey, archived.etag());
    return Optional.of(new ArchivedSource(targetContainer, targetKey));
  }

  public void processLeasedJob(
      UUID jobId, Path workRoot, LibreOfficeRenderer renderer) throws Exception {
    processLeasedJob(jobId, workRoot, renderer, (source, blocks, directory) ->
        new TableArtifactRenderer(renderer, new TableImageExtractor(), new PdfTextExtractor())
            .generate(source, blocks, directory));
  }

  public void processLeasedJob(
      UUID jobId, Path workRoot, LibreOfficeRenderer renderer,
      TableArtifactGenerator artifactGenerator) throws Exception {
    Job job = repository.load(jobId);
    Optional<ArchivedSource> archived = scanAndArchive(job);
    if (archived.isEmpty()) return;
    Path root = workRoot.toAbsolutePath().normalize();
    Files.createDirectories(root);
    Path jobDirectory = Files.createTempDirectory(root, job.id() + "-");
    try {
      Path docx = jobDirectory.resolve("source.docx");
      try (InputStream content = blobStore.open(
          archived.orElseThrow().container(), archived.orElseThrow().objectKey())) {
        Files.copy(content, docx, StandardCopyOption.REPLACE_EXISTING);
      }
      if (!job.sha256().equals(sha256(docx))) throw new IntegrityException();
      ConversionResult parsed = new DocxParser(job.versionCreatedAt()).parse(
          docx, job.sha256(), job.profileVersion());
      Derivative reference = renderAndStoreReference(job, docx, jobDirectory, renderer);
      GeneratedTableArtifacts generated = artifactGenerator.generate(
          docx, parsed.blocks(), jobDirectory.resolve("tables"));
      TableReview tableReview = recommendTables(
          docx, generated.renderMismatches(), new TableComplexityAnalyzer(), parsed.blocks());
      List<TableImageDerivative> tableImages = storeTableImages(job, generated, tableReview);
      List<ConversionResult.Finding> findings = new ArrayList<>(parsed.findings());
      findings.addAll(tableReview.findings());
      ConversionResult result = new ConversionResult(
          parsed.profileVersion(), parsed.sourceSha256(), parsed.blocks(), List.copyOf(findings));
      repository.completeConversion(
          job, new CompletedConversion(result, tableReview, reference, tableImages));
    } finally {
      deleteTree(jobDirectory);
    }
  }

  private List<TableImageDerivative> storeTableImages(
      Job job, GeneratedTableArtifacts generated, TableReview review) throws Exception {
    List<TableImageDerivative> result = new ArrayList<>();
    for (GeneratedTableImage image : generated.images()) {
      if (image.tableIndex() < 0 || image.tableIndex() >= review.tables().size()) {
        throw new IllegalStateException("Obraz odkazuje na neznámou tabulku.");
      }
      if (!"image_with_attachment".equals(
          review.tables().get(image.tableIndex()).recommendation().code())) continue;
      String objectKey = job.documentId() + "/" + job.versionId() + "/tables/"
          + image.tableIndex() + "/" + image.sha256() + ".png";
      BlobStore.StoredBlob stored = blobStore.putIfAbsent(
          "derivatives", objectKey, image.path(), image.sha256(), "image/png");
      if (!image.sha256().equals(stored.sha256())) throw new IntegrityException();
      result.add(new TableImageDerivative(
          image.tableIndex(), new Derivative(
              "derivatives", objectKey, image.sha256(), stored.etag(), Files.size(image.path()),
              "image/png"), image.width(), image.height()));
    }
    return List.copyOf(result);
  }

  public Derivative renderAndStoreReference(
      UUID jobId, Path originalDocx, Path jobDirectory, LibreOfficeRenderer renderer)
      throws Exception {
    Job job = repository.load(jobId);
    return renderAndStoreReference(job, originalDocx, jobDirectory, renderer);
  }

  private Derivative renderAndStoreReference(
      Job job, Path originalDocx, Path jobDirectory, LibreOfficeRenderer renderer)
      throws Exception {
    repository.markRendering(job);
    LibreOfficeRenderer.RenderedPdf rendered = renderer.render(originalDocx, jobDirectory);
    String container = "derivatives";
    String objectKey = job.documentId() + "/" + job.versionId() + "/reference/"
        + rendered.sha256() + ".pdf";
    BlobStore.StoredBlob stored = blobStore.putIfAbsent(
        container, objectKey, rendered.path(), rendered.sha256(), "application/pdf");
    if (!rendered.sha256().equals(stored.sha256())) throw new IntegrityException();
    Derivative derivative = new Derivative(
        container, objectKey, rendered.sha256(), stored.etag(), Files.size(rendered.path()),
        "application/pdf");
    return derivative;
  }

  private static String sha256(Path path) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream input = Files.newInputStream(path)) {
      byte[] buffer = new byte[64 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) if (count > 0) digest.update(buffer, 0, count);
    }
    return HexFormat.of().formatHex(digest.digest());
  }

  private static void deleteTree(Path root) throws Exception {
    if (!Files.exists(root)) return;
    try (var paths = Files.walk(root)) {
      for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
    }
  }

  public TableReview recommendTables(
      Path originalDocx, Set<Integer> renderMismatches, TableComplexityAnalyzer analyzer)
      throws Exception {
    return recommendTables(originalDocx, renderMismatches, analyzer, List.of());
  }

  public TableReview recommendTables(
      Path originalDocx, Set<Integer> renderMismatches, TableComplexityAnalyzer analyzer,
      List<ConversionResult.Block> blocks) throws Exception {
    List<TableComplexityAnalyzer.Analysis> tables = analyzer.analyze(
        originalDocx, renderMismatches);
    List<Integer> tableBlockIndices = new ArrayList<>();
    for (int index = 0; index < blocks.size(); index += 1) {
      if ("table".equals(blocks.get(index).type())) tableBlockIndices.add(index);
    }
    if (!blocks.isEmpty() && tableBlockIndices.size() != tables.size()) {
      throw new IllegalStateException("Počet tabulek neodpovídá převedeným blokům.");
    }
    List<ConversionResult.Finding> findings = new ArrayList<>();
    for (int index = 0; index < tables.size(); index += 1) {
      TableComplexityAnalyzer.Analysis table = tables.get(index);
      int blockIndex = blocks.isEmpty() ? index : tableBlockIndices.get(index);
      Map<String, Object> location = Map.of("blockIndex", blockIndex);
      if (table.reasons().stream().anyMatch(reason -> reason.code().equals("RENDER_MISMATCH"))) {
        findings.add(new ConversionResult.Finding(
            "TABLE_RENDER_MISMATCH", "blocking",
            "Strukturální tabulka se liší od referenčního renderu.", location));
      }
      if (table.recommendation().code().equals("image_with_attachment")) {
        findings.add(new ConversionResult.Finding(
            "ALT_TEXT_REQUIRED", "blocking",
            "Obraz tabulky vyžaduje alternativní text.", location));
      }
    }
    return new TableReview(List.copyOf(tables), List.copyOf(findings));
  }

  public interface Repository {
    Job load(UUID jobId) throws Exception;
    void markScanning(Job job) throws Exception;
    void markRejected(Job job, String code) throws Exception;
    void markArchived(Job job, String container, String objectKey, String etag) throws Exception;
    void markRendering(Job job) throws Exception;
    void completeConversion(Job job, CompletedConversion conversion) throws Exception;
  }

  @FunctionalInterface
  public interface TableArtifactGenerator {
    GeneratedTableArtifacts generate(
        Path originalDocx, List<ConversionResult.Block> blocks, Path outputDirectory)
        throws Exception;
  }

  public record Job(
      UUID id,
      UUID documentId,
      UUID versionId,
      UUID fileId,
      String sourceContainer,
      String sourceKey,
      String sha256,
      String sourceEtag,
      UUID correlationId,
      UUID ownerUserId,
      String profileVersion,
      java.time.Instant versionCreatedAt,
      String leaseOwner) {}

  public record Derivative(
      String container,
      String objectKey,
      String sha256,
      String etag,
      long sizeBytes,
      String contentType) {}

  public record TableReview(
      List<TableComplexityAnalyzer.Analysis> tables,
      List<ConversionResult.Finding> findings) {}

  public record GeneratedTableImage(
      int tableIndex, Path path, String sha256, int width, int height) {}

  public record GeneratedTableArtifacts(
      List<GeneratedTableImage> images,
      Set<Integer> renderMismatches) {}

  public record TableImageDerivative(
      int tableIndex, Derivative derivative, int width, int height) {}

  public record CompletedConversion(
      ConversionResult result,
      TableReview tableReview,
      Derivative reference,
      List<TableImageDerivative> tableImages) {}

  private record ArchivedSource(String container, String objectKey) {}

  public static final class IntegrityException extends Exception {
    public IntegrityException() {
      super("Kontrola neměnnosti originálu selhala.");
    }
  }
}

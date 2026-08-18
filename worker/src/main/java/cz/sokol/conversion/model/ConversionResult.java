package cz.sokol.conversion.model;

import java.util.List;
import java.util.Map;

public record ConversionResult(
    String profileVersion,
    String sourceSha256,
    List<Block> blocks,
    List<Finding> findings) {

  public record Block(
      String blockUid,
      String type,
      String plainText,
      String normalizedHash,
      boolean commentable,
      List<String> headingPath,
      String sourceBookmark,
      String sourceParaId,
      Map<String, Object> content,
      List<Asset> assets) {}

  public record Asset(
      String kind,
      String sha256,
      String alternativeText,
      Integer width,
      Integer height) {}

  public record Finding(
      String code,
      String severity,
      String message,
      Map<String, Object> sourceLocation) {}
}

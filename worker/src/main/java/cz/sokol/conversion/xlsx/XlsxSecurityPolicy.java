package cz.sokol.conversion.xlsx;

public record XlsxSecurityPolicy(
    long maxBytes,
    int maxRows,
    int maxZipEntries,
    long maxUncompressedBytes,
    int maxCellCharacters,
    long maxWorkbookTextCharacters) {

  public static XlsxSecurityPolicy defaults() {
    return new XlsxSecurityPolicy(
        25L * 1024L * 1024L, 1000, 256, 128L * 1024L * 1024L, 32_767, 10_000_000L);
  }
}

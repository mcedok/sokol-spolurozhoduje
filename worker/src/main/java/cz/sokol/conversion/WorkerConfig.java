package cz.sokol.conversion;

import java.util.Map;

public record WorkerConfig(
    String databaseUrl,
    String databaseUser,
    String databasePassword,
    String storageConnectionString,
    String clamAvHost,
    int clamAvPort,
    String workerId,
    int leaseSeconds,
    String veraPdfCommand,
    String fontRoot,
    int pdfValidationTimeoutSeconds) {

  public static final int DEFAULT_XLSX_MAX_BYTES = 25 * 1024 * 1024;
  public static final int DEFAULT_XLSX_MAX_ROWS = 1_000;
  public static final int DEFAULT_XLSX_MAX_ZIP_ENTRIES = 2_000;
  public static final long DEFAULT_XLSX_MAX_UNPACKED_BYTES = 100L * 1024 * 1024;

  public static WorkerConfig fromEnvironment(Map<String, String> environment) {
    return new WorkerConfig(
        required(environment, "DATABASE_URL"),
        required(environment, "DATABASE_USER"),
        required(environment, "DATABASE_PASSWORD"),
        required(environment, "AZURE_STORAGE_CONNECTION_STRING"),
        required(environment, "CLAMAV_HOST"),
        positiveInteger(environment.get("CLAMAV_PORT"), 3310, "CLAMAV_PORT"),
        required(environment, "WORKER_ID"),
        positiveInteger(environment.get("WORKER_LEASE_SECONDS"), 120, "WORKER_LEASE_SECONDS"),
        environment.getOrDefault("VERAPDF_COMMAND", "/opt/verapdf/verapdf"),
        environment.getOrDefault("SOKOL_FONT_ROOT", "/app/fonts"),
        positiveInteger(environment.get("PDF_VALIDATION_TIMEOUT_SECONDS"), 90,
            "PDF_VALIDATION_TIMEOUT_SECONDS"));
  }

  private static String required(Map<String, String> environment, String name) {
    String value = environment.get(name);
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Chybí povinná konfigurace " + name + ".");
    }
    return value;
  }

  private static int positiveInteger(String value, int fallback, String name) {
    try {
      int parsed = value == null ? fallback : Integer.parseInt(value);
      if (parsed <= 0) throw new NumberFormatException();
      return parsed;
    } catch (NumberFormatException error) {
      throw new IllegalArgumentException(name + " musí být kladné celé číslo.");
    }
  }
}

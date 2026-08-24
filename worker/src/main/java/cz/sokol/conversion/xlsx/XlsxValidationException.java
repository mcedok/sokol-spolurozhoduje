package cz.sokol.conversion.xlsx;

public final class XlsxValidationException extends Exception {
  public XlsxValidationException(String message) {
    super(message);
  }

  public XlsxValidationException(String message, Throwable cause) {
    super(message, cause);
  }
}

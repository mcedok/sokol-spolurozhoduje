package cz.sokol.conversion.xlsx;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class XlsxManifestCodec {
  public SignedManifest sign(String payload, byte[] secret) throws XlsxValidationException {
    return new SignedManifest(payload, digest(payload, secret));
  }

  public void verify(SignedManifest manifest, byte[] secret) throws XlsxValidationException {
    String expected = digest(manifest.payload(), secret);
    if (!MessageDigest.isEqual(
        expected.getBytes(StandardCharsets.US_ASCII),
        manifest.signature().getBytes(StandardCharsets.US_ASCII))) {
      throw new XlsxValidationException("MANIFEST_SIGNATURE_INVALID");
    }
  }

  private static String digest(String payload, byte[] secret) throws XlsxValidationException {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret, "HmacSHA256"));
      return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception error) {
      throw new XlsxValidationException("MANIFEST_SIGNATURE_FAILED", error);
    }
  }

  public record SignedManifest(String payload, String signature) {}
}

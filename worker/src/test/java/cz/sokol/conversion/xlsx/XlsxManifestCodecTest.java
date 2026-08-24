package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class XlsxManifestCodecTest {
  @Test
  void verifiesOnlyTheOriginalManifestPayload() throws Exception {
    XlsxManifestCodec codec = new XlsxManifestCodec();
    XlsxManifestCodec.SignedManifest signed = codec.sign("job-1|snapshot|1000", "secret".getBytes());
    assertDoesNotThrow(() -> codec.verify(signed, "secret".getBytes()));
    assertThrows(XlsxValidationException.class, () -> codec.verify(
        new XlsxManifestCodec.SignedManifest(signed.payload(), signed.signature() + "0"),
        "secret".getBytes()));
  }
}

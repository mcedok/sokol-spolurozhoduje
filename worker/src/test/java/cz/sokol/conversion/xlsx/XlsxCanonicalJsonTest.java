package cz.sokol.conversion.xlsx;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class XlsxCanonicalJsonTest {
  @Test
  void checksumIgnoresObjectKeyOrderAndWhitespace() throws Exception {
    String left = "{\"b\":2,\"a\":{\"d\":4,\"c\":3}}";
    String right = " { \"a\" : { \"c\" : 3, \"d\" : 4 }, \"b\" : 2 } ";
    assertEquals(XlsxCanonicalJson.sha256(left), XlsxCanonicalJson.sha256(right));
  }
}

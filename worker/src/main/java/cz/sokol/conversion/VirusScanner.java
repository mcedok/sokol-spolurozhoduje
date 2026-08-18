package cz.sokol.conversion;

import java.io.InputStream;

@FunctionalInterface
public interface VirusScanner {
  ClamAvClient.AvStatus scan(InputStream content) throws Exception;
}

package cz.sokol.conversion;

import java.net.URI;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

public final class SafeLink {
  private static final Set<String> ALLOWED = Set.of("http", "https", "mailto");

  private SafeLink() {}

  public static Optional<String> sanitize(String candidate) {
    if (candidate == null || candidate.isBlank()) return Optional.empty();
    try {
      URI uri = URI.create(candidate.trim());
      String scheme = uri.getScheme();
      if (scheme == null || !ALLOWED.contains(scheme.toLowerCase(Locale.ROOT))) {
        return Optional.empty();
      }
      return Optional.of(uri.toASCIIString());
    } catch (IllegalArgumentException error) {
      return Optional.empty();
    }
  }
}

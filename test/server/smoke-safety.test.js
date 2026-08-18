import { describe, expect, it } from "vitest";
import {
  assertDisposableSmokeDatabase,
  assertMatchingDisposableSmokeDatabases,
} from "../../scripts/smoke-safety.mjs";

describe("server smoke database guard", () => {
  it("accepts only the explicit local sokol_test database", () => {
    expect(() => assertDisposableSmokeDatabase(
      "postgres://sokol:password@127.0.0.1:55432/sokol_test",
      "RESET_LOCAL_SOKOL_TEST",
    )).not.toThrow();
  });

  it.each([
    "postgres://sokol:password@db.internal:5432/sokol_test",
    "postgres://sokol:password@127.0.0.1:5432/sokol",
    "postgres://sokol:password@localhost:5432/production",
  ])("rejects a non-disposable database: %s", (url) => {
    expect(() => assertDisposableSmokeDatabase(url, "RESET_LOCAL_SOKOL_TEST"))
      .toThrow(/only for local database sokol_test/i);
  });

  it("requires an explicit destructive confirmation", () => {
    expect(() => assertDisposableSmokeDatabase(
      "postgres://sokol:password@127.0.0.1:55432/sokol_test",
      undefined,
    )).toThrow(/SMOKE_ALLOW_DATABASE_RESET/);
  });

  it("requires the container to use the corresponding local disposable database", () => {
    expect(() => assertMatchingDisposableSmokeDatabases(
      "postgres://sokol:password@127.0.0.1:55432/sokol_test",
      "postgres://sokol:password@host.docker.internal:55432/sokol_test",
      "RESET_LOCAL_SOKOL_TEST",
    )).not.toThrow();
    expect(() => assertMatchingDisposableSmokeDatabases(
      "postgres://sokol:password@127.0.0.1:55432/sokol_test",
      "postgres://sokol:password@db.internal:5432/production",
      "RESET_LOCAL_SOKOL_TEST",
    )).toThrow(/container database/i);
  });
});

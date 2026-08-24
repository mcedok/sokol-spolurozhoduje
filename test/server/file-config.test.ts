import { describe, expect, it } from "vitest";
import { fileConfig } from "../../server/modules/files/file-config";

describe("file configuration", () => {
  it("uses bounded local defaults outside production", () => {
    expect(fileConfig({ NODE_ENV: "test" })).toMatchObject({
      connectionString: "UseDevelopmentStorage=true",
      blobEndpoint: "http://127.0.0.1:10000/devstoreaccount1",
      maxUploadBytes: 25 * 1024 * 1024,
      maxUnpackedBytes: 100 * 1024 * 1024,
      maxEntries: 2_000,
      maxCompressionRatio: 100,
      readUrlTtlSeconds: 300,
    });
  });

  it("requires explicit private storage configuration in production", () => {
    expect(() => fileConfig({ NODE_ENV: "production" }))
      .toThrow("Chybí konfigurace privátního objektového úložiště");
  });

  it("honors the documented XLSX upload and archive limits", () => {
    expect(fileConfig({
      NODE_ENV: "test",
      XLSX_MAX_BYTES: "1048576",
      XLSX_MAX_ZIP_ENTRIES: "321",
      XLSX_MAX_UNPACKED_BYTES: "8388608",
    })).toMatchObject({
      maxUploadBytes: 1_048_576,
      maxEntries: 321,
      maxUnpackedBytes: 8_388_608,
    });
  });

  it("rejects an insecure remote endpoint and a read URL over five minutes", () => {
    const base = {
      NODE_ENV: "production",
      AZURE_STORAGE_CONNECTION_STRING: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=secret",
    } satisfies NodeJS.ProcessEnv;
    expect(() => fileConfig({
      ...base,
      AZURE_BLOB_ENDPOINT: "http://storage.example.cz/account",
    })).toThrow("musí používat HTTPS");
    expect(() => fileConfig({
      ...base,
      AZURE_BLOB_ENDPOINT: "https://storage.example.cz/account",
      FILE_READ_URL_TTL_SECONDS: "301",
    })).toThrow("nejvýše 300 sekund");
  });
});

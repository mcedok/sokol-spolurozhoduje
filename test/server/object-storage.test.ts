import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAzureBlobStorage,
} from "../../server/modules/files/azure-blob-storage";
import type { FileConfig } from "../../server/modules/files/file-config";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const objectKey = `storage-test/${crypto.randomUUID()}/input.docx`;
const config: FileConfig = {
  connectionString: "UseDevelopmentStorage=true",
  blobEndpoint: "http://127.0.0.1:10000/devstoreaccount1",
  quarantineContainer: "quarantine",
  originalsContainer: "originals",
  derivativesContainer: "derivatives",
  maxUploadBytes: 25 * 1024 * 1024,
  maxUnpackedBytes: 250 * 1024 * 1024,
  maxEntries: 10_000,
  maxCompressionRatio: 100,
  readUrlTtlSeconds: 300,
};

const storage = createAzureBlobStorage(config);

beforeAll(() => storage.ensureContainers());
afterAll(async () => {
  await storage.delete("quarantine", objectKey).catch(() => undefined);
  await storage.delete("originals", `${objectKey}.archived`).catch(() => undefined);
});

describe("private object storage", () => {
  it("streams a blob, preserves its digest and keeps the container private", async () => {
    const bytes = Buffer.from("PK\u0003\u0004document-content", "utf8");
    const stored = await storage.putQuarantine({
      objectKey,
      body: Readable.from([bytes]),
      contentType: DOCX_MIME,
    });

    expect(stored).toMatchObject({
      objectKey,
      sizeBytes: bytes.byteLength,
      sha256: "e8313359b58057c1964c242707e1cbcb463ca5f5a3d09fce58eb5f2000e7935d",
    });

    const anonymous = await fetch(`${config.blobEndpoint}/quarantine/${objectKey}`);
    expect(anonymous.status).toBe(403);
  });

  it("issues a read-only URL for one blob for no more than five minutes", async () => {
    const signed = await storage.createReadUrl("quarantine", objectKey, 300);
    const url = new URL(signed.url);
    expect(url.pathname).toBe(`/devstoreaccount1/quarantine/${objectKey}`);
    expect(url.searchParams.get("sp")).toBe("r");
    expect(Date.parse(signed.expiresAt) - Date.now()).toBeGreaterThan(290_000);
    expect(Date.parse(signed.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);

    const response = await fetch(signed.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("PK\u0003\u0004document-content");
    await expect(storage.createReadUrl("quarantine", objectKey, 301))
      .rejects.toThrow("nejvýše 300 sekund");
  });

  it("copies an object once, reads it back and deletes only the matching ETag", async () => {
    const archivedKey = `${objectKey}.archived`;
    const first = await storage.copyIfAbsent(
      "quarantine",
      objectKey,
      "originals",
      archivedKey,
    );
    const replay = await storage.copyIfAbsent(
      "quarantine",
      objectKey,
      "originals",
      archivedKey,
    );
    expect(replay.etag).toBe(first.etag);

    const chunks: Buffer[] = [];
    for await (const chunk of await storage.open("originals", archivedKey)) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("PK\u0003\u0004document-content");

    await expect(storage.delete("originals", archivedKey, '"wrong-etag"')).rejects.toMatchObject({
      statusCode: 412,
    });
    await storage.delete("originals", archivedKey, first.etag);
    await storage.delete("quarantine", objectKey);
  });
});

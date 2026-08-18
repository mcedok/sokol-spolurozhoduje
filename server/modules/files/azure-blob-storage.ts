import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import {
  BlobSASPermissions,
  BlobServiceClient,
  BlockBlobClient,
} from "@azure/storage-blob";
import type { FileConfig } from "./file-config";
import type {
  ObjectContainer,
  ObjectStorage,
  PutObjectInput,
  SignedReadUrl,
  StoredObject,
} from "./object-storage";

const BLOCK_SIZE = 4 * 1024 * 1024;
const MAX_CONCURRENCY = 4;

function normalizeKey(objectKey: string): string {
  const value = objectKey.replaceAll("\\", "/");
  if (!value || value.startsWith("/") || value.split("/").includes("..")) {
    throw new Error("Neplatný klíč objektu.");
  }
  return value;
}

export function createAzureBlobStorage(config: FileConfig): ObjectStorage {
  const service = BlobServiceClient.fromConnectionString(config.connectionString);
  const allowedContainers = new Set<ObjectContainer>([
    config.quarantineContainer,
    config.originalsContainer,
    config.derivativesContainer,
  ]);

  function blob(container: ObjectContainer, objectKey: string): BlockBlobClient {
    if (!allowedContainers.has(container)) throw new Error("Nepovolený kontejner.");
    return service.getContainerClient(container).getBlockBlobClient(normalizeKey(objectKey));
  }

  async function signedUrl(
    container: ObjectContainer,
    objectKey: string,
    ttlSeconds: number,
  ): Promise<SignedReadUrl> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > config.readUrlTtlSeconds) {
      throw new Error(`Odkaz smí platit nejvýše ${config.readUrlTtlSeconds} sekund.`);
    }
    const startsOn = new Date(Date.now() - 5_000);
    const expiresOn = new Date(Date.now() + ttlSeconds * 1_000);
    const url = await blob(container, objectKey).generateSasUrl({
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
    });
    return { url, expiresAt: expiresOn.toISOString() };
  }

  return {
    async ensureContainers(): Promise<void> {
      for (const container of allowedContainers) {
        await service.getContainerClient(container).createIfNotExists();
      }
    },

    async putQuarantine(input: PutObjectInput): Promise<StoredObject> {
      const digest = createHash("sha256");
      let sizeBytes = 0;
      const hashingStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      input.body.pipe(hashingStream);
      const target = blob(config.quarantineContainer, input.objectKey);
      const response = await target.uploadStream(
        hashingStream,
        BLOCK_SIZE,
        MAX_CONCURRENCY,
        { blobHTTPHeaders: { blobContentType: input.contentType } },
      );
      const sha256 = digest.digest("hex");
      const metadata = await target.setMetadata({ sha256 });
      return {
        objectKey: normalizeKey(input.objectKey),
        sizeBytes,
        sha256,
        etag: metadata.etag ?? response.etag,
      };
    },

    async open(container: ObjectContainer, objectKey: string): Promise<NodeJS.ReadableStream> {
      const response = await blob(container, objectKey).download();
      if (!response.readableStreamBody) throw new Error("Objekt nelze načíst.");
      return response.readableStreamBody;
    },

    async copyIfAbsent(sourceContainer, sourceKey, destinationContainer, destinationKey) {
      const sourceBlob = blob(sourceContainer, sourceKey);
      const destination = blob(destinationContainer, destinationKey);
      const source = await signedUrl(sourceContainer, sourceKey, config.readUrlTtlSeconds);
      try {
        const poller = await destination.beginCopyFromURL(source.url, {
          conditions: { ifNoneMatch: "*" },
        });
        const result = await poller.pollUntilDone();
        return { etag: result.etag };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode !== 409 && statusCode !== 412) throw error;
        const [sourceProperties, destinationProperties] = await Promise.all([
          sourceBlob.getProperties(),
          destination.getProperties(),
        ]);
        if (
          sourceProperties.metadata?.sha256
          && sourceProperties.metadata.sha256 === destinationProperties.metadata?.sha256
        ) {
          return { etag: destinationProperties.etag };
        }
        throw new Error("Cílový objekt již existuje s jiným kontrolním součtem.");
      }
    },

    async delete(container: ObjectContainer, objectKey: string, etag?: string): Promise<void> {
      await blob(container, objectKey).deleteIfExists({
        conditions: etag ? { ifMatch: etag } : undefined,
      });
    },

    createReadUrl(container, objectKey, ttlSeconds) {
      return signedUrl(container, objectKey, ttlSeconds);
    },
  };
}

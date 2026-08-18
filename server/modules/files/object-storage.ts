import type { Readable } from "node:stream";

export type ObjectContainer = "quarantine" | "originals" | "derivatives";

export interface StoredObject {
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  etag: string | undefined;
}

export interface PutObjectInput {
  objectKey: string;
  body: Readable;
  contentType: string;
}

export interface SignedReadUrl {
  url: string;
  expiresAt: string;
}

export interface ObjectStorage {
  ensureContainers(): Promise<void>;
  putQuarantine(input: PutObjectInput): Promise<StoredObject>;
  open(container: ObjectContainer, objectKey: string): Promise<NodeJS.ReadableStream>;
  copyIfAbsent(
    sourceContainer: ObjectContainer,
    sourceKey: string,
    destinationContainer: ObjectContainer,
    destinationKey: string,
  ): Promise<{ etag: string | undefined }>;
  delete(container: ObjectContainer, objectKey: string, etag?: string): Promise<void>;
  createReadUrl(
    container: ObjectContainer,
    objectKey: string,
    ttlSeconds: number,
  ): Promise<SignedReadUrl>;
}

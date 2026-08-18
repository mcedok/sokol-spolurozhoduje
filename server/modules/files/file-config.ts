export const QUARANTINE_CONTAINER = "quarantine" as const;
export const ORIGINALS_CONTAINER = "originals" as const;
export const DERIVATIVES_CONTAINER = "derivatives" as const;

export interface FileConfig {
  connectionString: string;
  blobEndpoint: string;
  quarantineContainer: typeof QUARANTINE_CONTAINER;
  originalsContainer: typeof ORIGINALS_CONTAINER;
  derivativesContainer: typeof DERIVATIVES_CONTAINER;
  maxUploadBytes: number;
  maxUnpackedBytes: number;
  maxEntries: number;
  maxCompressionRatio: number;
  readUrlTtlSeconds: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} musí být kladné celé číslo.`);
  }
  return parsed;
}

function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !local) {
    throw new Error("Produkční Blob endpoint musí používat HTTPS.");
  }
  return endpoint.replace(/\/$/, "");
}

export function fileConfig(env: NodeJS.ProcessEnv = process.env): FileConfig {
  const local = env.NODE_ENV !== "production";
  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING
    ?? (local ? "UseDevelopmentStorage=true" : undefined);
  const blobEndpoint = env.AZURE_BLOB_ENDPOINT
    ?? (local ? "http://127.0.0.1:10000/devstoreaccount1" : undefined);
  if (!connectionString || !blobEndpoint) {
    throw new Error("Chybí konfigurace privátního objektového úložiště.");
  }
  const readUrlTtlSeconds = positiveInteger(
    env.FILE_READ_URL_TTL_SECONDS,
    300,
    "FILE_READ_URL_TTL_SECONDS",
  );
  if (readUrlTtlSeconds > 300) {
    throw new Error("FILE_READ_URL_TTL_SECONDS smí být nejvýše 300 sekund.");
  }
  return {
    connectionString,
    blobEndpoint: validateEndpoint(blobEndpoint),
    quarantineContainer: QUARANTINE_CONTAINER,
    originalsContainer: ORIGINALS_CONTAINER,
    derivativesContainer: DERIVATIVES_CONTAINER,
    maxUploadBytes: 25 * 1024 * 1024,
    maxUnpackedBytes: 250 * 1024 * 1024,
    maxEntries: 10_000,
    maxCompressionRatio: 100,
    readUrlTtlSeconds,
  };
}

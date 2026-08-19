import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise } from "yauzl";
import { AuthError } from "../identity/auth-errors";
import type { FileConfig } from "./file-config";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface XlsxUploadInput {
  fileName: string;
  contentType: string;
  contentLength: number;
  body: NodeJS.ReadableStream;
}

export interface StagedXlsx {
  path: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  cleanup(): Promise<void>;
}

function invalid(detail: string): AuthError {
  return new AuthError("INVALID_XLSX", detail, 400);
}

async function inspectPackage(path: string, config: FileConfig): Promise<void> {
  const zip = await openPromise(path, { autoClose: false, lazyEntries: true, validateEntrySizes: true });
  let entries = 0;
  let unpackedBytes = 0;
  let hasContentTypes = false;
  let hasWorkbook = false;
  try {
    for await (const entry of zip.eachEntry()) {
      entries += 1;
      const name = entry.fileName.replaceAll("\\", "/");
      if (entries > config.maxEntries || name.startsWith("/") || name.split("/").includes("..")) {
        throw invalid("XLSX obsahuje nepovolenou strukturu.");
      }
      unpackedBytes += entry.uncompressedSize;
      if (unpackedBytes > config.maxUnpackedBytes) throw invalid("Rozbalený XLSX je příliš velký.");
      if (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > config.maxCompressionRatio)) {
        throw invalid("XLSX překračuje povolený kompresní poměr.");
      }
      const lower = name.toLowerCase();
      if (lower.includes("vbaproject") || lower.includes("externallinks") || lower.startsWith("customxml/")) {
        throw invalid("XLSX obsahuje makro, externí odkaz nebo vlastní XML.");
      }
      if (name === "[Content_Types].xml") hasContentTypes = true;
      if (name === "xl/workbook.xml") hasWorkbook = true;
    }
  } finally {
    zip.close();
  }
  if (!hasContentTypes || !hasWorkbook) throw invalid("XLSX nemá povinnou OOXML strukturu.");
}

export async function stageAndValidateXlsx(input: XlsxUploadInput, config: FileConfig): Promise<StagedXlsx> {
  const safeName = basename(input.fileName);
  if (safeName !== input.fileName || !safeName.toLowerCase().endsWith(".xlsx")) throw invalid("Je povolen pouze bezpečný název XLSX souboru.");
  if (input.contentType !== XLSX_MIME) throw invalid("Soubor nemá povolený typ XLSX.");
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0 || input.contentLength > config.maxUploadBytes) {
    throw invalid("Soubor překračuje povolenou velikost 25 MiB.");
  }
  const directory = await mkdtemp(join(tmpdir(), "sokol-xlsx-"));
  const path = join(directory, "upload.xlsx");
  const digest = createHash("sha256");
  let sizeBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > config.maxUploadBytes) {
        callback(invalid("Soubor překračuje povolenou velikost 25 MiB."));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  const timeout = setTimeout(() => {
    const abortable = input.body as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
    abortable.destroy?.(invalid("Nahrávání překročilo 120 sekund."));
  }, 120_000);
  try {
    await pipeline(input.body, limiter, createWriteStream(path, { flags: "wx" }));
    if (sizeBytes !== input.contentLength) throw invalid("Velikost souboru neodpovídá hlavičce požadavku.");
    const handle = await open(path, "r");
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, 0);
    await handle.close();
    if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw invalid("Soubor není platný ZIP/XLSX.");
    await inspectPackage(path, config);
    return { path, fileName: safeName, sizeBytes, sha256: digest.digest("hex"), cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof AuthError) throw error;
    throw invalid("Soubor není platný XLSX dokument.");
  } finally {
    clearTimeout(timeout);
  }
}

export function openStagedXlsx(staged: StagedXlsx) {
  return createReadStream(staged.path);
}

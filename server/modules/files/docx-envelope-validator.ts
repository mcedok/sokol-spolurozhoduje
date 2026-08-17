import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise, type Entry, type ZipFile } from "yauzl";
import { AuthError } from "../identity/auth-errors";
import type { FileConfig } from "./file-config";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface DocxUploadInput {
  fileName: string;
  contentType: string;
  contentLength: number;
  body: Readable;
}

export interface StagedDocx {
  path: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  cleanup(): Promise<void>;
}

function invalid(detail: string): AuthError {
  return new AuthError("INVALID_DOCX", detail, 400);
}

async function entryText(zip: ZipFile, entry: Entry, maximumBytes: number): Promise<string> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumBytes) throw invalid("Řídicí XML dokumentu je příliš velké.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function inspectPackage(path: string, config: FileConfig): Promise<void> {
  const zip = await openPromise(path, {
    autoClose: false,
    lazyEntries: true,
    validateEntrySizes: true,
  });
  const required = new Map<string, Entry>();
  let entries = 0;
  let unpackedBytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      entries += 1;
      if (entries > config.maxEntries) throw invalid("DOCX obsahuje příliš mnoho položek.");
      const name = entry.fileName.replaceAll("\\", "/");
      if (name.startsWith("/") || name.split("/").includes("..")) {
        throw invalid("DOCX obsahuje nebezpečnou cestu.");
      }
      unpackedBytes += entry.uncompressedSize;
      if (unpackedBytes > config.maxUnpackedBytes) {
        throw invalid("Rozbalený DOCX překračuje povolenou velikost.");
      }
      if (
        entry.uncompressedSize > 0
        && (entry.compressedSize === 0
          || entry.uncompressedSize / entry.compressedSize > config.maxCompressionRatio)
      ) {
        throw invalid("DOCX překračuje povolený kompresní poměr.");
      }
      const lower = name.toLowerCase();
      if (lower.endsWith("vbaproject.bin") || lower.startsWith("word/embeddings/")) {
        throw invalid("DOCX obsahuje nepovolený aktivní nebo vložený obsah.");
      }
      if (name === "[Content_Types].xml" || name === "word/document.xml") {
        required.set(name, entry);
      }
    }
    const contentTypes = required.get("[Content_Types].xml");
    const document = required.get("word/document.xml");
    if (!contentTypes || !document) throw invalid("DOCX nemá povinnou strukturu OOXML.");
    const contentTypesXml = await entryText(zip, contentTypes, 2 * 1024 * 1024);
    const documentXml = await entryText(zip, document, config.maxUnpackedBytes);
    if (!contentTypesXml.includes("wordprocessingml.document.main+xml")) {
      throw invalid("DOCX nemá hlavní Word dokument.");
    }
    if (!/<(?:w:)?document(?:\s|>)/i.test(documentXml)) {
      throw invalid("Hlavní XML dokumentu není platný Word dokument.");
    }
  } finally {
    zip.close();
  }
}

export async function stageAndValidateDocx(
  input: DocxUploadInput,
  config: FileConfig,
): Promise<StagedDocx> {
  const safeName = basename(input.fileName);
  if (!safeName.toLowerCase().endsWith(".docx") || safeName !== input.fileName) {
    throw invalid("Je povolen pouze bezpečný název souboru DOCX.");
  }
  if (input.contentType !== DOCX_MIME) throw invalid("Soubor nemá povolený typ DOCX.");
  if (
    !Number.isSafeInteger(input.contentLength)
    || input.contentLength <= 0
    || input.contentLength > config.maxUploadBytes
  ) {
    throw invalid("Soubor překračuje povolenou velikost 25 MiB.");
  }

  const directory = await mkdtemp(join(tmpdir(), "sokol-docx-"));
  const path = join(directory, "upload.docx");
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
  const timeout = setTimeout(() => input.body.destroy(invalid("Nahrávání překročilo 120 sekund.")), 120_000);
  try {
    await pipeline(input.body, limiter, createWriteStream(path, { flags: "wx" }));
    if (sizeBytes !== input.contentLength) throw invalid("Velikost souboru neodpovídá hlavičce požadavku.");
    const handle = await open(path, "r");
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, 0);
    await handle.close();
    if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw invalid("Soubor není platný ZIP/DOCX.");
    }
    await inspectPackage(path, config);
    return {
      path,
      fileName: safeName,
      sizeBytes,
      sha256: digest.digest("hex"),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof AuthError) throw error;
    throw invalid("Soubor není platný dokument DOCX.");
  } finally {
    clearTimeout(timeout);
  }
}

export function openStagedDocx(staged: StagedDocx): Readable {
  return createReadStream(staged.path);
}

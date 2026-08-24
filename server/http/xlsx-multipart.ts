import Busboy from "@fastify/busboy";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AuthError } from "../modules/identity/auth-errors";

export interface StreamedMultipartFile {
  fileName: string;
  contentType: string;
  body: NodeJS.ReadableStream;
  finished: Promise<void>;
  cleanup: () => Promise<void>;
}

export async function streamSingleXlsxPart(request: Request, maxBytes: number): Promise<StreamedMultipartFile> {
  if (!request.body) throw new AuthError("UPLOAD_BODY_REQUIRED", "Chybí XLSX soubor.", 400);
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new AuthError("UPLOAD_BODY_REQUIRED", "Požadavek musí být multipart/form-data.", 400);
  }
  const directory = await mkdtemp(join(tmpdir(), "sokol-xlsx-multipart-"));
  const path = join(directory, "upload.xlsx");
  try {
    let metadata: { fileName: string; contentType: string } | undefined;
    let fileWrite: Promise<void> | undefined;
    await new Promise<void>((resolve, reject) => {
    let found = false;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const parser = new Busboy({
      headers: { "content-type": contentType },
      limits: { files: 1, fields: 0, parts: 1 },
    });
    const source = Readable.fromWeb(request.body as never);
    parser.once("error", fail);
    parser.once("filesLimit", () => fail(new AuthError("UPLOAD_BODY_REQUIRED", "Je povolen právě jeden XLSX soubor.", 400)));
    parser.once("fieldsLimit", () => fail(new AuthError("UPLOAD_BODY_REQUIRED", "Multipart nesmí obsahovat formulářová pole.", 400)));
    parser.once("partsLimit", () => fail(new AuthError("UPLOAD_BODY_REQUIRED", "Multipart obsahuje neočekávané části.", 400)));
    parser.on("file", (fieldName, stream, fileName, _encoding, contentType) => {
      if (found || fieldName !== "file") {
        stream.resume();
        fail(new AuthError("UPLOAD_BODY_REQUIRED", "Chybí jediné pole file.", 400));
        return;
      }
      found = true;
      let received = 0;
      metadata = { fileName, contentType };
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > maxBytes) {
            callback(new AuthError("UPLOAD_TOO_LARGE", "Soubor překračuje povolenou velikost XLSX.", 413));
            return;
          }
          callback(null, chunk);
        },
      });
      limiter.once("error", (error) => {
        source.destroy(error);
        parser.destroy(error);
        fail(error);
      });
      stream.once("error", (error) => limiter.destroy(error));
      fileWrite = pipeline(stream, limiter, createWriteStream(path));
      fileWrite.catch((error) => fail(error as Error));
    });
    parser.once("finish", () => {
      if (!found) fail(new AuthError("UPLOAD_BODY_REQUIRED", "Chybí XLSX soubor.", 400));
      else if (!settled) {
        settled = true;
        resolve();
      }
    });
    source.once("error", fail).pipe(parser);
    });
    await fileWrite;
    if (!metadata) throw new AuthError("UPLOAD_BODY_REQUIRED", "Chybí XLSX soubor.", 400);
    return {
      ...metadata,
      body: createReadStream(path),
      finished: Promise.resolve(),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

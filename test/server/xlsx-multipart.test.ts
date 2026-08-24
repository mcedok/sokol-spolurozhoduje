import { describe, expect, it } from "vitest";
import { streamSingleXlsxPart } from "../../server/http/xlsx-multipart";

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("streamSingleXlsxPart", () => {
  function requestWithFile(name: string, content: string): Request {
    const boundary = "----sokol-xlsx-test";
    const body = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="${name}"\r\n`,
      "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n",
      content,
      `\r\n--${boundary}--\r\n`,
    ].join("");
    return new Request("http://localhost/upload", {
      method: "POST",
      body,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
  }

  it("streams exactly one XLSX file without materializing request.formData", async () => {
    const request = requestWithFile("workbook.xlsx", "PK\u0003\u0004payload");

    const file = await streamSingleXlsxPart(request, 1024);
    expect(file.fileName).toBe("workbook.xlsx");
    expect((await collect(file.body)).toString()).toBe("PK\u0003\u0004payload");
    await expect(file.finished).resolves.toBeUndefined();
    await file.cleanup();
  });

  it("aborts a file that crosses the streaming byte limit", async () => {
    const request = requestWithFile("large.xlsx", "0123456789");
    await expect(streamSingleXlsxPart(request, 4)).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
  });

  it("rejects an extra multipart part before exposing a file to persistence", async () => {
    const boundary = "----sokol-xlsx-extra";
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="workbook.xlsx"\r\n`,
      "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\nPK\u0003\u0004ok\r\n",
      `--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nforbidden\r\n`,
      `--${boundary}--\r\n`,
    ].join("");
    const request = new Request("http://localhost/upload", {
      method: "POST", body,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });

    await expect(streamSingleXlsxPart(request, 1024)).rejects.toMatchObject({
      code: "UPLOAD_BODY_REQUIRED",
    });
  });
});

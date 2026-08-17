import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { accept, actor } = vi.hoisted(() => ({
  accept: vi.fn(),
  actor: {
    userId: "0198f413-2a36-7000-8000-000000000001",
    role: "admin" as const,
    sessionId: "0198f413-2a36-7000-8000-000000000002",
  },
}));

vi.mock("../../server/http/user-route-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/http/user-route-utils")>(),
  actorForMutation: vi.fn().mockResolvedValue(actor),
}));

vi.mock("../../server/runtime", () => ({
  getIdentityRuntime: () => ({ uploads: { accept } }),
}));

import { POST } from "../../app/api/documents/[documentId]/versions/uploads/route";

describe("document upload route", () => {
  beforeEach(() => accept.mockReset());

  it("streams a DOCX to the upload service and returns its processing URL", async () => {
    const documentId = "0198f413-2a36-7000-8000-000000000003";
    const idempotencyKey = "0198f413-2a36-7000-8000-000000000004";
    const body = Buffer.from("PK\u0003\u0004test");
    accept.mockResolvedValue({
      versionId: "0198f413-2a36-7000-8000-000000000005",
      jobId: "0198f413-2a36-7000-8000-000000000006",
      status: "file_check",
    });
    const request = new Request(`http://localhost/api/documents/${documentId}/versions/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-length": String(body.length),
        "x-file-name": "navrh.docx",
        "idempotency-key": idempotencyKey,
        "if-match": 'W/"3"',
      },
      body,
    });

    const response = await POST(request, { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "file_check",
      processingUrl: `/api/conversion-jobs/0198f413-2a36-7000-8000-000000000006`,
    });
    expect(accept).toHaveBeenCalledWith(
      actor,
      documentId,
      expect.objectContaining({
        fileName: "navrh.docx",
        contentLength: body.length,
        rowVersion: 3,
        idempotencyKey,
        body: expect.any(Readable),
      }),
      expect.any(String),
    );
  });
});

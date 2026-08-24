import { describe, expect, it, vi } from "vitest";
import { createServerApiClient } from "../../app/data/server-api-client.js";
import { createDataServices } from "../../app/data/create-data-services.js";

describe("server API client", () => {
  it("sends cookies, CSRF and optimistic concurrency headers", async () => {
    const updated = { id: crypto.randomUUID(), title: "Nový název" };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ document: updated }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });
    const idempotencyKey = crypto.randomUUID();
    await client.normService.update("ignored-cookie-session", updated.id, {
      title: "Nový název",
      rowVersion: 3,
      idempotencyKey,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/documents/${updated.id}`,
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        headers: expect.objectContaining({
          "if-match": "3",
          "x-csrf-token": "csrf",
        }),
      }),
    );
  });

  it("selects browser data only when explicitly configured and rejects it in production", () => {
    const browserFactory = vi.fn(() => ({ backend: "browser" }));
    const serverFactory = vi.fn(() => ({ backend: "server" }));
    expect(
      createDataServices({
        env: { NEXT_PUBLIC_DATA_BACKEND: "browser", NODE_ENV: "development" },
        browserFactory,
        serverFactory,
      }),
    ).toEqual({ backend: "browser" });
    expect(() =>
      createDataServices({
        env: { NEXT_PUBLIC_DATA_BACKEND: "browser", NODE_ENV: "production" },
        browserFactory,
        serverFactory,
      }),
    ).toThrow(/production/i);
  });

  it("uploads a raw DOCX with exact security and concurrency headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      versionId: "version-1",
      jobId: "job-1",
      status: "file_check",
    }), { status: 202, headers: { "content-type": "application/json" } }));
    const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });
    const file = new File(["PK\u0003\u0004payload"], "návrh 1.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    await client.uploadDocumentVersion("document-1", file, {
      rowVersion: 4,
      idempotencyKey: "0198f413-2a36-7000-8000-000000000015",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/documents/document-1/versions/uploads",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: file,
        headers: expect.objectContaining({
          "content-type": file.type,
          "x-file-name": encodeURIComponent(file.name),
          "content-length": String(file.size),
          "x-csrf-token": "csrf",
          "if-match": "4",
          "idempotency-key": "0198f413-2a36-7000-8000-000000000015",
        }),
      }),
    );
  });

  it("exposes the complete conversion review API surface", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
    const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });
    const command = {
      rowVersion: 6,
      idempotencyKey: "0198f413-2a36-7000-8000-000000000015",
    };

    await client.getConversionProcessing("version-1");
    await client.getConversionPreview("version-1");
    await client.retryConversion("job-1", command);
    await client.updateBlockStructure("version-1", "block-1", {
      ...command,
      reason: "Oprava struktury",
      type: "heading",
      text: "Nadpis",
      commentable: true,
    });
    await client.decideConversionFinding("finding-1", {
      ...command,
      status: "resolved",
      reason: "Ověřeno",
    });
    await client.completeConversionReview("version-1", command);
    await client.createFileDownloadLink("file-1");

    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/api/document-versions/version-1/processing",
      "/api/document-versions/version-1/preview",
      "/api/conversion-jobs/job-1/retry",
      "/api/document-versions/version-1/blocks/block-1",
      "/api/conversion-findings/finding-1/decision",
      "/api/document-versions/version-1/review-completion",
      "/api/file-objects/file-1/download-link",
    ]);
  });
});

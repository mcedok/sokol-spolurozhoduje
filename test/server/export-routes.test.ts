import { beforeEach, describe, expect, it, vi } from "vitest";

const { actor, currentActor, actorForMutation, exportsService, downloads } = vi.hoisted(() => {
  const actor = {
    userId: "0198f413-2a36-7000-8000-000000000301",
    role: "admin" as const,
    sessionId: "0198f413-2a36-7000-8000-000000000302",
  };
  return {
    actor,
    currentActor: vi.fn().mockResolvedValue(actor),
    actorForMutation: vi.fn().mockResolvedValue(actor),
    exportsService: { createExport: vi.fn(), getExport: vi.fn(), getDownloadFileId: vi.fn() },
    downloads: { createReadLink: vi.fn() },
  };
});

vi.mock("../../server/http/route-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/http/route-utils")>(),
  currentActor,
}));
vi.mock("../../server/http/user-route-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/http/user-route-utils")>(),
  actorForMutation,
}));
vi.mock("../../server/runtime", () => ({
  getIdentityRuntime: () => ({ exports: exportsService, downloads }),
}));

const documentId = "0198f413-2a36-7000-8000-000000000310";
const versionId = "0198f413-2a36-7000-8000-000000000311";
const jobId = "0198f413-2a36-7000-8000-000000000312";
const fileId = "0198f413-2a36-7000-8000-000000000313";
const key = "0198f413-2a36-7000-8000-000000000314";

async function routes() {
  const [create, status, download] = await Promise.all([
    import("../../app/api/documents/[documentId]/exports/route"),
    import("../../app/api/export-jobs/[jobId]/route"),
    import("../../app/api/export-jobs/[jobId]/download-link/route"),
  ]);
  return { create: create.POST, status: status.GET, download: download.GET };
}

describe("PDF export routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an idempotent internal export through the CSRF-protected actor", async () => {
    const api = await routes();
    exportsService.createExport.mockResolvedValue({
      id: jobId,
      status: "queued",
      outputFileId: fileId,
    });
    const response = await api.create(new Request(
      `http://localhost/api/documents/${documentId}/exports`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": key,
        },
        body: JSON.stringify({
          documentVersionId: versionId,
          visibility: "internal",
          filters: { statuses: ["settled"] },
          options: { includeAuthorEmail: true },
        }),
      },
    ), { params: Promise.resolve({ documentId }) });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      id: jobId,
      status: "queued",
      downloadReady: false,
    });
    expect(exportsService.createExport).toHaveBeenCalledWith(actor, documentId, {
      documentVersionId: versionId,
      visibility: "internal",
      filters: { statuses: ["settled"], priorities: [], types: [] },
      options: {
        includeAuthorEmail: true,
        includeMembershipId: false,
        includeInternalNote: false,
      },
      idempotencyKey: key,
    }, expect.any(String));
  });

  it("returns no-store status and a short-lived authorized download URL", async () => {
    const api = await routes();
    exportsService.getExport.mockResolvedValue({
      id: jobId,
      status: "completed",
      outputFileId: fileId,
    });
    exportsService.getDownloadFileId.mockResolvedValue(fileId);
    downloads.createReadLink.mockResolvedValue({
      url: "https://storage.example/export.pdf?sig=secret",
      expiresAt: "2026-08-19T12:05:00.000Z",
    });

    const status = await api.status(
      new Request(`http://localhost/api/export-jobs/${jobId}`),
      { params: Promise.resolve({ jobId }) },
    );
    const download = await api.download(
      new Request(`http://localhost/api/export-jobs/${jobId}/download-link`),
      { params: Promise.resolve({ jobId }) },
    );

    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(exportsService.getDownloadFileId).toHaveBeenCalledWith(
      actor, jobId, expect.any(String),
    );
    expect(downloads.createReadLink).toHaveBeenCalledWith(actor, fileId, expect.any(String));
  });
});

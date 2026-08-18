import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "../../server/modules/identity/auth-errors";

const { actor, currentActor, actorForMutation, conversions, downloads } = vi.hoisted(() => {
  const actor = {
    userId: "0198f413-2a36-7000-8000-000000000001",
    role: "admin" as const,
    sessionId: "0198f413-2a36-7000-8000-000000000002",
  };
  return {
    actor,
    currentActor: vi.fn().mockResolvedValue(actor),
    actorForMutation: vi.fn().mockResolvedValue(actor),
    conversions: {
      getProcessing: vi.fn(),
      getPreview: vi.fn(),
      retry: vi.fn(),
      editBlockStructure: vi.fn(),
      decideFinding: vi.fn(),
      completeReview: vi.fn(),
    },
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
  getIdentityRuntime: () => ({ conversions, downloads }),
}));

import { GET as getProcessing } from "../../app/api/document-versions/[versionId]/processing/route";
import { GET as getPreview } from "../../app/api/document-versions/[versionId]/preview/route";
import { POST as completeReview } from "../../app/api/document-versions/[versionId]/review-completion/route";
import { PATCH as updateBlock } from "../../app/api/document-versions/[versionId]/blocks/[blockUid]/route";
import { POST as retryConversion } from "../../app/api/conversion-jobs/[jobId]/retry/route";
import { POST as decideFinding } from "../../app/api/conversion-findings/[findingId]/decision/route";
import { GET as createDownloadLink } from "../../app/api/file-objects/[fileId]/download-link/route";

const versionId = "0198f413-2a36-7000-8000-000000000010";
const blockUid = "0198f413-2a36-7000-8000-000000000011";
const jobId = "0198f413-2a36-7000-8000-000000000012";
const findingId = "0198f413-2a36-7000-8000-000000000013";
const fileId = "0198f413-2a36-7000-8000-000000000014";
const key = "0198f413-2a36-7000-8000-000000000015";

function writeRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf",
      "idempotency-key": key,
      "if-match": 'W/"7"',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("conversion review routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns no-store processing state without internal storage data", async () => {
    conversions.getProcessing.mockResolvedValue({
      versionId,
      jobId,
      jobStatus: "parsing",
      versionStatus: "conversion",
      step: "parsing",
      attemptCount: 1,
      errorCode: null,
      startedAt: "2026-08-18T12:00:00.000Z",
      completedAt: null,
    });

    const response = await getProcessing(
      new Request(`http://localhost/api/document-versions/${versionId}/processing`),
      { params: Promise.resolve({ versionId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toMatch(/objectKey|connectionString|sig=/i);
  });

  it("returns a redacted preview and maps a foreign-admin denial to 403", async () => {
    conversions.getPreview.mockResolvedValueOnce({
      id: versionId,
      documentId: crypto.randomUUID(),
      status: "conversion_review",
      rowVersion: 7,
      reviewCompletedAt: null,
      blocks: [{
        blockUid,
        blockRevisionId: crypto.randomUUID(),
        type: "paragraph",
        order: 0,
        commentable: true,
        text: "Bezpečný text",
        structuredContent: { runs: [{ text: "Bezpečný text" }] },
        assets: [{ id: fileId, purpose: "attachment", alternativeText: null }],
      }],
      findings: [],
    });
    const allowed = await getPreview(
      new Request(`http://localhost/api/document-versions/${versionId}/preview`),
      { params: Promise.resolve({ versionId }) },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).not.toMatch(/objectKey|connectionString|sig=/i);

    conversions.getPreview.mockRejectedValueOnce(
      new AuthError("FORBIDDEN", "Administrátor může číst jen vlastní dokumenty.", 403),
    );
    const denied = await getPreview(
      new Request(`http://localhost/api/document-versions/${versionId}/preview`),
      { params: Promise.resolve({ versionId }) },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("passes concurrency and idempotency commands to every mutation", async () => {
    conversions.retry.mockResolvedValue({ jobId, status: "queued", rowVersion: 8 });
    conversions.editBlockStructure.mockResolvedValue({ blockUid, rowVersion: 8 });
    conversions.decideFinding.mockResolvedValue({ id: findingId, status: "resolved", rowVersion: 8 });
    conversions.completeReview.mockResolvedValue({ id: versionId, status: "ready", rowVersion: 8 });

    expect((await retryConversion(
      writeRequest(`/api/conversion-jobs/${jobId}/retry`, {}),
      { params: Promise.resolve({ jobId }) },
    )).status).toBe(200);
    expect((await updateBlock(
      new Request(`http://localhost/api/document-versions/${versionId}/blocks/${blockUid}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": key,
          "if-match": 'W/"7"',
        },
        body: JSON.stringify({
          reason: "Oprava struktury",
          type: "paragraph",
          text: "Bezpečný text",
          commentable: true,
        }),
      }),
      { params: Promise.resolve({ versionId, blockUid }) },
    )).status).toBe(200);
    expect((await decideFinding(
      writeRequest(`/api/conversion-findings/${findingId}/decision`, {
        status: "resolved",
        reason: "Ověřeno proti originálu",
      }),
      { params: Promise.resolve({ findingId }) },
    )).status).toBe(200);
    expect((await completeReview(
      writeRequest(`/api/document-versions/${versionId}/review-completion`, {}),
      { params: Promise.resolve({ versionId }) },
    )).status).toBe(200);

    expect(conversions.retry).toHaveBeenCalledWith(actor, jobId, {
      rowVersion: 7,
      idempotencyKey: key,
    }, expect.any(String));
    expect(conversions.editBlockStructure).toHaveBeenCalledWith(
      actor,
      versionId,
      blockUid,
      expect.objectContaining({
        reason: "Oprava struktury",
        rowVersion: 7,
        idempotencyKey: key,
      }),
      expect.any(String),
    );
    expect(conversions.decideFinding).toHaveBeenCalledWith(
      actor,
      findingId,
      "resolved",
      "Ověřeno proti originálu",
      { rowVersion: 7, idempotencyKey: key },
      expect.any(String),
    );
    expect(conversions.completeReview).toHaveBeenCalledWith(actor, versionId, {
      rowVersion: 7,
      idempotencyKey: key,
    }, expect.any(String));
  });

  it("returns only a short-lived authorized file URL", async () => {
    downloads.createReadLink.mockResolvedValue({
      url: "https://storage.example/object?sig=secret",
      expiresAt: "2026-08-18T12:05:00.000Z",
    });

    const response = await createDownloadLink(
      new Request(`http://localhost/api/file-objects/${fileId}/download-link`),
      { params: Promise.resolve({ fileId }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://storage.example/object?sig=secret",
      expiresAt: "2026-08-18T12:05:00.000Z",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

import { describe, expect, it, vi } from "vitest";
import { adaptBootstrapForPilotUi, createServerApiClient } from "../../app/data/server-api-client.js";
import { createDataServices } from "../../app/data/create-data-services.js";

describe("server API client", () => {
  it("loads converted blocks and sends real block participation mutations", async () => {
    const blockUid = "0198f413-2a36-7000-8000-000000000010";
    const detail = {
      publicId: "SOKOL-2026-010",
      title: "Norma",
      explanatoryReport: "Důvod",
      responsibleAdminName: "Anna Správce",
      status: "published_open",
      commentsOpen: true,
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      documentRevision: 4,
      participationVersion: 7,
      version: {
        versionNumber: 2,
        publishedAt: "2026-08-01T00:00:00.000Z",
        originalName: "norma.docx",
        blocks: [{
          blockUid,
          blockRevisionId: "0198f413-2a36-7000-8000-000000000011",
          type: "paragraph",
          order: 0,
          commentable: true,
          text: "Převedený text",
          structuredContent: { runs: [{ text: "Převedený text", bold: true }] },
        }],
      },
      threads: [],
      needVotes: { yes: 0, no: 0, currentUserVote: null },
    };
    const fetchImpl = vi.fn(async (path) => {
      if (path === "/api/public/documents/SOKOL-2026-010") {
        return new Response(JSON.stringify({ document: detail }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });

    const loaded = await client.normService.loadDetail("SOKOL-2026-010");
    await client.normService.addContribution("session", "SOKOL-2026-010", {
      blockUid,
      kind: "Návrh úpravy",
      text: "Nové znění",
      priority: "high",
      participationVersion: 7,
    });
    await client.normService.reply("session", "SOKOL-2026-010", "PRIP-2026-000001", "Odpověď", 7);
    await client.normService.voteSubmission("session", "SOKOL-2026-010", "PRIP-2026-000001", 1, 3, 7);
    await client.normService.voteNeed("session", "SOKOL-2026-010", "yes", 7);

    expect(loaded).toMatchObject({
      number: "SOKOL-2026-010",
      version: "2",
      file: { name: "norma.docx" },
      content: [{ blockUid, text: "Převedený text" }],
      participationVersion: 7,
    });
    expect(fetchImpl.mock.calls.slice(1).map(([path]) => path)).toEqual([
      `/api/public/documents/SOKOL-2026-010/blocks/${blockUid}/comments`,
      "/api/public/comments/PRIP-2026-000001/replies",
      "/api/public/comments/PRIP-2026-000001/vote",
      "/api/public/documents/SOKOL-2026-010/need-vote",
    ]);
    expect(fetchImpl.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "if-match": "7", "x-csrf-token": "csrf" }),
      body: JSON.stringify({ type: "proposal", text: "Nové znění", priority: "high" }),
    }));
  });

  it("requests the authenticated original DOCX by public document number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      url: "https://storage.example.test/original.docx",
      name: "norma.docx",
      expiresAt: "2026-08-28T12:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });

    await expect(client.createPublicOriginalDownloadLink("SOKOL-2026-010"))
      .resolves.toMatchObject({ name: "norma.docx" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/public/documents/SOKOL-2026-010/original-download-link",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("preserves conversion workflow states instead of presenting them as concepts", () => {
    const snapshot = adaptBootstrapForPilotUi({
      viewer: null,
      organizations: [],
      capabilities: {},
      documents: [],
      managedDocuments: [{
        id: "document-1", publicId: "SOKOL-2026-001", title: "Norma",
        status: "conversion_review", explanatoryReport: "Důvod", visibilityMode: "public_detail",
      }],
    });

    expect(snapshot.managedNorms[0]).toMatchObject({
      status: "Kontrola převodu",
      serverStatus: "conversion_review",
    });
  });

  it("recovers a CSRF token for an authenticated cookie session after a page reload", async () => {
    const fetchImpl = vi.fn(async (path) => {
      if (path === "/api/bootstrap") {
        return new Response(JSON.stringify({
          viewer: {
            id: "admin-1",
            firstName: "Petr",
            lastName: "Novák",
            organizationName: "Česká obec sokolská",
            role: "admin",
            emailVerifiedAt: "2026-08-25T00:00:00.000Z",
          },
          organizations: [],
          capabilities: { manageUsers: false, createDocument: true },
          documents: [],
          managedDocuments: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/api/auth/session/csrf") {
        return new Response(JSON.stringify({ csrfToken: "restored-csrf-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/documents") {
        return new Response(JSON.stringify({ document: {
          id: "document-1",
          publicId: "SOKOL-2026-001",
          title: "Zkušební norma",
          explanatoryReport: "Důvodová zpráva",
          visibilityMode: "public_detail",
          fourEyesRequired: false,
          status: "concept",
          rowVersion: 1,
        } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const client = createServerApiClient({ fetchImpl });

    await client.bootstrap();
    await client.normService.create("server-cookie", {
      title: "Zkušební norma",
      reason: "Důvodová zpráva",
    });

    const createRequest = fetchImpl.mock.calls.find(([path]) => path === "/api/documents");
    expect(createRequest?.[1]?.headers).toMatchObject({
      "x-csrf-token": "restored-csrf-token",
    });
  });

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

  it("after saving metadata performs the requested document status transition with the fresh row version", async () => {
    const documentId = crypto.randomUUID();
    const base = {
      id: documentId, publicId: "SOKOL-2026-010", title: "Norma", explanatoryReport: "Důvod",
      visibilityMode: "public_detail", fourEyesRequired: false, status: "ready", rowVersion: 8,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { ...base, rowVersion: 9 } }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: {
        ...base, status: "published_open", commentsOpen: true, rowVersion: 10,
      } }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });

    const result = await client.normService.update("ignored", documentId, {
      title: "Norma", status: "K připomínkování", rowVersion: 8,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]).toEqual([
      `/api/documents/${documentId}/status`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "if-match": "9", "x-csrf-token": "csrf" }),
        body: JSON.stringify({ status: "published_open", reason: "" }),
      }),
    ]);
    expect(result.norm).toMatchObject({ status: "K připomínkování", serverStatus: "published_open", commentsOpen: true });
  });

  it("creates a document and immediately queues its selected DOCX for conversion", async () => {
    const createdDocument = {
      id: "document-1",
      publicId: "SOKOL-2026-001",
      title: "Zkušební norma",
      explanatoryReport: "Důvodová zpráva",
      visibilityMode: "public_detail",
      fourEyesRequired: false,
      status: "concept",
      rowVersion: 1,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: createdDocument }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        versionId: "version-1",
        jobId: "job-1",
        status: "file_check",
      }), { status: 202, headers: { "content-type": "application/json" } }));
    const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });
    const file = new File(["PK\u0003\u0004payload"], "návrh.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const result = await client.normService.create("server-cookie", {
      title: "Zkušební norma",
      reason: "Důvodová zpráva",
    }, file);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/documents");
    expect(fetchImpl.mock.calls[1]).toEqual([
      "/api/documents/document-1/versions/uploads",
      expect.objectContaining({
        method: "POST",
        body: file,
        headers: expect.objectContaining({
          "content-type": file.type,
          "content-length": String(file.size),
          "x-file-name": encodeURIComponent(file.name),
          "if-match": "1",
          "x-csrf-token": "csrf",
        }),
      }),
    ]);
    expect(result).toEqual(expect.objectContaining({
      norm: expect.objectContaining({ id: "document-1", rowVersion: 1 }),
      upload: expect.objectContaining({ versionId: "version-1", jobId: "job-1" }),
    }));
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

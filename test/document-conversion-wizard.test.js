import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { DocumentConversionWizard } from "../app/components/admin/DocumentConversionWizard.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const documentRecord = {
  id: "document-1",
  title: "Zkušební řád",
  number: "SOKOL-2026-001",
  rowVersion: 3,
};

function preview({ blocking = false } = {}) {
  return {
    id: "version-1",
    documentId: documentRecord.id,
    status: "conversion_review",
    rowVersion: 4,
    reviewCompletedAt: null,
    referenceFileId: "reference-file-1",
    blocks: [{
      blockUid: "block-1",
      blockRevisionId: "revision-1",
      type: "heading",
      order: 0,
      commentable: true,
      text: "Úvodní ustanovení",
      structuredContent: { runs: [{ text: "Úvodní ustanovení", bold: true }] },
      assets: [],
    }],
    findings: blocking ? [{
      id: "finding-1",
      jobId: "job-1",
      blockUid: "block-1",
      code: "ALT_TEXT_REQUIRED",
      severity: "blocking",
      status: "open",
      message: "Doplňte alternativní popis.",
      decisionReason: null,
    }] : [],
  };
}

function apiDouble({ processing, previewValue } = {}) {
  return {
    uploadDocumentVersion: vi.fn().mockResolvedValue({
      versionId: "version-1",
      jobId: "job-1",
      status: "file_check",
    }),
    getConversionProcessing: vi.fn().mockResolvedValue(processing ?? {
      versionId: "version-1",
      jobId: "job-1",
      jobStatus: "scanning",
      versionStatus: "file_check",
      step: "file_check",
      attemptCount: 1,
      errorCode: null,
    }),
    getConversionPreview: vi.fn().mockResolvedValue(previewValue ?? preview()),
    retryConversion: vi.fn(),
    updateBlockStructure: vi.fn().mockResolvedValue({ rowVersion: 5 }),
    decideConversionFinding: vi.fn(),
    completeConversionReview: vi.fn().mockResolvedValue({ status: "ready", rowVersion: 5 }),
    generateVersionMappings: vi.fn().mockResolvedValue({
      id: "mapping-run-1",
      targetVersionId: "version-1",
      status: "review_required",
      mappings: [],
    }),
    getVersionMappings: vi.fn().mockResolvedValue({
      id: "mapping-run-1",
      targetVersionId: "version-1",
      status: "review_required",
      mappings: [],
    }),
    decideVersionMapping: vi.fn(),
    createFileDownloadLink: vi.fn(),
  };
}

describe("DocumentConversionWizard", () => {
  it("accepts only DOCX and announces antivirus processing", async () => {
    const user = userEvent.setup();
    const api = apiDouble();
    render(h(DocumentConversionWizard, { document: documentRecord, api }));

    const input = screen.getByLabelText("Nahrát dokument DOCX");
    expect(input).toHaveAttribute("accept", `.${"docx"},${DOCX_MIME}`);
    const file = new File(["PK\u0003\u0004payload"], "návrh.docx", { type: DOCX_MIME });
    await user.upload(input, file);

    expect(await screen.findByRole("status")).toHaveTextContent("Antivirová kontrola");
    expect(api.uploadDocumentVersion).toHaveBeenCalledWith(
      documentRecord.id,
      file,
      expect.objectContaining({ rowVersion: 3, idempotencyKey: expect.any(String) }),
    );
  });

  it("shows mobile preview tabs and blocks completion while a blocking finding is open", async () => {
    const user = userEvent.setup();
    const api = apiDouble({
      processing: {
        versionId: "version-1",
        jobId: "job-1",
        jobStatus: "completed",
        versionStatus: "conversion_review",
        step: "completed",
        attemptCount: 1,
        errorCode: null,
      },
      previewValue: preview({ blocking: true }),
    });
    render(h(DocumentConversionWizard, { document: documentRecord, api }));
    await user.upload(
      screen.getByLabelText("Nahrát dokument DOCX"),
      new File(["PK\u0003\u0004payload"], "návrh.docx", { type: DOCX_MIME }),
    );

    expect(await screen.findByRole("tab", { name: "Webový dokument" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Referenční náhled" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Potvrdit náhled" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Doplňte alternativní popis");
  });

  it("keeps converted text read-only and requires a reason before saving structure", async () => {
    const user = userEvent.setup();
    const api = apiDouble({
      processing: {
        versionId: "version-1",
        jobId: "job-1",
        jobStatus: "completed",
        versionStatus: "conversion_review",
        step: "completed",
        attemptCount: 1,
        errorCode: null,
      },
    });
    render(h(DocumentConversionWizard, { document: documentRecord, api }));
    await user.upload(
      screen.getByLabelText("Nahrát dokument DOCX"),
      new File(["PK\u0003\u0004payload"], "návrh.docx", { type: DOCX_MIME }),
    );

    const block = await screen.findByRole("article", { name: "Blok 1" });
    await user.click(within(block).getByRole("button", { name: "Upravit strukturu" }));
    expect(screen.getByRole("textbox", { name: "Text bloku" })).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "Důvod strukturální opravy" })).toBeRequired();
    await user.click(screen.getByRole("button", { name: "Uložit strukturu" }));
    expect(api.updateBlockStructure).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole("textbox", { name: "Důvod strukturální opravy" }),
      "Oprava typu podle originálu",
    );
    await user.click(screen.getByRole("button", { name: "Uložit strukturu" }));
    await waitFor(() => expect(api.updateBlockStructure).toHaveBeenCalledWith(
      "version-1",
      "block-1",
      expect.objectContaining({
        reason: "Oprava typu podle originálu",
        text: "Úvodní ustanovení",
        rowVersion: 4,
      }),
    ));
  });

  it("reloads a conflicting preview without losing the administrator draft", async () => {
    const user = userEvent.setup();
    const api = apiDouble({
      processing: {
        versionId: "version-1", jobId: "job-1", jobStatus: "completed",
        versionStatus: "conversion_review", step: "completed", attemptCount: 1,
      },
    });
    api.updateBlockStructure.mockRejectedValueOnce(Object.assign(new Error("Konflikt"), { status: 409 }));
    render(h(DocumentConversionWizard, { document: documentRecord, api }));
    await user.upload(screen.getByLabelText("Nahrát dokument DOCX"), new File(
      ["PK\u0003\u0004payload"], "návrh.docx", { type: DOCX_MIME },
    ));
    const block = await screen.findByRole("article", { name: "Blok 1" });
    await user.click(within(block).getByRole("button", { name: "Upravit strukturu" }));
    const reason = screen.getByRole("textbox", { name: "Důvod strukturální opravy" });
    await user.type(reason, "Moje rozepsané rozhodnutí");
    await user.click(screen.getByRole("button", { name: "Uložit strukturu" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("mezitím změnil jiný správce");
    expect(reason).toHaveValue("Moje rozepsané rozhodnutí");
    await waitFor(() => expect(api.getConversionPreview).toHaveBeenCalledTimes(2));
  });

  it("refreshes the catalog after a successful review without passing session input", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    const api = apiDouble({
      processing: {
        versionId: "version-1", jobId: "job-1", jobStatus: "completed",
        versionStatus: "conversion_review", step: "completed", attemptCount: 1,
      },
    });
    render(h(DocumentConversionWizard, { document: documentRecord, api, onReady }));
    await user.upload(screen.getByLabelText("Nahrát dokument DOCX"), new File(
      ["PK\u0003\u0004payload"], "návrh.docx", { type: DOCX_MIME },
    ));
    await user.click(await screen.findByRole("button", { name: "Potvrdit náhled" }));
    await waitFor(() => expect(api.generateVersionMappings).toHaveBeenCalledWith(
      "version-1",
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    ));
    await waitFor(() => expect(onReady).toHaveBeenCalledWith());
  });

  it("renders converted emphasis, safe links, lists and tables semantically", async () => {
    const user = userEvent.setup();
    const semanticPreview = preview();
    semanticPreview.blocks = [
      {
        ...semanticPreview.blocks[0],
        structuredContent: { level: 2, runs: [{ text: "Úvodní", bold: true }, { text: " ustanovení" }] },
      },
      {
        ...semanticPreview.blocks[0], blockUid: "block-2", blockRevisionId: "revision-2",
        type: "list_item", order: 1, text: "Důležitý odkaz",
        structuredContent: { listKind: "bullet", runs: [{ text: "Důležitý", italic: true }, { text: " odkaz", href: "https://www.sokol.eu/" }] },
      },
      {
        ...semanticPreview.blocks[0], blockUid: "block-3", blockRevisionId: "revision-3",
        type: "table", order: 2, text: "A | B",
        structuredContent: { rows: [[{ text: "A" }, { text: "B" }]] },
      },
    ];
    const api = apiDouble({
      processing: {
        versionId: "version-1", jobId: "job-1", jobStatus: "completed",
        versionStatus: "conversion_review", step: "completed", attemptCount: 1,
      },
      previewValue: semanticPreview,
    });
    render(h(DocumentConversionWizard, { document: documentRecord, api }));
    await user.upload(screen.getByLabelText("Nahrát dokument DOCX"), new File(
      ["PK\u0003\u0004payload"], "návrh.docx", { type: DOCX_MIME },
    ));

    expect(await screen.findByText("Úvodní")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText("Důležitý")).toHaveProperty("tagName", "EM");
    expect(screen.getByRole("link", { name: "odkaz" })).toHaveAttribute("href", "https://www.sokol.eu/");
    expect(screen.getByRole("list")).toBeVisible();
    expect(screen.getByRole("table")).toHaveTextContent("AB");
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";

async function loadComponent() {
  return import("../app/components/admin/PdfExportPanel.js");
}

const documentRecord = {
  id: "0198f413-2a36-7000-8000-000000000401",
  title: "Jednací řád",
  number: "SOKOL-2026-401",
  latestReadyVersionId: "0198f413-2a36-7000-8000-000000000402",
};

function apiDouble() {
  return {
    createPdfExport: vi.fn().mockResolvedValue({
      id: "0198f413-2a36-7000-8000-000000000403",
      status: "completed",
      visibility: "internal",
      downloadReady: true,
    }),
    getPdfExport: vi.fn(),
    getPdfExportDownloadLink: vi.fn().mockResolvedValue({
      url: "https://storage.example/export.pdf?sig=short-lived",
      expiresAt: "2026-08-19T12:05:00.000Z",
    }),
  };
}

describe("PdfExportPanel", () => {
  it("creates an explicit internal export and obtains a short-lived link", async () => {
    const { PdfExportPanel } = await loadComponent();
    const api = apiDouble();
    const user = userEvent.setup();
    render(h(PdfExportPanel, { document: documentRecord, api, canManage: true }));

    await user.click(screen.getByRole("radio", { name: "Interní PDF" }));
    await user.click(screen.getByRole("checkbox", { name: "E-mail autora" }));
    await user.click(screen.getByRole("checkbox", { name: "Vypořádané" }));
    await user.click(screen.getByRole("checkbox", { name: "Vysoká priorita" }));
    await user.click(screen.getByRole("checkbox", { name: "Návrhy" }));
    await user.click(screen.getByRole("button", { name: "Vytvořit PDF" }));

    await waitFor(() => expect(api.createPdfExport).toHaveBeenCalledWith(
      documentRecord.id,
      expect.objectContaining({
        documentVersionId: documentRecord.latestReadyVersionId,
        visibility: "internal",
        filters: {
          statuses: ["settled"],
          priorities: ["high"],
          types: ["proposal"],
        },
        options: {
          includeAuthorEmail: true,
          includeMembershipId: false,
          includeInternalNote: false,
        },
        idempotencyKey: expect.any(String),
      }),
    ));
    expect(await screen.findByRole("status")).toHaveTextContent("Export je připraven");
    await user.click(screen.getByRole("button", { name: "Připravit stažení" }));
    const link = await screen.findByRole("link", { name: "Stáhnout PDF" });
    expect(link).toHaveAttribute("href", "https://storage.example/export.pdf?sig=short-lived");
  });

  it("is hidden without document management capability", async () => {
    const { PdfExportPanel } = await loadComponent();
    const api = apiDouble();
    const { container } = render(h(PdfExportPanel, {
      document: documentRecord,
      api,
      canManage: false,
    }));
    expect(container).toBeEmptyDOMElement();
    expect(api.createPdfExport).not.toHaveBeenCalled();
  });
});

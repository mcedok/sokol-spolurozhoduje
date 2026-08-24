import { createElement as h } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { XlsxWorkingPanel } from "../app/components/admin/XlsxWorkingPanel.js";

describe("XlsxWorkingPanel", () => {
  it("hides the administrative workflow from users without document management permission", () => {
    render(h(XlsxWorkingPanel, { document: { id: "doc-1" }, canManage: false }));
    expect(screen.queryByRole("heading", { name: "Pracovní XLSX" })).not.toBeInTheDocument();
  });

  it("covers export, accessible upload, server-applied safe phase and an explicit conflict decision", async () => {
    const user = userEvent.setup();
    const api = {
      createXlsxExport: vi.fn().mockResolvedValue({ id: "job-1", status: "completed", downloadReady: true }),
      getXlsxExportDownloadLink: vi.fn().mockResolvedValue({ url: "https://files.example/export.xlsx" }),
      uploadXlsxImport: vi.fn().mockResolvedValue({
        id: "batch-1", status: "comparing", rowVersion: 2,
        counts: { safeChange: 1, conflict: 1, invalid: 0 },
      }),
      getXlsxImport: vi.fn().mockResolvedValue({
        id: "batch-1", status: "awaiting_resolution", rowVersion: 3,
        counts: { safeChange: 1, conflict: 1, invalid: 0 },
      }),
      getXlsxImportRows: vi.fn().mockResolvedValue({ total: 1, undecidedTotal: 1, rows: [{
        id: "row-1", sourceRowNumber: 2, classification: "conflict", rowVersion: 1,
        base: { priority: "normal" }, current: { priority: "critical" }, incoming: { priority: "high" },
        validationErrors: [],
      }] }),
      decideXlsxConflict: vi.fn().mockResolvedValue({ rowId: "row-1", decision: "use_xlsx", classification: "conflict", rowVersion: 2 }),
      applyXlsxConflicts: vi.fn().mockResolvedValue({ applied: 1, skipped: 0, status: "completed" }),
    };
    render(h(XlsxWorkingPanel, {
      document: { id: "doc-1", latestReadyVersionId: "version-1" }, api, canManage: true,
    }));

    await user.click(screen.getByRole("button", { name: "Vytvořit XLSX" }));
    await user.click(await screen.findByRole("button", { name: "Připravit odkaz ke stažení" }));
    expect(await screen.findByRole("link", { name: "Stáhnout pracovní XLSX" }))
      .toHaveAttribute("href", "https://files.example/export.xlsx");

    const input = screen.getByLabelText("Nahrát upravený XLSX");
    expect(input).not.toHaveAttribute("hidden");
    await user.upload(input, new File(["xlsx"], "upraveny.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));

    await waitFor(() => expect(screen.getByText(/Import: čeká na rozhodnutí/)).toBeInTheDocument());
    const conflict = await screen.findByRole("group", { name: "Konflikt na řádku 2" });
    expect(within(conflict).getByText(/Systém.*critical/)).toBeInTheDocument();
    expect(within(conflict).getByText(/XLSX.*high/)).toBeInTheDocument();
    await user.click(within(conflict).getByRole("button", { name: "Použít XLSX" }));
    await user.click(screen.getByRole("button", { name: "Použít rozhodnutí konfliktů" }));
    expect(await screen.findByText(/Import: dokončeno/)).toBeInTheDocument();
  });

  it("lets an administrator cancel a non-final import with its current version", async () => {
    const user = userEvent.setup();
    const api = {
      createXlsxExport: vi.fn().mockResolvedValue({ id: "job-2", status: "completed" }),
      uploadXlsxImport: vi.fn().mockResolvedValue({ id: "batch-2", status: "awaiting_resolution", rowVersion: 4 }),
      getXlsxImport: vi.fn().mockResolvedValue({ id: "batch-2", status: "awaiting_resolution", rowVersion: 4 }),
      getXlsxImportRows: vi.fn().mockResolvedValue({ rows: [] }),
      cancelXlsxImport: vi.fn().mockResolvedValue(undefined),
    };
    render(h(XlsxWorkingPanel, {
      document: { id: "doc-1", latestReadyVersionId: "version-1" }, api, canManage: true,
    }));

    await user.click(screen.getByRole("button", { name: "Vytvořit XLSX" }));
    await user.upload(screen.getByLabelText("Nahrát upravený XLSX"), new File(["xlsx"], "upraveny.xlsx"));
    await user.click(await screen.findByRole("button", { name: "Zrušit import" }));

    expect(api.cancelXlsxImport).toHaveBeenCalledWith("batch-2", 4);
    expect(await screen.findByText(/Import: zrušeno/)).toBeInTheDocument();
  });

  it("offers a safe retry for a failed archived import", async () => {
    const user = userEvent.setup();
    const api = {
      createXlsxExport: vi.fn().mockResolvedValue({ id: "job-retry", status: "completed" }),
      uploadXlsxImport: vi.fn().mockResolvedValue({
        id: "batch-retry", status: "failed", rowVersion: 3,
        counts: { safeChange: 0, conflict: 0, invalid: 0 },
      }),
      retryXlsxImport: vi.fn().mockResolvedValue({ status: "uploaded", rowVersion: 4 }),
    };
    render(h(XlsxWorkingPanel, {
      document: { id: "doc-1", latestReadyVersionId: "version-1" },
      canManage: true,
      api,
    }));

    await user.click(screen.getByRole("button", { name: "Vytvořit XLSX" }));
    const input = screen.getByLabelText("Nahrát upravený XLSX");
    await user.upload(input, new File(["xlsx"], "working.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));

    await user.click(await screen.findByRole("button", { name: "Zkusit import znovu" }));
    expect(api.retryXlsxImport).toHaveBeenCalledWith(expect.any(String), 3);
    expect(screen.getByText(/Import byl znovu zařazen/)).toBeVisible();
  });

  it("pages conflict cards instead of rendering the whole import at once", async () => {
    const user = userEvent.setup();
    const conflicts = Array.from({ length: 101 }, (_, index) => ({
      id: `row-${index + 1}`, sourceRowNumber: index + 2, classification: "conflict",
      rowVersion: 1, base: {}, current: {}, incoming: {}, validationErrors: [],
    }));
    const api = {
      createXlsxExport: vi.fn().mockResolvedValue({ id: "job-pages", status: "completed" }),
      uploadXlsxImport: vi.fn().mockResolvedValue({
        id: "batch-pages", status: "awaiting_resolution", rowVersion: 2,
        counts: { safeChange: 0, conflict: 101, invalid: 1 },
      }),
      getXlsxImport: vi.fn().mockResolvedValue({
        id: "batch-pages", status: "awaiting_resolution", rowVersion: 2,
        counts: { safeChange: 0, conflict: 101, invalid: 1 },
      }),
      getXlsxImportRows: vi.fn().mockImplementation((_batchId, classification, offset) => {
        if (classification === "invalid") return Promise.resolve({ total: 1, undecidedTotal: 1, rows: offset === 0 ? [{
          id: "invalid-1", sourceRowNumber: 500, validationErrors: ["INVALID_TARGET_VERSION"],
        }] : [] });
        return Promise.resolve({ total: 101, undecidedTotal: 101, rows: conflicts.slice(offset, offset + 100) });
      }),
    };
    render(h(XlsxWorkingPanel, {
      document: { id: "doc-1", latestReadyVersionId: "version-1" }, api, canManage: true,
    }));

    await user.click(screen.getByRole("button", { name: "Vytvořit XLSX" }));
    await user.upload(screen.getByLabelText("Nahrát upravený XLSX"), new File(["xlsx"], "working.xlsx"));

    expect(await screen.findByRole("group", { name: "Konflikt na řádku 101" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Konflikt na řádku 102" })).not.toBeInTheDocument();
    expect(await screen.findByText("INVALID_TARGET_VERSION")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Další konflikty" }));
    expect(await screen.findByRole("group", { name: "Konflikt na řádku 102" })).toBeVisible();
    expect(api.getXlsxImportRows).toHaveBeenCalledWith("batch-pages", "conflict", 100);
  });
});

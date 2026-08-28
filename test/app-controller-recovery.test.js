import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppController } from "../app/hooks/use-app-controller.js";

const STORAGE_KEY = "sokol-spolurozhoduje-pilot-v2";

describe("obnova lokálních demo dat", () => {
  it("zpřístupní navazující mapování verzí po potvrzení převodu", async () => {
    const createServices = () => ({
      backend: "server",
      auth: { ensureDemoCredentials: vi.fn().mockResolvedValue(undefined) },
      bootstrap: vi.fn().mockResolvedValue({ viewer: null, norms: [], organizations: [] }),
      normService: { listPublicNorms: () => [], listManageable: () => [] },
      userService: {},
      audit: {},
      generateVersionMappings: vi.fn().mockResolvedValue({ id: "mapping-run-1" }),
      getVersionMappings: vi.fn().mockResolvedValue({ id: "mapping-run-1", mappings: [] }),
      decideVersionMapping: vi.fn().mockResolvedValue({ status: "confirmed" }),
    });
    const { result } = renderHook(() => useAppController({ createServices }));
    await waitFor(() => expect(result.current.actions.ready).toBe(true));

    await expect(result.current.normCatalog.actions.generateVersionMappings("version-1", {
      idempotencyKey: "mapping-key-1",
    })).resolves.toEqual({ id: "mapping-run-1" });
    await expect(result.current.normCatalog.actions.getVersionMappings("version-1")).resolves.toEqual({
      id: "mapping-run-1", mappings: [],
    });
    await expect(result.current.normCatalog.actions.decideVersionMapping("mapping-1", {
      decision: "confirmed",
    })).resolves.toEqual({ status: "confirmed" });
  });

  it("zpřístupní administračnímu panelu celý pracovní XLSX tok", async () => {
    const createXlsxExport = vi.fn().mockResolvedValue({ id: "xlsx-job-1", status: "queued" });
    const getXlsxExport = vi.fn().mockResolvedValue({ id: "xlsx-job-1", status: "completed" });
    const getXlsxExportDownloadLink = vi.fn().mockResolvedValue({ url: "https://example.test/export.xlsx" });
    const createServices = () => ({
      backend: "server",
      auth: { ensureDemoCredentials: vi.fn().mockResolvedValue(undefined) },
      bootstrap: vi.fn().mockResolvedValue({ viewer: null, norms: [], organizations: [] }),
      normService: { listPublicNorms: () => [], listManageable: () => [] },
      userService: {}, audit: {}, createXlsxExport, getXlsxExport, getXlsxExportDownloadLink,
    });
    const { result } = renderHook(() => useAppController({ createServices }));
    await waitFor(() => expect(result.current.actions.ready).toBe(true));

    await expect(result.current.normCatalog.actions.createXlsxExport("document-1", "version-1"))
      .resolves.toMatchObject({ id: "xlsx-job-1" });
    await expect(result.current.normCatalog.actions.getXlsxExport("xlsx-job-1"))
      .resolves.toMatchObject({ status: "completed" });
    await expect(result.current.normCatalog.actions.getXlsxExportDownloadLink("xlsx-job-1"))
      .resolves.toMatchObject({ url: "https://example.test/export.xlsx" });
  });

  it("úspěšnou serverovou inicializaci spustí pouze jednou", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ viewer: null, norms: [], organizations: [] });
    const { result } = renderHook(() => useAppController({
      createServices: () => ({
        backend: "server",
        auth: { ensureDemoCredentials: vi.fn().mockResolvedValue(undefined) },
        bootstrap,
        normService: {
          listPublicNorms: () => [],
          listManageable: () => [],
        },
        userService: {},
        audit: {},
      }),
    }));

    await waitFor(() => expect(result.current.actions.ready).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("po dočasném selhání načtení umožní inicializaci zopakovat a následně otevřít přihlášení", async () => {
    const bootstrap = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ viewer: null, norms: [], organizations: [] });
    const createServices = () => ({
      backend: "server",
      auth: { ensureDemoCredentials: vi.fn().mockResolvedValue(undefined) },
      bootstrap,
      normService: {
        listPublicNorms: () => [],
        listManageable: () => [],
      },
      userService: {},
      audit: {},
    });
    const { result } = renderHook(() => useAppController({ createServices }));

    await waitFor(() => expect(result.current.initializationFailed).toBe(true));
    expect(result.current.actions.ready).toBe(false);
    expect(result.current.actions.openLogin()).toBe(false);

    act(() => result.current.actions.retryInitialization());

    await waitFor(() => expect(result.current.actions.ready).toBe(true));
    act(() => expect(result.current.actions.openLogin()).toBe(true));
    expect(result.current.authMode).toBe("login");
  });

  it("čeká na výslovné potvrzení a bez něj poškozená data nepřepíše", async () => {
    localStorage.setItem(STORAGE_KEY, "{not-json");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useAppController());

    await waitFor(() => expect(result.current.actions.ready).toBe(true), { timeout: 5_000 });
    expect(result.current.state).toMatchObject({
      recoveryRequired: true,
      recoveryReason: "corrupted-json",
    });

    await act(async () => result.current.actions.resetDemoData());
    expect(localStorage.getItem(STORAGE_KEY)).toBe("{not-json");

    confirm.mockReturnValue(true);
    await act(async () => result.current.actions.resetDemoData());
    await waitFor(() => expect(result.current.state.recoveryRequired).not.toBe(true));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toMatchObject({ schemaVersion: 3 });
    confirm.mockRestore();
  });

  it("zapojí změnu správcovského hesla do profilu a po změně zruší relaci", async () => {
    const { result } = renderHook(() => useAppController());
    await waitFor(() => expect(result.current.actions.ready).toBe(true), { timeout: 5_000 });

    let session;
    await act(async () => {
      session = await result.current.services.auth.loginWithPassword({
        email: "administrator@sokol.demo",
        password: "AdminSokol!2026",
      });
      result.current.actions.authenticated(session);
    });
    await waitFor(() => expect(result.current.currentUser?.role).toBe("admin"));

    await act(async () => {
      await result.current.memberProfile.actions.changePassword({
        currentPassword: "AdminSokol!2026",
        newPassword: "ZmeneneSokol!2028",
      });
    });

    await waitFor(() => expect(result.current.currentUser).toBeNull());
    expect(sessionStorage.getItem("sokol-spolurozhoduje-session-id")).toBeNull();
    await expect(result.current.services.auth.loginWithPassword({
      email: "administrator@sokol.demo",
      password: "AdminSokol!2026",
    })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(result.current.services.auth.loginWithPassword({
      email: "administrator@sokol.demo",
      password: "ZmeneneSokol!2028",
    })).resolves.toMatchObject({ userId: "user-admin-demo" });
  });
});

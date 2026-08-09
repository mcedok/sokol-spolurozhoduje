import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppController } from "../app/hooks/use-app-controller.js";

const STORAGE_KEY = "sokol-spolurozhoduje-pilot-v2";

describe("obnova lokálních demo dat", () => {
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

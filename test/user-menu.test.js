import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { UserMenu } from "../app/components/auth/UserMenu.js";
import { SESSION_STORAGE_KEY, useAppController } from "../app/hooks/use-app-controller.js";

describe("UserMenu", () => {
  it("offers login while signed out", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn();
    render(createElement(UserMenu, {
      currentUser: null,
      onLogin,
      onLogout: vi.fn(),
      onProfile: vi.fn(),
    }));

    await user.click(screen.getByRole("button", { name: "Přihlásit" }));
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("shows the signed-in name and role with profile and logout actions", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    const onProfile = vi.fn();
    render(createElement(UserMenu, {
      currentUser: { firstName: "Petra", lastName: "Sokolová", role: "superadmin" },
      onLogin: vi.fn(),
      onLogout,
      onProfile,
    }));

    expect(screen.getByText("Petra Sokolová").closest(".userIdentity")).toBeInTheDocument();
    expect(screen.getByText("Superadministrátor").closest(".userIdentity")).toBeInTheDocument();
    expect(screen.getByText("PS")).toHaveClass("userAvatar");
    await user.click(screen.getByRole("button", { name: "Profil" }));
    await user.click(screen.getByRole("button", { name: "Odhlásit" }));
    expect(onProfile).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();
  });
});

describe("useAppController", () => {
  it("keeps services and login unavailable when demo credential initialization fails", async () => {
    const initializationError = new Error("seed failed");
    const createServices = vi.fn(() => ({
      repository: { read: vi.fn() },
      auth: { ensureDemoCredentials: vi.fn().mockRejectedValue(initializationError) },
    }));
    const { result } = renderHook(() => useAppController({ createServices }));

    await waitFor(() => expect(result.current.feedback?.kind).toBe("error"));
    expect(result.current.actions.ready).toBe(false);
    expect(result.current.services).toBeNull();

    let opened;
    act(() => {
      opened = result.current.actions.openLogin();
    });
    expect(opened).toBe(false);
    expect(result.current.authMode).toBeNull();
    expect(result.current.feedback.message).toMatch(/zkuste načtení zopakovat/i);
  });

  it("removes an invalid persisted session and initializes exact demo accounts", async () => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, "invalid-session");
    const { result } = renderHook(() => useAppController());

    expect(result.current.services).toBeNull();
    await waitFor(() => expect(result.current.actions.ready).toBe(true), { timeout: 5000 });
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(result.current.currentUser).toBeNull();
    expect(result.current.state.users.map((user) => user.email)).toEqual(
      expect.arrayContaining([
        "superadmin@sokol.demo",
        "administrator@sokol.demo",
        "clen@sokol.demo",
      ]),
    );
  });

  it("stores an authenticated session and refreshes its snapshot after a mutation", async () => {
    const { result } = renderHook(() => useAppController());
    await waitFor(() => expect(result.current.actions.ready).toBe(true), { timeout: 5000 });

    let session;
    await act(async () => {
      session = await result.current.services.auth.loginWithPassword({
        email: "administrator@sokol.demo",
        password: "AdminSokol!2026",
      });
      result.current.actions.authenticated(session);
    });
    await waitFor(() => expect(result.current.currentUser?.email).toBe("administrator@sokol.demo"));
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe(session.id);

    await act(async () => {
      await result.current.actions.mutate(() =>
        result.current.services.repository.update((state) => {
          state.norms[0].title = "Aktualizovaný název";
        }),
      );
    });
    expect(result.current.state.norms[0].title).toBe("Aktualizovaný název");
  });
});

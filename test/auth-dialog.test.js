import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthDialog } from "../app/components/auth/AuthDialog.js";
import { createBrowserRepository } from "../app/data/browser-repository.js";
import { createCryptoAdapter } from "../app/security/crypto-adapter.js";
import { createAuditService } from "../app/services/audit-service.js";
import { createAuthService } from "../app/services/auth-service.js";
import { createFakeClock, createMemoryStorage } from "./fakes.js";
import { USER_STATUS } from "../app/domain/constants.js";

function createHarness() {
  const clock = createFakeClock();
  const repository = createBrowserRepository({ storage: createMemoryStorage() });
  const baseCrypto = createCryptoAdapter(globalThis.crypto);
  const cryptoAdapter = {
    ...baseCrypto,
    randomDigits: () => "123456",
    randomToken: () => `token-${Math.random().toString(36).slice(2)}`,
  };
  const audit = createAuditService(repository, clock.now);
  const authService = createAuthService({ repository, audit, cryptoAdapter, now: clock.now });
  return { authService, repository };
}

describe("AuthDialog", () => {
  let harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("nejprve oddělí přihlášení existujícího uživatele a novou registraci", async () => {
    const user = userEvent.setup();
    render(createElement(AuthDialog, {
      authMode: "login",
      authService: harness.authService,
      onAuthenticated: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(screen.getByRole("button", { name: "Jsem registrovaný uživatel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jsem nový uživatel" })).toBeInTheDocument();
    expect(screen.queryByLabelText("E-mail")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Jsem registrovaný uživatel" }));
    expect(screen.getByLabelText("E-mail")).toHaveFocus();
  });

  it("registers a member through five fields and closes after the correct delivered code", async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    const onClose = vi.fn();
    render(createElement(AuthDialog, {
      authMode: "login",
      authService: harness.authService,
      onAuthenticated,
      onClose,
    }));

    await user.click(screen.getByRole("button", { name: "Jsem nový uživatel" }));
    expect(screen.getByTestId("auth-dialog")).toHaveAttribute("data-auth-step", "register");
    await user.type(screen.getByLabelText("Jméno"), "Jana");
    await user.type(screen.getByLabelText("Příjmení"), "Nováková");
    await user.type(screen.getByLabelText("E-mail"), "nova.clenka@example.cz");
    expect(screen.getByLabelText("E-mail")).toHaveValue("nova.clenka@example.cz");
    await user.type(screen.getByLabelText("Tělocvičná jednota"), "TJ Sokol Brno I");
    await user.type(screen.getByLabelText("Členské číslo"), "CLEN-2026-42");
    await user.click(screen.getByRole("button", { name: "Dokončit registraci" }));

    expect(await screen.findByText(/Ověřovací kód 123456/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Ověřovací kód")).toHaveFocus());
    await user.type(screen.getByLabelText("Ověřovací kód"), "000000");
    await user.click(screen.getByRole("button", { name: "Ověřit kód" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Overovaci kod neni platny");

    await user.clear(screen.getByLabelText("Ověřovací kód"));
    await user.type(screen.getByLabelText("Ověřovací kód"), "123456");
    await user.click(screen.getByRole("button", { name: "Ověřit kód" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends a known member directly to a fresh code step based on service classification", async () => {
    const user = userEvent.setup();
    const registration = await harness.authService.registerMember({
      firstName: "Jan",
      lastName: "Novák",
      email: "znamy.clen@example.cz",
      sokolUnit: "TJ Sokol Praha",
      membershipId: "CLEN-001",
    });
    await harness.authService.verifyMemberCode({
      challengeId: registration.challengeId,
      code: registration.demoCode,
    });
    render(createElement(AuthDialog, {
      authMode: "login",
      authService: harness.authService,
      onAuthenticated: vi.fn(),
      onClose: vi.fn(),
    }));

    await user.click(screen.getByRole("button", { name: "Jsem registrovaný uživatel" }));
    await user.type(screen.getByLabelText("E-mail"), "znamy.clen@example.cz");
    await user.click(screen.getByRole("button", { name: "Pokračovat" }));

    await screen.findByLabelText("Ověřovací kód");
    await waitFor(() => expect(screen.getByLabelText("Ověřovací kód")).toHaveFocus());
    expect(screen.getByTestId("auth-dialog")).toHaveAttribute("data-auth-step", "member-code");
    expect(screen.queryByLabelText("Heslo")).not.toBeInTheDocument();
  });

  it("uses password login for an administrator and completes neutral password recovery through the demo link", async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    const onClose = vi.fn();
    await harness.authService.ensureDemoCredentials();
    render(createElement(AuthDialog, {
      authMode: "login",
      authService: harness.authService,
      onAuthenticated,
      onClose,
    }));

    await user.click(screen.getByRole("button", { name: "Jsem registrovaný uživatel" }));
    await user.type(screen.getByLabelText("E-mail"), "administrator@sokol.demo");
    await user.click(screen.getByRole("button", { name: "Pokračovat" }));

    await screen.findByLabelText("Heslo");
    await waitFor(() => expect(screen.getByLabelText("Heslo")).toHaveFocus());
    expect(screen.queryByLabelText("Ověřovací kód")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zapomenuté heslo" }));
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Poslat odkaz pro obnovu" }));

    expect(await screen.findByText(/Pokud účet existuje, odkaz pro obnovu byl vytvořen/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Otevřít odkaz pro/ }));
    await waitFor(() => expect(screen.getByLabelText("Nové heslo")).toHaveFocus());
    await user.type(screen.getByLabelText("Nové heslo"), "slabe");
    await user.click(screen.getByRole("button", { name: "Nastavit nové heslo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Heslo nesplnuje bezpecnostni pozadavky");

    await user.clear(screen.getByLabelText("Nové heslo"));
    await user.type(screen.getByLabelText("Nové heslo"), "NoveSokol!2027");
    await user.click(screen.getByRole("button", { name: "Nastavit nové heslo" }));
    await screen.findByLabelText("Heslo");
    await waitFor(() => expect(screen.getByLabelText("Heslo")).toHaveFocus());
    await user.type(screen.getByLabelText("Heslo"), "NoveSokol!2027");
    await user.click(screen.getByRole("button", { name: "Přihlásit" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows all exact non-production demo credentials", () => {
    render(createElement(AuthDialog, {
      authMode: "login",
      authService: harness.authService,
      onAuthenticated: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(screen.getByText("Vyzkoušet demoverzi")).toBeInTheDocument();
    expect(screen.getByText(/Pouze neprodukční testovací údaje/)).toBeInTheDocument();
    for (const credential of [
      "superadmin@sokol.demo / SuperSokol!2026",
      "administrator@sokol.demo / AdminSokol!2026",
      "clen@sokol.demo / 260814",
    ]) {
      expect(screen.getByText(credential)).toBeInTheDocument();
    }
    expect(screen.getByText(/data jsou uložena pouze v tomto profilu prohlížeče/i))
      .toBeInTheDocument();
  });

  it("udrží tabulátor uvnitř, zavře se Escape a po odmountování vrátí focus", async () => {
    const user = userEvent.setup();
    const launcher = document.createElement("button");
    launcher.textContent = "Spustit přihlášení";
    document.body.append(launcher);
    launcher.focus();
    const onClose = vi.fn();
    const { unmount } = render(createElement(AuthDialog, {
      authMode: "login",
      authService: harness.authService,
      onAuthenticated: vi.fn(),
      onClose,
    }));

    const dialog = screen.getByRole("dialog", { name: "Přihlášení" });
    const close = within(dialog).getByRole("button", { name: "Zavřít" });
    const last = within(dialog).getByRole("button", { name: "Jsem nový uživatel" });
    last.focus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(launcher).toHaveFocus();
  });

  it("keeps a blocked administrator on the password path and reports a neutral login error", async () => {
    const user = userEvent.setup();
    await harness.authService.ensureDemoCredentials();
    harness.repository.update((state) => {
      state.users.find((candidate) => candidate.id === "user-admin-demo").status =
        USER_STATUS.BLOCKED;
    });
    render(createElement(AuthDialog, {
      authMode: "login",
      authService: harness.authService,
      onAuthenticated: vi.fn(),
      onClose: vi.fn(),
    }));

    await user.click(screen.getByRole("button", { name: "Jsem registrovaný uživatel" }));
    await user.type(screen.getByLabelText("E-mail"), "administrator@sokol.demo");
    await user.click(screen.getByRole("button", { name: "Pokračovat" }));
    expect(await screen.findByLabelText("Heslo")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Heslo"), "AdminSokol!2026");
    await user.click(screen.getByRole("button", { name: "Přihlásit" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "E-mail nebo heslo nejsou platné nebo účet není dostupný.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("zablokovany");
    expect(screen.getByTestId("auth-dialog")).toHaveAttribute("data-auth-step", "password");
  });
});

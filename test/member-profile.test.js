import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { MemberProfile } from "../app/components/member/MemberProfile.js";

const controller = vi.hoisted(() => ({ current: null }));
vi.mock("../app/hooks/use-app-controller.js", () => ({
  useAppController: () => controller.current,
}));

import Home from "../app/page.js";

const user = {
  id: "member-1",
  firstName: "Jana",
  lastName: "Nováková",
  email: "jana@example.cz",
  sokolUnit: "TJ Sokol Brno I",
  membershipId: "MEMBER-1",
  role: "member",
  status: "active",
  emailVerifiedAt: "2026-08-01T10:00:00.000Z",
};

describe("členský profil", () => {
  it("ukáže identitu a pouze příspěvky a hlasy aktuálního uživatele", () => {
    render(createElement(MemberProfile, {
      user,
      contributions: [
        {
          id: "own-contribution",
          authorUserId: user.id,
          title: "Můj návrh",
          normTitle: "Členský řád",
          kind: "Návrh úpravy",
        },
        {
          id: "foreign-contribution",
          authorUserId: "member-2",
          title: "Cizí návrh",
          normTitle: "Členský řád",
          kind: "Komentář",
        },
      ],
      votes: [
        {
          id: "own-vote",
          userId: user.id,
          normTitle: "Členský řád",
          label: "Potřebnost normy: ano",
        },
        {
          id: "foreign-vote",
          userId: "member-2",
          normTitle: "Jiný řád",
          label: "Podpora podnětu: ne",
        },
      ],
    }));

    expect(screen.getByRole("heading", { name: "Jana Nováková" })).toBeInTheDocument();
    const facts = screen.getByRole("region", { name: "Členské údaje" });
    expect(within(facts).getByText("jana@example.cz")).toBeInTheDocument();
    expect(within(facts).getByText("TJ Sokol Brno I")).toBeInTheDocument();
    expect(within(facts).getByText("MEMBER-1")).toBeInTheDocument();
    expect(within(facts).getByText("Ověřený e-mail")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Moje příspěvky" })).toBeInTheDocument();
    expect(screen.getByText("Můj návrh")).toBeInTheDocument();
    expect(screen.queryByText("Cizí návrh")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Moje hlasy" })).toBeInTheDocument();
    expect(screen.getByText("Potřebnost normy: ano")).toBeInTheDocument();
    expect(screen.queryByText("Podpora podnětu: ne")).not.toBeInTheDocument();
  });

  it("nabídne správcům změnu hesla, ale členům ne", async () => {
    const browserUser = userEvent.setup();
    const changePassword = vi.fn().mockResolvedValue({ kind: "password_changed" });
    const { rerender } = render(createElement(MemberProfile, {
      user,
      actions: { changePassword },
    }));
    expect(screen.queryByRole("heading", { name: "Změna hesla" })).not.toBeInTheDocument();

    rerender(createElement(MemberProfile, {
      user: { ...user, role: "admin" },
      actions: { changePassword },
    }));
    await browserUser.type(screen.getByLabelText("Současné heslo"), "AdminSokol!2026");
    await browserUser.type(screen.getByLabelText("Nové heslo"), "NoveAdmin!2028");
    await browserUser.click(screen.getByRole("button", { name: "Změnit heslo" }));

    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: "AdminSokol!2026",
      newPassword: "NoveAdmin!2028",
    });
  });
});

const pageNorm = {
  id: "norm-page",
  number: "SOKOL-2026-201",
  title: "Norma pro stránkový test",
  category: "Směrnice",
  version: "1.0",
  status: "K připomínkování",
  commentsOpen: true,
  publishedAt: "2026-08-01",
  deadline: "2026-08-31",
  submittedBy: "Předsednictvo ČOS",
  responsible: "Odbor organizace ČOS",
  summary: "Shrnutí.",
  reason: "Důvodová zpráva.",
  file: null,
  needVotes: { yes: 0, no: 0 },
  sections: [],
  submissions: [],
  ownerAdminId: "admin-1",
  visibilityMode: "public-detail",
};

function pageController(currentUser, view = "landing") {
  return {
    state: { recoveryRequired: false },
    session: currentUser ? { id: `session-${currentUser.id}`, user: currentUser } : null,
    currentUser,
    view,
    actions: {
      ready: true,
      setView: vi.fn(),
      openLogin: vi.fn(),
      closeLogin: vi.fn(),
      authenticated: vi.fn(),
      logout: vi.fn(),
    },
    feedback: null,
    authMode: null,
    authDelivery: null,
    services: null,
    normCatalog: {
      filter: "Aktivní",
      norms: [pageNorm],
      allNorms: [pageNorm],
      permissions: {
        canParticipate: true,
        canManageNorm: () => false,
      },
      actions: {
        setFilter: vi.fn(),
        requireLogin: vi.fn(),
        showParticipationUnavailable: vi.fn(),
        downloadDocument: vi.fn(),
        addContribution: vi.fn(),
        addReply: vi.fn(),
        voteSubmission: vi.fn(),
        voteNeed: vi.fn(),
        createNorm: vi.fn(),
        deleteNorm: vi.fn(),
        updateNorm: vi.fn(),
        replaceDocument: vi.fn(),
        resolveSubmission: vi.fn(),
      },
    },
    normAdministration: { norms: [] },
    memberProfile: { contributions: [], votes: [] },
    userAdministration: {
      users: [],
      selectedUser: null,
      auditEvents: [],
      summary: {},
      filters: {},
      setupDeliveries: [],
      actions: {},
    },
  };
}

describe("page-level role navigation", () => {
  it("renderuje skutečnou navigaci Uživatelé jen superadministrátorovi", async () => {
    const user = userEvent.setup();
    controller.current = pageController({
      id: "superadmin-1",
      firstName: "Petra",
      lastName: "Sokolová",
      role: "superadmin",
      status: "active",
    });
    const { unmount } = render(createElement(Home));

    await user.click(screen.getByRole("button", { name: "Uživatelé" }));
    expect(controller.current.actions.setView).toHaveBeenCalledWith("users");

    unmount();
    controller.current = pageController({
      id: "admin-1",
      firstName: "Martin",
      lastName: "Kovář",
      role: "admin",
      status: "active",
    });
    render(createElement(Home));
    expect(screen.queryByRole("button", { name: "Uživatelé" })).not.toBeInTheDocument();
  });

  it("běžnému členovi skryje administraci i při přímém view", () => {
    controller.current = pageController(user, "admin");
    render(createElement(Home));

    expect(screen.queryByRole("button", { name: "Administrace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Předložit novou normu" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Administrace je dostupná pouze správcům" }))
      .toBeInTheDocument();
  });

  it("při poškozených datech zobrazí explicitní obnovu namísto přihlašovací smyčky", async () => {
    const browserUser = userEvent.setup();
    const resetDemoData = vi.fn();
    controller.current = {
      ...pageController(null),
      state: { recoveryRequired: true, recoveryReason: "corrupted-json" },
      actions: { ...pageController(null).actions, resetDemoData },
    };
    render(createElement(Home));

    expect(screen.getByRole("heading", { name: "Lokální data nelze bezpečně načíst" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Přihlásit" })).not.toBeInTheDocument();
    await browserUser.click(screen.getByRole("button", { name: "Obnovit ukázková data" }));
    expect(resetDemoData).toHaveBeenCalledOnce();
  });

  it("otevře ověřenému členovi formulář bez editovatelných polí autora a jednoty", async () => {
    const browserUser = userEvent.setup();
    controller.current = pageController(user, "detail");
    render(createElement(Home));

    const trigger = screen.getByRole("button", { name: "Návrh změny" });
    await browserUser.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Nový návrh změny" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("textbox", { name: "Část dokumentu" })).toHaveFocus();
    expect(screen.getByText("Jméno a jednota se bezpečně převezmou z přihlášeného účtu.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Autor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Jednota" })).not.toBeInTheDocument();
    within(dialog).getByRole("button", { name: "Zveřejnit" }).focus();
    await browserUser.tab();
    expect(within(dialog).getByRole("button", { name: "Zavřít" })).toHaveFocus();
    await browserUser.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Nový návrh změny" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("označí dialog nové normy a po zavření vrátí focus na jeho spouštěč", async () => {
    const browserUser = userEvent.setup();
    controller.current = pageController(
      { ...user, id: "admin-1", role: "admin" },
      "admin",
    );
    controller.current.normAdministration.norms = [pageNorm];
    render(createElement(Home));

    const trigger = screen.getByRole("button", { name: "+ Předložit novou normu" });
    await browserUser.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Předložit normu" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("textbox", { name: "Název normy" })).toHaveFocus();
    within(dialog).getByRole("button", { name: "Předložit normu" }).focus();
    await browserUser.tab();
    expect(within(dialog).getByRole("button", { name: "Zavřít" })).toHaveFocus();
    await browserUser.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});

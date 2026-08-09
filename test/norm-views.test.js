import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { NormAdministration } from "../app/components/admin/NormAdministration.js";
import { NormDetail } from "../app/components/public/NormDetail.js";
import { useAppController } from "../app/hooks/use-app-controller.js";

const activeMember = {
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

const administrator = {
  ...activeMember,
  id: "admin-1",
  role: "admin",
};

const superadmin = {
  ...activeMember,
  id: "superadmin-1",
  role: "superadmin",
};

const norm = {
  id: "norm-1",
  number: "SOKOL-2026-101",
  title: "Zkušební řád",
  category: "Vnitřní předpis",
  version: "1.0",
  status: "K připomínkování",
  commentsOpen: true,
  publishedAt: "2026-07-01",
  deadline: "2026-08-31",
  submittedBy: "Předsednictvo ČOS",
  responsible: "Odbor organizace ČOS",
  summary: "Shrnutí zkušebního řádu.",
  reason: "Důvodová zpráva vysvětluje potřebu nové úpravy.",
  file: { id: "file-1", name: "zkusebni-rad.pdf" },
  needVotes: { yes: 12, no: 3 },
  sections: [{
    id: "section-1",
    label: "§ 1",
    title: "Účast členů",
    paragraphs: ["Členové se mohou účastnit rozhodování."],
  }],
  submissions: [{
    id: "submission-1",
    kind: "Návrh úpravy",
    section: "§ 1 odst. 1",
    title: "Doplnit vzdálenou účast",
    text: "Doplnit možnost účasti na dálku.",
    authorUserId: "member-2",
    author: "Petr Nový",
    unit: "TJ Sokol Praha",
    createdAt: "2026-07-12",
    score: 7,
    resolutionStatus: "Zapracováno",
    resolution: "Vzdálená účast byla doplněna.",
    adminComment: "Přijato do verze 1.1.",
    replies: [],
  }],
  ownerAdminId: administrator.id,
  visibilityMode: "public-detail",
};

function detailActions(overrides = {}) {
  return {
    onBack: vi.fn(),
    downloadDocument: vi.fn(),
    manage: vi.fn(),
    requireLogin: vi.fn(),
    showParticipationUnavailable: vi.fn(),
    openContribution: vi.fn(),
    addReply: vi.fn(),
    voteSubmission: vi.fn(),
    voteNeed: vi.fn(),
    ...overrides,
  };
}

describe("veřejný a členský detail normy", () => {
  it("zachová veřejnou důvodovou zprávu, dokument, podněty a vypořádání a účast pošle do přihlášení", async () => {
    const user = userEvent.setup();
    const actions = detailActions();

    render(createElement(NormDetail, {
      norm,
      currentUser: null,
      permissions: { canParticipate: false, canManage: false },
      actions,
    }));

    expect(screen.getByText(norm.reason)).toBeInTheDocument();
    expect(screen.getByText("Členové se mohou účastnit rozhodování.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Doplnit vzdálenou účast" })).toBeInTheDocument();
    expect(screen.getByText("Vzdálená účast byla doplněna.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stáhnout zkusebni-rad.pdf" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Komentář" }));
    await user.click(screen.getByRole("button", { name: "Ano 12" }));

    expect(actions.requireLogin).toHaveBeenNthCalledWith(1, "comment");
    expect(actions.requireLogin).toHaveBeenNthCalledWith(2, "vote-need");
    expect(actions.openContribution).not.toHaveBeenCalled();
    expect(actions.voteNeed).not.toHaveBeenCalled();
  });

  it("aktivnímu ověřenému členovi předá příspěvek a hlas oprávněnými actions", async () => {
    const user = userEvent.setup();
    const actions = detailActions();

    render(createElement(NormDetail, {
      norm,
      currentUser: activeMember,
      permissions: { canParticipate: true, canManage: false },
      actions,
    }));

    await user.click(screen.getByRole("button", { name: "Návrh změny" }));
    await user.click(screen.getByRole("button", { name: "↑" }));

    expect(actions.openContribution).toHaveBeenCalledWith("proposal");
    expect(actions.voteSubmission).toHaveBeenCalledWith(norm.id, "submission-1", 1);
    expect(actions.requireLogin).not.toHaveBeenCalled();
  });

  it("u neaktivní nebo uzavřené normy nenabízí příspěvky ani hlasování", () => {
    render(createElement(NormDetail, {
      norm: { ...norm, status: "Archivováno", commentsOpen: true },
      currentUser: activeMember,
      permissions: { canParticipate: true, canManage: false },
      actions: detailActions(),
    }));

    expect(screen.queryByRole("button", { name: "Návrh změny" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ano 12$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "↑" })).not.toBeInTheDocument();
    expect(screen.getByText(/aktivní připomínkování je uzavřeno/i)).toBeInTheDocument();
  });

  it("zobrazuje odpověď předkladatele jen vlastníkovi normy nebo superadministrátorovi", () => {
    const actions = detailActions();
    const { rerender } = render(createElement(NormDetail, {
      norm,
      currentUser: activeMember,
      permissions: { canParticipate: true, canManage: false },
      actions,
    }));

    expect(screen.queryByRole("textbox", { name: "Odpověď předkladatele" })).not.toBeInTheDocument();

    rerender(createElement(NormDetail, {
      norm,
      currentUser: administrator,
      permissions: { canParticipate: true, canManage: true },
      actions,
    }));
    expect(screen.getByRole("textbox", { name: "Odpověď předkladatele" })).toBeInTheDocument();
  });

  it("zpřístupní aktuální hlas přes aria-pressed", () => {
    render(createElement(NormDetail, {
      norm,
      currentUser: activeMember,
      permissions: {
        canParticipate: true,
        canManage: false,
        needVote: "yes",
        submissionVote: () => 1,
      },
      actions: detailActions(),
    }));

    expect(screen.getByRole("button", { name: "Ano 12" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Ne 3" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "↑" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "↓" })).toHaveAttribute("aria-pressed", "false");
  });

  it("zobrazí Spravovat pouze při oprávnění ke konkrétní normě", () => {
    const { rerender } = render(createElement(NormDetail, {
      norm,
      currentUser: administrator,
      permissions: { canParticipate: true, canManage: false },
      actions: detailActions(),
    }));

    expect(screen.queryByRole("button", { name: "Spravovat" })).not.toBeInTheDocument();

    rerender(createElement(NormDetail, {
      norm,
      currentUser: administrator,
      permissions: { canParticipate: true, canManage: true },
      actions: detailActions(),
    }));
    expect(screen.getByRole("button", { name: "Spravovat" })).toBeInTheDocument();
  });
});

describe("role-aware správa norem", () => {
  it("pojmenuje správcův výpis Moje normy a superadministrátorův Všechny normy", () => {
    const props = {
      norms: [norm],
      selectedNorm: norm,
      actions: {},
    };
    const { rerender } = render(createElement(NormAdministration, {
      ...props,
      currentUser: administrator,
    }));

    expect(screen.getByRole("heading", { name: "Moje normy" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Spravované normy" })).getByText(norm.title)).toBeInTheDocument();

    rerender(createElement(NormAdministration, {
      ...props,
      currentUser: superadmin,
    }));
    expect(screen.getByRole("heading", { name: "Všechny normy" })).toBeInTheDocument();
    expect(screen.getByText(/data zůstávají pouze v tomto profilu prohlížeče/i)).toBeInTheDocument();
  });

  it("ukládá editaci normy jednou až po explicitním potvrzení a vyžádá důvod uzavření", async () => {
    const user = userEvent.setup();
    const updateNorm = vi.fn().mockResolvedValue({ norm: { ...norm } });
    const resolveSubmission = vi.fn();
    render(createElement(NormAdministration, {
      norms: [norm],
      selectedNorm: norm,
      currentUser: administrator,
      actions: { updateNorm, resolveSubmission },
    }));

    const resolutionReason = screen.getByRole("textbox", { name: "Odůvodnění rozhodnutí" });
    expect(resolutionReason).toBeRequired();
    await user.clear(resolutionReason);
    await user.click(screen.getByRole("button", { name: "Uložit vypořádání" }));
    expect(resolveSubmission).not.toHaveBeenCalled();

    await user.clear(screen.getByRole("textbox", { name: "Předkladatel" }));
    await user.type(screen.getByRole("textbox", { name: "Předkladatel" }), "Výbor ČOS");
    expect(updateNorm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Uzavřít připomínky" }));
    expect(screen.getByRole("textbox", { name: "Důvod uzavření připomínek" })).toBeRequired();
    await user.type(
      screen.getByRole("textbox", { name: "Důvod uzavření připomínek" }),
      "Uplynula zveřejněná lhůta.",
    );
    await user.click(screen.getByRole("button", { name: "Uložit změny normy" }));

    expect(updateNorm).toHaveBeenCalledTimes(1);
    expect(updateNorm).toHaveBeenCalledWith(norm.id, expect.objectContaining({
      submittedBy: "Výbor ČOS",
      commentsOpen: false,
      closureReason: "Uplynula zveřejněná lhůta.",
    }));
  });

  it("řadič získá pro administrátora jen vlastní normy a pro superadministrátora všechny přes listManageable", async () => {
    const { result } = renderHook(() => useAppController());
    await waitFor(() => expect(result.current.actions.ready).toBe(true), { timeout: 5000 });
    act(() => {
      result.current.services.repository.update((state) => {
        state.norms.find((candidate) => candidate.id === "norm-003").ownerAdminId = "user-superadmin-demo";
      });
      result.current.actions.refresh();
    });

    await act(async () => {
      const session = await result.current.services.auth.loginWithPassword({
        email: "administrator@sokol.demo",
        password: "AdminSokol!2026",
      });
      result.current.actions.authenticated(session);
    });
    await waitFor(() => expect(result.current.normAdministration.norms.map((item) => item.id)).toEqual([
      "norm-001",
      "norm-002",
    ]));

    act(() => result.current.actions.logout());
    await act(async () => {
      const session = await result.current.services.auth.loginWithPassword({
        email: "superadmin@sokol.demo",
        password: "SuperSokol!2026",
      });
      result.current.actions.authenticated(session);
    });
    await waitFor(() => expect(result.current.normAdministration.norms.map((item) => item.id)).toEqual([
      "norm-001",
      "norm-002",
      "norm-003",
    ]));
  });
});

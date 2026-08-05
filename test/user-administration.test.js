import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  canAccessUserAdministration,
  UserAdministration,
} from "../app/components/admin/UserAdministration.js";
import { AuthDialog } from "../app/components/auth/AuthDialog.js";
import { DemoInbox } from "../app/components/auth/DemoInbox.js";
import { useAppController } from "../app/hooks/use-app-controller.js";

const superadmin = {
  id: "user-superadmin",
  firstName: "Petra",
  lastName: "Sokolová",
  role: "superadmin",
  status: "active",
};

const administrator = {
  id: "user-admin",
  firstName: "Martin",
  lastName: "Kovář",
  role: "admin",
  status: "active",
};

const managedUsers = [
  {
    id: "member-brno",
    firstName: "Jana",
    lastName: "Nováková",
    email: "jana@example.cz",
    sokolUnit: "TJ Sokol Brno I",
    membershipId: "MEMBER-BRNO-42",
    role: "member",
    status: "active",
  },
  {
    id: "admin-invited",
    firstName: "Alena",
    lastName: "Správcová",
    email: "alena@example.cz",
    sokolUnit: "Česká obec sokolská",
    membershipId: "ADMIN-17",
    role: "admin",
    status: "invited",
  },
  {
    id: "superadmin-blocked",
    firstName: "Tomáš",
    lastName: "Zablokovaný",
    email: "tomas@example.cz",
    sokolUnit: "TJ Sokol Plzeň",
    membershipId: "SUPER-9",
    role: "superadmin",
    status: "blocked",
  },
];

function InteractiveAdministration() {
  const [filters, setFilters] = useState({ query: "", role: "", status: "" });
  const [selectedUserId, selectUser] = useState(null);
  const users = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return managedUsers.filter((candidate) => {
      if (filters.role && candidate.role !== filters.role) return false;
      if (filters.status && candidate.status !== filters.status) return false;
      if (!query) return true;
      return [candidate.firstName, candidate.lastName, candidate.email, candidate.sokolUnit, candidate.membershipId]
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [filters]);
  const selectedUser = managedUsers.find((candidate) => candidate.id === selectedUserId) || null;

  return createElement(UserAdministration, {
    currentUser: superadmin,
    users,
    selectedUser,
    auditEvents: selectedUser ? [{
      action: "user.status_changed",
      actorUserId: superadmin.id,
      createdAt: "2026-08-03T12:00:00.000Z",
      metadata: { oldStatus: "invited", newStatus: "active" },
    }] : [],
    summary: { active: 1, invited: 1, blocked: 1 },
    filters,
    setupDeliveries: [],
    actions: {
      setFilters: (patch) => setFilters((current) => ({ ...current, ...patch })),
      selectUser,
      createUser: vi.fn(),
      setUserStatus: vi.fn(),
      changeUserRole: vi.fn(),
      openSetupDelivery: vi.fn(),
      transferCandidates: [superadmin],
    },
  });
}

function ActionAdministration({ calls }) {
  const [selectedUserId, selectUser] = useState("member-brno");
  const [setupDeliveries, setSetupDeliveries] = useState([]);
  const users = managedUsers.map((candidate) =>
    candidate.id === "admin-invited" ? { ...candidate, ownedNormCount: 1 } : candidate,
  );
  const selectedUser = users.find((candidate) => candidate.id === selectedUserId) || null;
  const delivery = {
    kind: "set_password",
    challengeId: "challenge-admin-1",
    userId: "admin-new",
    demoToken: "one-time-secret",
  };

  return createElement(UserAdministration, {
    currentUser: superadmin,
    users,
    selectedUser,
    auditEvents: [],
    summary: { active: 1, invited: 1, blocked: 1 },
    filters: { query: "", role: "", status: "" },
    setupDeliveries,
    actions: {
      setFilters: vi.fn(),
      selectUser,
      async createUser(input) {
        calls.createUser(input);
        setSetupDeliveries([delivery]);
        return delivery;
      },
      async setUserStatus(userId, status) {
        calls.setUserStatus(userId, status);
      },
      async changeUserRole(userId, role, transferUserId) {
        calls.changeUserRole(userId, role, transferUserId);
        if (role === "admin") setSetupDeliveries([delivery]);
        return role === "admin" ? delivery : selectedUser;
      },
      openSetupDelivery: calls.openSetupDelivery,
      transferCandidates: [superadmin],
    },
  });
}

function renderAdministration(overrides = {}) {
  return render(createElement(UserAdministration, {
    currentUser: superadmin,
    users: [],
    selectedUser: null,
    auditEvents: [],
    summary: { active: 0, invited: 0, blocked: 0 },
    setupDeliveries: [],
    actions: {
      setFilters: vi.fn(),
      selectUser: vi.fn(),
      createUser: vi.fn(),
      setUserStatus: vi.fn(),
      changeUserRole: vi.fn(),
      openSetupDelivery: vi.fn(),
      transferCandidates: [],
    },
    ...overrides,
  }));
}

describe("administrace uživatelů", () => {
  it("zpřístupní navigaci pouze aktivnímu superadministrátorovi a přímý přístup správce odmítne", () => {
    expect(canAccessUserAdministration(superadmin)).toBe(true);
    expect(canAccessUserAdministration(administrator)).toBe(false);

    renderAdministration({ currentUser: administrator });

    expect(screen.getByRole("heading", { name: "Nemáte oprávnění spravovat uživatele" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Uživatelé" })).not.toBeInTheDocument();
  });

  it("zobrazuje souhrny, filtruje tabulku a otevírá pravý detail s auditem", async () => {
    const user = userEvent.setup();
    render(createElement(InteractiveAdministration));

    const summary = within(screen.getByRole("region", { name: "Souhrn stavů" }));
    expect(summary.getByText("Aktivní").closest(".userSummaryCard")).toHaveTextContent("1");
    expect(summary.getByText("Pozvaní").closest(".userSummaryCard")).toHaveTextContent("1");
    expect(summary.getByText("Blokovaní").closest(".userSummaryCard")).toHaveTextContent("1");
    expect(screen.getByRole("table", { name: "Uživatelé" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Uživatel",
      "Jednota / členské ID",
      "Role",
      "Stav",
    ]);

    const search = screen.getByRole("searchbox", { name: "Hledat uživatele" });
    await user.type(search, "Brno I");
    expect(screen.getByText("Jana Nováková")).toBeInTheDocument();
    expect(screen.queryByText("Alena Správcová")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "MEMBER-BRNO-42");
    expect(screen.getByText("Jana Nováková")).toBeInTheDocument();

    await user.clear(search);
    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "admin");
    expect(screen.getByText("Alena Správcová")).toBeInTheDocument();
    expect(screen.queryByText("Jana Nováková")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Stav" }), "invited");
    expect(screen.getByText("Alena Správcová")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "");
    await user.selectOptions(screen.getByRole("combobox", { name: "Stav" }), "");
    const janaRow = screen.getByRole("button", {
      name: /Otevřít detail Jana Nováková.*jana@example\.cz.*TJ Sokol Brno I.*MEMBER-BRNO-42.*Člen.*Aktivní/i,
    });
    janaRow.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("heading", { name: "Jana Nováková" })).toBeInTheDocument();
    expect(screen.getByText("MEMBER-BRNO-42", { selector: ".userDetailPanel *" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Auditní historie" })).toBeInTheDocument();
    expect(screen.getByText(/stav účtu změněn/i)).toBeInTheDocument();
  });

  it("vytváří správce, potvrzuje rušení relací a vyžádá převod vlastnictví", async () => {
    const user = userEvent.setup();
    const calls = {
      createUser: vi.fn(),
      setUserStatus: vi.fn(),
      changeUserRole: vi.fn(),
      openSetupDelivery: vi.fn(),
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(createElement(ActionAdministration, { calls }));

    await user.click(screen.getByRole("button", { name: "Nový administrátor" }));
    await user.type(screen.getByRole("textbox", { name: "Jméno" }), "Eva");
    await user.type(screen.getByRole("textbox", { name: "Příjmení" }), "Nová");
    await user.type(screen.getByRole("textbox", { name: "E-mail" }), "eva@example.cz");
    await user.type(screen.getByRole("textbox", { name: "Tělocvičná jednota" }), "TJ Sokol Olomouc");
    await user.type(screen.getByRole("textbox", { name: "Členské ID" }), "ADMIN-88");
    await user.click(screen.getByRole("button", { name: "Vytvořit administrátora" }));

    expect(calls.createUser).toHaveBeenCalledWith({
      firstName: "Eva",
      lastName: "Nová",
      email: "eva@example.cz",
      sokolUnit: "TJ Sokol Olomouc",
      membershipId: "ADMIN-88",
      role: "admin",
    });
    expect(screen.getByText("Odkaz pro první heslo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Otevřít odkaz" }));
    expect(calls.openSetupDelivery).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "challenge-admin-1",
    }));

    await user.click(screen.getByRole("button", { name: "Blokovat účet" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/zruší všechny aktivní relace/i));
    expect(calls.setUserStatus).toHaveBeenCalledWith("member-brno", "blocked");

    await user.selectOptions(screen.getByRole("combobox", { name: "Role účtu" }), "admin");
    await user.click(screen.getByRole("button", { name: "Uložit roli" }));
    expect(calls.changeUserRole).toHaveBeenCalledWith("member-brno", "admin", undefined);

    await user.click(screen.getByRole("button", { name: /^Otevřít detail Alena Správcová/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Role účtu" }), "member");
    await user.click(screen.getByRole("button", { name: "Uložit roli" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Vyberte nového vlastníka norem");
    expect(calls.changeUserRole).not.toHaveBeenCalledWith("admin-invited", "member", undefined);

    await user.selectOptions(screen.getByRole("combobox", { name: "Nový vlastník norem" }), superadmin.id);
    await user.click(screen.getByRole("button", { name: "Uložit roli" }));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/převede vlastnictví norem/i));
    expect(calls.changeUserRole).toHaveBeenCalledWith("admin-invited", "member", superadmin.id);
    confirm.mockRestore();
  });

  it("řadič načítá filtrovaná data přes služby a drží setup delivery pouze dočasně", async () => {
    const { result } = renderHook(() => useAppController());
    await waitFor(() => expect(result.current.actions.ready).toBe(true), { timeout: 5000 });

    await act(async () => {
      const session = await result.current.services.auth.loginWithPassword({
        email: "superadmin@sokol.demo",
        password: "SuperSokol!2026",
      });
      result.current.actions.authenticated(session);
    });
    await waitFor(() => expect(result.current.userAdministration.users).toHaveLength(3));

    await act(async () => {
      await result.current.userAdministration.actions.createUser({
        firstName: "Eva",
        lastName: "Nová",
        email: "eva.controller@example.cz",
        sokolUnit: "TJ Sokol Olomouc",
        membershipId: "ADMIN-CONTROLLER-88",
        role: "admin",
      });
    });

    const delivery = result.current.userAdministration.setupDeliveries.at(-1);
    expect(delivery).toMatchObject({ kind: "set_password", demoToken: expect.any(String) });
    const persisted = JSON.stringify(result.current.services.repository.read());
    expect(persisted).not.toContain(delivery.demoToken);
    expect(JSON.stringify(result.current.services.audit.listForTarget("user", delivery.userId))).not.toContain(
      delivery.demoToken,
    );

    act(() => {
      result.current.userAdministration.actions.setFilters({ query: "ADMIN-CONTROLLER-88" });
    });
    await waitFor(() => expect(result.current.userAdministration.users.map((user) => user.id)).toEqual([
      delivery.userId,
    ]));

    act(() => {
      result.current.userAdministration.actions.selectUser(delivery.userId);
    });
    await waitFor(() => expect(result.current.userAdministration.selectedUser?.id).toBe(delivery.userId));
    expect(result.current.userAdministration.auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "user.created", targetId: delivery.userId }),
      expect.objectContaining({ action: "auth.password_setup_requested", targetId: delivery.userId }),
    ]));

    act(() => {
      result.current.userAdministration.actions.openSetupDelivery(delivery);
    });
    expect(result.current.authMode).toBe("set-password");
    expect(result.current.authDelivery).toEqual(delivery);
  });

  it("řadič nahrazuje rotovaný setup stejného uživatele a zachová různé příjemce", async () => {
    const { result } = renderHook(() => useAppController());
    await waitFor(() => expect(result.current.actions.ready).toBe(true), { timeout: 5000 });
    await act(async () => {
      const session = await result.current.services.auth.loginWithPassword({
        email: "superadmin@sokol.demo",
        password: "SuperSokol!2026",
      });
      result.current.actions.authenticated(session);
    });

    await act(async () => {
      await result.current.userAdministration.actions.createUser({
        firstName: "Eva",
        lastName: "Nová",
        email: "eva.rotation@example.cz",
        sokolUnit: "TJ Sokol Olomouc",
        membershipId: "ROTATION-1",
        role: "admin",
      });
      await result.current.userAdministration.actions.createUser({
        firstName: "Anna",
        lastName: "Druhá",
        email: "anna.rotation@example.cz",
        sokolUnit: "TJ Sokol Brno",
        membershipId: "ROTATION-2",
        role: "admin",
      });
    });
    const [evaOriginal, annaDelivery] = result.current.userAdministration.setupDeliveries;

    await act(async () => {
      await result.current.userAdministration.actions.changeUserRole(
        evaOriginal.userId,
        "superadmin",
      );
    });

    const deliveries = result.current.userAdministration.setupDeliveries;
    expect(deliveries).toHaveLength(2);
    expect(deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: annaDelivery.userId,
        challengeId: annaDelivery.challengeId,
        recipientEmail: "anna.rotation@example.cz",
      }),
      expect.objectContaining({
        userId: evaOriginal.userId,
        recipientEmail: "eva.rotation@example.cz",
      }),
    ]));
    expect(deliveries.find((delivery) => delivery.userId === evaOriginal.userId).challengeId).not.toBe(
      evaOriginal.challengeId,
    );

    const rotatedEva = deliveries.find((delivery) => delivery.userId === evaOriginal.userId);
    await act(async () => {
      await result.current.userAdministration.actions.setUserStatus(evaOriginal.userId, "blocked");
      await result.current.userAdministration.actions.setUserStatus(evaOriginal.userId, "active");
    });

    const reactivated = result.current.userAdministration.setupDeliveries;
    expect(reactivated).toHaveLength(2);
    expect(reactivated.find((delivery) => delivery.userId === evaOriginal.userId)).toMatchObject({
      recipientLabel: "Eva Nová",
      recipientEmail: "eva.rotation@example.cz",
    });
    expect(reactivated.find((delivery) => delivery.userId === evaOriginal.userId).challengeId).not.toBe(
      rotatedEva.challengeId,
    );

    const administration = result.current.userAdministration;
    render(createElement(UserAdministration, {
      currentUser: result.current.currentUser,
      users: administration.users,
      selectedUser: administration.selectedUser,
      auditEvents: administration.auditEvents,
      summary: administration.summary,
      filters: administration.filters,
      setupDeliveries: administration.setupDeliveries,
      actions: administration.actions,
    }));
    expect(screen.getByText("Eva Nová · eva.rotation@example.cz")).toBeInTheDocument();
  });

  it("simulovaná schránka pojmenuje každé doručení příjemcem", () => {
    const deliveries = [
      {
        kind: "set_password",
        challengeId: "challenge-eva",
        userId: "user-eva",
        recipientLabel: "Eva Nová",
        recipientEmail: "eva@example.cz",
        demoToken: "eva-secret",
      },
      {
        kind: "set_password",
        challengeId: "challenge-anna",
        userId: "user-anna",
        recipientLabel: "Anna Druhá",
        recipientEmail: "anna@example.cz",
        demoToken: "anna-secret",
      },
    ];
    render(createElement(DemoInbox, { deliveries, onOpenLink: vi.fn() }));

    expect(screen.getByText("Eva Nová · eva@example.cz")).toBeInTheDocument();
    expect(screen.getByText("Anna Druhá · anna@example.cz")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Otevřít odkaz pro Eva Nová" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Otevřít odkaz pro Anna Druhá" })).toBeInTheDocument();
  });

  it("předá odkaz pro první heslo do existujícího autentizačního dialogu", async () => {
    const user = userEvent.setup();
    const completePasswordSetup = vi.fn().mockResolvedValue({ userId: "admin-new" });
    const delivery = {
      kind: "set_password",
      challengeId: "challenge-admin-1",
      userId: "admin-new",
      demoToken: "one-time-secret",
    };
    render(createElement(AuthDialog, {
      authMode: "set-password",
      initialDelivery: delivery,
      authService: { completePasswordSetup, completePasswordReset: vi.fn() },
      onAuthenticated: vi.fn(),
      onClose: vi.fn(),
    }));

    await user.type(screen.getByLabelText("Nové heslo"), "PrvniHeslo!2026");
    await user.click(screen.getByRole("button", { name: "Nastavit nové heslo" }));

    expect(completePasswordSetup).toHaveBeenCalledWith({
      token: "one-time-secret",
      password: "PrvniHeslo!2026",
    });
    expect(screen.getByTestId("auth-dialog")).toHaveAttribute("data-auth-step", "identify");
    expect(screen.getByRole("status")).toHaveTextContent("Nové heslo je nastavené");
    expect(screen.getByRole("textbox", { name: "E-mail" })).toBeInTheDocument();
  });
});

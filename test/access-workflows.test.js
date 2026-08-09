import { createElement as h, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UserAdministration } from "../app/components/admin/UserAdministration.js";
import { AuthDialog } from "../app/components/auth/AuthDialog.js";
import { createBrowserRepository } from "../app/data/browser-repository.js";
import { LIMITS, ROLE, USER_STATUS } from "../app/domain/constants.js";
import { AuthorizationError } from "../app/security/access-control.js";
import { createAuditService } from "../app/services/audit-service.js";
import { createAuthService } from "../app/services/auth-service.js";
import { createNormService } from "../app/services/norm-service.js";
import { createUserService } from "../app/services/user-service.js";
import { createFakeClock, createMemoryStorage } from "./fakes.js";

const MODEL_CREDENTIALS = {
  superadmin: { email: "superadmin@sokol.demo", password: "SuperSokol!2026" },
  admin: { email: "administrator@sokol.demo", password: "AdminSokol!2026" },
  member: { email: "clen@sokol.demo", code: "260814" },
};

function digest(secret, salt) {
  let value = 2166136261;
  for (const byte of new TextEncoder().encode(`${salt}:${secret}`)) {
    value ^= byte;
    value = Math.imul(value, 16777619);
  }
  return `digest-${value >>> 0}`;
}

function createDeterministicCryptoAdapter() {
  let tokenSequence = 0;
  let saltSequence = 0;

  return {
    randomDigits: () => "123456",
    randomToken: () => `token-${String(++tokenSequence).padStart(4, "0")}`,
    async hashSecret(secret, salt) {
      const resolvedSalt = salt || `salt-${String(++saltSequence).padStart(4, "0")}`;
      return { salt: resolvedSalt, hash: digest(secret, resolvedSalt) };
    },
    async verifySecret(secret, salt, expectedHash) {
      return digest(secret, salt) === expectedHash;
    },
  };
}

async function createHarness({ storage = createMemoryStorage(), clock = createFakeClock() } = {}) {
  const repository = createBrowserRepository({ storage });
  const cryptoAdapter = createDeterministicCryptoAdapter();
  const audit = createAuditService(repository, clock.now);
  const auth = createAuthService({ repository, audit, cryptoAdapter, now: clock.now });
  const files = new Map();
  const fileRepository = {
    async storeFile(id, file) {
      files.set(id, file);
    },
    async readFile(id) {
      return files.get(id);
    },
    async removeFile(id) {
      if (id) files.delete(id);
    },
  };
  const norms = createNormService({ repository, auth, audit, fileRepository, now: clock.now });
  const users = createUserService({ repository, auth, audit, now: clock.now });
  await auth.ensureDemoCredentials();
  return { audit, auth, clock, files, norms, repository, storage, users };
}

function memberProfile(sequence) {
  return {
    firstName: "Jana",
    lastName: `Členka ${sequence}`,
    email: `jana.${sequence}@example.cz`,
    sokolUnit: "TJ Sokol Brno I",
    membershipId: `BRNO-${sequence}`,
  };
}

function privilegedProfile(email, role = ROLE.ADMIN) {
  return {
    firstName: "Alena",
    lastName: "Správcová",
    email,
    sokolUnit: "Česká obec sokolská",
    membershipId: `ADMIN-${email}`,
    role,
  };
}

function AuthDialogLauncher({ authService }) {
  const [open, setOpen] = useState(false);
  return h(
    "div",
    null,
    h("button", { type: "button", onClick: () => setOpen(true) }, "Otevřít přihlášení"),
    open &&
      h(AuthDialog, {
        authMode: "login",
        authService,
        onAuthenticated: () => undefined,
        onClose: () => setOpen(false),
      }),
  );
}

describe("access administration acceptance workflows", () => {
  it("1. keeps published norm lists and details public while write actions require login", async () => {
    const { norms, repository } = await createHarness();
    const before = repository.read();

    expect(norms.listPublicNorms("Všechny")).toHaveLength(3);
    expect(norms.getPublicNorm("norm-001")).toMatchObject({
      id: "norm-001",
      title: "Členský a organizační řád",
      sections: expect.any(Array),
    });
    await expect(
      norms.addContribution(undefined, "norm-001", { title: "Veřejný komentář", text: "Text" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(norms.voteNeed(undefined, "norm-001", "yes")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    const after = repository.read();
    expect(after.norms).toEqual(before.norms);
    expect(after.votes).toEqual(before.votes);
  });

  it("2. registers a member with a valid code and rejects invalid, used and expired codes", async () => {
    const { auth, clock } = await createHarness();
    const delivery = await auth.registerMember(memberProfile("registration"));

    await expect(
      auth.verifyMemberCode({ challengeId: delivery.challengeId, code: "000000" }),
    ).rejects.toMatchObject({ code: "INVALID_CODE" });
    await expect(
      auth.verifyMemberCode({ challengeId: delivery.challengeId, code: delivery.demoCode }),
    ).resolves.toMatchObject({ userId: delivery.userId });
    await expect(
      auth.verifyMemberCode({ challengeId: delivery.challengeId, code: delivery.demoCode }),
    ).rejects.toMatchObject({ code: "CODE_USED" });

    const expiring = await auth.registerMember(memberProfile("expiry"));
    clock.advance(LIMITS.memberCodeMs + 1);
    await expect(
      auth.verifyMemberCode({ challengeId: expiring.challengeId, code: expiring.demoCode }),
    ).rejects.toMatchObject({ code: "CODE_EXPIRED" });
  });

  it("3. signs in the model member with code 260814 and permits open participation", async () => {
    const { auth, norms } = await createHarness();
    const delivery = await auth.requestMemberCode(MODEL_CREDENTIALS.member.email);

    expect(delivery.demoCode).toBe(MODEL_CREDENTIALS.member.code);
    const session = await auth.verifyMemberCode({
      challengeId: delivery.challengeId,
      code: MODEL_CREDENTIALS.member.code,
    });
    await expect(
      norms.addContribution(session.id, "norm-001", {
        kind: "Komentář",
        title: "Přijímací komentář",
        text: "Přijímací scénář členské účasti.",
      }),
    ).resolves.toMatchObject({ contribution: { authorUserId: session.userId } });
    await expect(norms.voteNeed(session.id, "norm-001", "yes")).resolves.toMatchObject({
      vote: "yes",
    });
  });

  it("4. lets the model administrator manage owned norms but denies direct changes to foreign norms", async () => {
    const { auth, norms, repository } = await createHarness();
    const adminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);
    const superadminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);
    const foreign = await norms.create(superadminSession.id, { title: "Cizí norma" });

    await expect(
      norms.update(adminSession.id, "norm-001", { title: "Vlastníkova aktualizace" }),
    ).resolves.toMatchObject({ norm: { title: "Vlastníkova aktualizace" } });
    await expect(
      norms.update(adminSession.id, foreign.norm.id, { title: "Nepovolená aktualizace" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(repository.read().norms.find((norm) => norm.id === foreign.norm.id).title).toBe(
      "Cizí norma",
    );
  });

  it("5. lets the superadministrator manage every norm and provision an administrator first password", async () => {
    const { auth, norms, users } = await createHarness();
    const superadminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);

    await expect(
      norms.update(superadminSession.id, "norm-001", { title: "Změna superadministrátora" }),
    ).resolves.toMatchObject({ norm: { title: "Změna superadministrátora" } });
    const setup = await users.createPrivilegedUser(
      superadminSession.id,
      privilegedProfile("new-admin@example.cz"),
    );
    await auth.completePasswordSetup({ token: setup.demoToken, password: "FirstAdmin!2026" });
    await expect(
      auth.loginWithPassword({ email: "new-admin@example.cz", password: "FirstAdmin!2026" }),
    ).resolves.toMatchObject({ userId: setup.userId });
  });

  it("6. changes an administrator password and rejects the former password", async () => {
    const { auth } = await createHarness();
    const session = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);

    await auth.changePassword({
      sessionId: session.id,
      currentPassword: MODEL_CREDENTIALS.admin.password,
      newPassword: "ChangedAdmin!2027",
    });
    await expect(auth.loginWithPassword(MODEL_CREDENTIALS.admin)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    await expect(
      auth.loginWithPassword({
        email: MODEL_CREDENTIALS.admin.email,
        password: "ChangedAdmin!2027",
      }),
    ).resolves.toMatchObject({ userId: "user-admin-demo" });
  });

  it("7. resets a forgotten administrator password once and rejects token reuse", async () => {
    const { auth } = await createHarness();
    const reset = await auth.requestPasswordReset(MODEL_CREDENTIALS.admin.email);

    await auth.completePasswordReset({ token: reset.demoToken, password: "ResetAdmin!2027" });
    await expect(
      auth.completePasswordReset({ token: reset.demoToken, password: "SecondReset!2027" }),
    ).rejects.toMatchObject({ code: "TOKEN_USED" });
    await expect(
      auth.loginWithPassword({ email: MODEL_CREDENTIALS.admin.email, password: "ResetAdmin!2027" }),
    ).resolves.toMatchObject({ userId: "user-admin-demo" });
  });

  it("8. blocks an account, revokes its session and prevents further active management", async () => {
    const { auth, norms, users } = await createHarness();
    const superadminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);
    const adminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);

    await users.setUserStatus(superadminSession.id, adminSession.userId, USER_STATUS.BLOCKED);
    expect(() => auth.getSession(adminSession.id)).toThrow(
      expect.objectContaining({ code: "SESSION_REVOKED" }),
    );
    await expect(
      norms.update(adminSession.id, "norm-001", { title: "Změna z blokovaného účtu" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(auth.loginWithPassword(MODEL_CREDENTIALS.admin)).rejects.toMatchObject({
      code: "ACCOUNT_BLOCKED",
    });
  });

  it("9. refuses to block or demote the last active superadministrator", async () => {
    const { auth, repository, users } = await createHarness();
    const superadminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);

    await expect(
      users.setUserStatus(superadminSession.id, superadminSession.userId, USER_STATUS.BLOCKED),
    ).rejects.toMatchObject({ code: "LAST_ACTIVE_SUPERADMIN" });
    await expect(
      users.changeUserRole(superadminSession.id, superadminSession.userId, ROLE.ADMIN),
    ).rejects.toMatchObject({ code: "LAST_ACTIVE_SUPERADMIN" });
    expect(repository.read().users.find((user) => user.id === superadminSession.userId)).toMatchObject(
      { role: ROLE.SUPERADMIN, status: USER_STATUS.ACTIVE },
    );
  });

  it("10. keeps mobile authentication and user administration operable with accessible dialogs", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    const user = userEvent.setup();
    const { auth, repository } = await createHarness();
    render(h(AuthDialogLauncher, { authService: auth }));

    const loginTrigger = screen.getByRole("button", { name: "Otevřít přihlášení" });
    await user.click(loginTrigger);
    const authDialog = screen.getByRole("dialog", { name: "Přihlášení" });
    expect(authDialog).toHaveAttribute("aria-modal", "true");
    expect(within(authDialog).getByLabelText("E-mail")).toHaveFocus();
    await user.click(within(authDialog).getByRole("button", { name: "Zavřít" }));
    expect(loginTrigger).toHaveFocus();

    const currentUser = repository.read().users.find((candidate) => candidate.role === ROLE.SUPERADMIN);
    render(
      h(UserAdministration, {
        currentUser,
        users: repository.read().users,
        summary: { active: 3, invited: 0, blocked: 0 },
        actions: {},
      }),
    );
    const createTrigger = screen.getByRole("button", { name: "Nový administrátor" });
    await user.click(createTrigger);
    const createDialog = screen.getByRole("dialog", { name: "Vytvořit administrátora" });
    expect(createDialog).toHaveAttribute("aria-modal", "true");
    expect(within(createDialog).getByLabelText("Jméno")).toHaveFocus();
    expect(within(createDialog).getByLabelText("Členské ID")).toBeRequired();
    await user.click(within(createDialog).getByRole("button", { name: "Zavřít" }));
    expect(createTrigger).toHaveFocus();
  });

  it("11. restores a persisted valid session but rejects expiry after eight hours and logout", async () => {
    const storage = createMemoryStorage();
    const clock = createFakeClock();
    const firstPage = await createHarness({ storage, clock });
    const persistedSession = await firstPage.auth.loginWithPassword(MODEL_CREDENTIALS.admin);

    const refreshedPage = await createHarness({ storage, clock });
    expect(refreshedPage.auth.getSession(persistedSession.id).user.id).toBe("user-admin-demo");
    clock.advance(LIMITS.sessionMs);
    expect(() => refreshedPage.auth.getSession(persistedSession.id)).toThrow(
      expect.objectContaining({ code: "SESSION_EXPIRED" }),
    );

    const loggedOutSession = await refreshedPage.auth.loginWithPassword(MODEL_CREDENTIALS.admin);
    refreshedPage.auth.logout(loggedOutSession.id);
    expect(() => refreshedPage.auth.getSession(loggedOutSession.id)).toThrow(
      expect.objectContaining({ code: "SESSION_REVOKED" }),
    );
  });

  it("12. audits role, block, denied norm access and password lifecycle without recording secrets", async () => {
    const { auth, norms, repository, users } = await createHarness();
    const superadminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);
    const setup = await users.createPrivilegedUser(
      superadminSession.id,
      privilegedProfile("audit-admin@example.cz"),
    );
    await auth.completePasswordSetup({ token: setup.demoToken, password: "AuditAdmin!2026" });
    const reset = await auth.requestPasswordReset("audit-admin@example.cz");
    await auth.completePasswordReset({ token: reset.demoToken, password: "AuditReset!2027" });
    await users.changeUserRole(superadminSession.id, setup.userId, ROLE.MEMBER);
    await users.setUserStatus(superadminSession.id, "user-admin-demo", USER_STATUS.BLOCKED);
    await expect(
      norms.update("invalid-session", "missing-norm", { title: "Neprozrazená norma" }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const events = repository.read().auditEvents;
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "user.role_changed",
        "user.status_changed",
        "authorization.denied",
        "auth.password_set",
        "auth.password_reset",
      ]),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "authorization.denied",
        targetId: "missing-norm",
        metadata: { requestedAction: "norm.update", permission: "manage_norm" },
      }),
    );
    expect(JSON.stringify(events)).not.toContain(setup.demoToken);
    expect(JSON.stringify(events)).not.toContain(reset.demoToken);
    expect(JSON.stringify(events)).not.toMatch(/AuditAdmin!2026|AuditReset!2027/);
  });
});

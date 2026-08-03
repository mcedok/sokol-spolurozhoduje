import { beforeEach, describe, expect, it } from "vitest";
import { createBrowserRepository } from "../app/data/browser-repository.js";
import { ROLE, USER_STATUS } from "../app/domain/constants.js";
import { AuthorizationError } from "../app/security/access-control.js";
import { createCryptoAdapter } from "../app/security/crypto-adapter.js";
import { createAuditService } from "../app/services/audit-service.js";
import { createAuthService } from "../app/services/auth-service.js";
import { createNormService, NormServiceError } from "../app/services/norm-service.js";
import { createFakeClock, createMemoryStorage } from "./fakes.js";

const MODEL_CREDENTIALS = {
  superadmin: { email: "superadmin@sokol.demo", password: "SuperSokol!2026" },
  admin: { email: "administrator@sokol.demo", password: "AdminSokol!2026" },
};

function session(id, userId, now) {
  return {
    id,
    userId,
    createdAt: now,
    expiresAt: now + 60 * 60 * 1000,
    revokedAt: null,
  };
}

function user(overrides = {}) {
  return {
    id: "member-verified",
    firstName: "Jana",
    lastName: "Nováková",
    email: "jana.novakova@example.cz",
    sokolUnit: "TJ Sokol Brno I",
    membershipId: "BRNO-42",
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
    emailVerifiedAt: "2026-08-03T10:00:00.000Z",
    ...overrides,
  };
}

function normInput(overrides = {}) {
  return {
    title: "Nová směrnice",
    category: "Směrnice",
    version: "1.0",
    status: "Koncept",
    deadline: "2026-09-30",
    submittedBy: "Výbor ČOS",
    responsible: "Kancelář ČOS",
    summary: "Stručné shrnutí.",
    reason: "Důvodová zpráva.",
    ...overrides,
  };
}

function contributionInput(overrides = {}) {
  return {
    kind: "Komentář",
    section: "§ 4",
    title: "Doplnit vysvětlení",
    text: "Prosím o přesnější formulaci.",
    author: "Podvržené jméno",
    unit: "Podvržená jednota",
    authorUserId: "attacker",
    ...overrides,
  };
}

async function createHarness() {
  const clock = createFakeClock();
  const repository = createBrowserRepository({ storage: createMemoryStorage() });
  const cryptoAdapter = createCryptoAdapter(globalThis.crypto);
  const audit = createAuditService(repository, clock.now);
  const auth = createAuthService({ repository, audit, cryptoAdapter, now: clock.now });
  await auth.ensureDemoCredentials();
  const adminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.admin);
  const superadminSession = await auth.loginWithPassword(MODEL_CREDENTIALS.superadmin);
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

  repository.update((state) => {
    state.users.push(
      user({
        id: "admin-b",
        firstName: "Alena",
        lastName: "Správcová",
        email: "admin-b@example.cz",
        sokolUnit: "ČOS",
        role: ROLE.ADMIN,
      }),
      user(),
      user({ id: "member-blocked", email: "blocked@example.cz", status: USER_STATUS.BLOCKED }),
      user({ id: "member-unverified", email: "unverified@example.cz", emailVerifiedAt: null }),
    );
    state.sessions.push(
      session("session-admin-b", "admin-b", clock.now()),
      session("session-member", "member-verified", clock.now()),
      session("session-blocked", "member-blocked", clock.now()),
      session("session-unverified", "member-unverified", clock.now()),
    );
  });

  const norms = createNormService({ repository, auth, audit, fileRepository, now: clock.now });
  return {
    adminSession,
    audit,
    auth,
    clock,
    files,
    norms,
    repository,
    superadminSession,
  };
}

async function runManagedAction(norms, action, sessionId, normId) {
  if (action === "status") return norms.update(sessionId, normId, { status: "Ke schválení" });
  if (action === "close") return norms.update(sessionId, normId, { commentsOpen: false });
  if (action === "document") {
    return norms.replaceDocument(sessionId, normId, {
      name: `${normId}.pdf`,
      size: 1024,
      type: "application/pdf",
    });
  }
  if (action === "reply") return norms.reply(sessionId, normId, normId === "norm-001" ? "sub-1" : "sub-4", "Odpověď správce");
  if (action === "resolve") {
    return norms.resolveSubmission(
      sessionId,
      normId,
      normId === "norm-001" ? "sub-1" : "sub-4",
      { resolutionStatus: "Zapracováno", resolution: "Přijato.", adminComment: "Děkujeme." },
    );
  }
  if (action === "remove") return norms.remove(sessionId, normId);
  throw new Error(`Unknown action: ${action}`);
}

describe("norm service", () => {
  let harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it("reads public norms and limits manageable norms to the owner unless the actor is superadmin", () => {
    const { adminSession, norms, repository, superadminSession } = harness;

    expect(norms.listPublicNorms("Aktivní").map((norm) => norm.id)).toEqual(["norm-001", "norm-002"]);
    expect(norms.listPublicNorms("Uzavřené")).toEqual([]);
    expect(norms.listPublicNorms("Všechny")).toHaveLength(3);
    expect(norms.listManageable(adminSession.id)).toHaveLength(3);
    expect(norms.listManageable("session-admin-b")).toEqual([]);
    expect(norms.listManageable(superadminSession.id)).toHaveLength(3);

    repository.update((state) => {
      state.norms[0].visibilityMode = "title-only";
    });
    expect(norms.listPublicNorms("Všechny")[0]).not.toHaveProperty("sections");
    const publicView = norms.getPublicNorm("norm-001");
    expect(publicView).toMatchObject({ id: "norm-001", title: "Členský a organizační řád" });
    expect(publicView).not.toHaveProperty("sections");
    expect(norms.getPublicNorm("norm-001", repository.read().users.find((item) => item.id === "member-verified"))).toHaveProperty("sections");
  });

  it("creates the next numbered norm for the administrator and stores its optional document", async () => {
    const { adminSession, files, norms, repository } = harness;
    const file = { name: "navrh.pdf", size: 2048, type: "application/pdf" };

    const result = await norms.create(adminSession.id, normInput(), file);

    expect(result).toMatchObject({ message: "Norma SOKOL-2026-004 byla založena." });
    expect(result.norm).toMatchObject({
      number: "SOKOL-2026-004",
      ownerAdminId: adminSession.userId,
      visibilityMode: "public-detail",
      file: { name: "navrh.pdf", size: 2048, type: "application/pdf" },
    });
    expect(files.get(result.norm.file.id)).toBe(file);
    expect(repository.read().normSequenceByYear).toMatchObject({ 2026: 4 });
    expect(repository.read().auditEvents).toContainEqual(
      expect.objectContaining({
        actorUserId: adminSession.userId,
        action: "norm.created",
        targetId: result.norm.id,
      }),
    );
  });

  it("allows the owner and superadmin to update a norm but denies another administrator and protects identity fields", async () => {
    const { adminSession, norms, repository, superadminSession } = harness;

    await expect(norms.update("session-admin-b", "norm-001", { title: "Cizí změna" })).rejects.toBeInstanceOf(AuthorizationError);
    await norms.update(adminSession.id, "norm-001", {
      title: "Vlastníkova změna",
      id: "stolen-id",
      number: "STOLEN-001",
      ownerAdminId: "admin-b",
      submissions: [],
    });
    await norms.update(superadminSession.id, "norm-001", { title: "Změna superadministrátora" });

    expect(repository.read().norms.find((norm) => norm.id === "norm-001")).toMatchObject({
      id: "norm-001",
      number: "SOKOL-2026-001",
      ownerAdminId: adminSession.userId,
      title: "Změna superadministrátora",
    });
    expect(repository.read().norms.find((norm) => norm.id === "norm-001").submissions).not.toEqual([]);
    expect(repository.read().auditEvents).toContainEqual(
      expect.objectContaining({
        actorUserId: "admin-b",
        action: "authorization.denied",
        targetId: "norm-001",
        metadata: expect.objectContaining({
          requestedAction: "norm.update",
          permission: "manage_norm",
        }),
      }),
    );
  });

  it.each(["status", "close", "document", "reply", "resolve", "remove"])(
    "enforces the owner matrix for the managed %s action",
    async (action) => {
      const { adminSession, norms, repository, superadminSession } = harness;

      await expect(runManagedAction(norms, action, "session-admin-b", "norm-001")).rejects.toMatchObject({
        name: "AuthorizationError",
        code: "manage_norm",
      });
      await expect(runManagedAction(norms, action, adminSession.id, "norm-001")).resolves.toHaveProperty("message");
      await expect(runManagedAction(norms, action, superadminSession.id, "norm-002")).resolves.toHaveProperty("message");

      expect(repository.read().auditEvents).toContainEqual(
        expect.objectContaining({
          actorUserId: "admin-b",
          action: "authorization.denied",
          targetId: "norm-001",
        }),
      );
    },
  );

  it("derives contribution identity from the verified session and rejects public, blocked and unverified actors", async () => {
    const { norms, repository } = harness;

    await expect(norms.addContribution(undefined, "norm-001", contributionInput())).rejects.toBeInstanceOf(AuthorizationError);
    await expect(norms.addContribution("session-blocked", "norm-001", contributionInput())).rejects.toBeInstanceOf(AuthorizationError);
    await expect(norms.addContribution("session-unverified", "norm-001", contributionInput())).rejects.toBeInstanceOf(AuthorizationError);

    const result = await norms.addContribution("session-member", "norm-001", contributionInput());

    expect(result.contribution).toMatchObject({
      authorUserId: "member-verified",
      author: "Jana Nováková",
      unit: "TJ Sokol Brno I",
      score: 0,
      resolutionStatus: "Nevypořádáno",
    });
    expect(result.contribution).not.toMatchObject({ author: "Podvržené jméno", unit: "Podvržená jednota" });
    expect(repository.read().auditEvents.filter((event) => event.action === "authorization.denied")).toHaveLength(3);
  });

  it("refuses a new contribution after the owner closes collection", async () => {
    const { adminSession, norms } = harness;
    await norms.update(adminSession.id, "norm-001", { commentsOpen: false });

    await expect(norms.addContribution("session-member", "norm-001", contributionInput())).rejects.toBeInstanceOf(NormServiceError);
    await expect(norms.addContribution("session-member", "norm-001", contributionInput())).rejects.toMatchObject({ code: "COMMENTS_CLOSED" });
  });

  it.each(["Schváleno", "Neschváleno", "Archivováno"])(
    "normalizes commentsOpen to false when the owner updates status to %s",
    async (status) => {
      const { adminSession, norms, repository } = harness;

      const result = await norms.update(adminSession.id, "norm-001", {
        status,
        commentsOpen: true,
      });

      expect(result.norm).toMatchObject({ status, commentsOpen: false });
      expect(repository.read().norms[0]).toMatchObject({ status, commentsOpen: false });
    },
  );

  it.each(["Schváleno", "Neschváleno", "Archivováno"])(
    "rejects a contribution to %s even when persisted commentsOpen is stale true",
    async (status) => {
      const { norms, repository } = harness;
      repository.update((state) => {
        state.norms[0].status = status;
        state.norms[0].commentsOpen = true;
      });
      const before = repository.read().norms[0].submissions.length;

      await expect(
        norms.addContribution("session-member", "norm-001", contributionInput()),
      ).rejects.toMatchObject({ code: "COMMENTS_CLOSED" });
      expect(repository.read().norms[0].submissions).toHaveLength(before);
    },
  );

  it("keeps exactly one current submission vote per user and replaces its score contribution", async () => {
    const { norms, repository } = harness;

    await norms.voteSubmission("session-member", "norm-001", "sub-1", 1);
    await norms.voteSubmission("session-member", "norm-001", "sub-1", 1);
    await norms.voteSubmission("session-member", "norm-001", "sub-1", -1);

    const state = repository.read();
    expect(state.norms[0].submissions.find((submission) => submission.id === "sub-1").score).toBe(27);
    expect(state.votes).toMatchObject({
      "submission:member-verified:norm-001:sub-1": -1,
    });
    expect(Object.keys(state.votes).filter((key) => key.includes("member-verified:norm-001:sub-1"))).toHaveLength(1);
  });

  it("keeps exactly one current need vote per user and moves the aggregate when the choice changes", async () => {
    const { norms, repository } = harness;

    await norms.voteNeed("session-member", "norm-001", "yes");
    await norms.voteNeed("session-member", "norm-001", "yes");
    await norms.voteNeed("session-member", "norm-001", "no");

    const state = repository.read();
    expect(state.norms[0].needVotes).toEqual({ yes: 72, no: 29 });
    expect(state.votes).toMatchObject({ "need:member-verified:norm-001": "no" });
    expect(Object.keys(state.votes).filter((key) => key.includes("member-verified:norm-001"))).toHaveLength(1);
  });

  it("audits denied direct participation calls and does not mutate votes", async () => {
    const { norms, repository } = harness;
    const before = repository.read().norms[0];

    await expect(norms.voteSubmission(undefined, "norm-001", "sub-1", 1)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(norms.voteSubmission("session-blocked", "norm-001", "sub-1", 1)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(norms.voteNeed("session-unverified", "norm-001", "yes")).rejects.toBeInstanceOf(AuthorizationError);

    const after = repository.read();
    expect(after.norms[0].submissions.find((item) => item.id === "sub-1").score).toBe(before.submissions.find((item) => item.id === "sub-1").score);
    expect(after.norms[0].needVotes).toEqual(before.needVotes);
    expect(after.votes).toEqual({});
    expect(after.auditEvents.filter((event) => event.action === "authorization.denied")).toHaveLength(3);
  });

  it("rejects a document over 15 MB before writing to the file repository", async () => {
    const { adminSession, files, norms } = harness;

    await expect(
      norms.replaceDocument(adminSession.id, "norm-001", {
        name: "large.pdf",
        size: 15 * 1024 * 1024 + 1,
        type: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(files.size).toBe(0);
  });

  it("keeps the newest document when two replacements happen at the same clock tick", async () => {
    const { adminSession, files, norms } = harness;
    const firstFile = { name: "first.pdf", size: 10, type: "application/pdf" };
    const secondFile = { name: "second.pdf", size: 20, type: "application/pdf" };

    const first = await norms.replaceDocument(adminSession.id, "norm-001", firstFile);
    const second = await norms.replaceDocument(adminSession.id, "norm-001", secondFile);

    expect(second.file.id).not.toBe(first.file.id);
    expect(files.has(first.file.id)).toBe(false);
    expect(files.get(second.file.id)).toBe(secondFile);
  });

  it("removes only votes belonging to the deleted norm, not a similarly prefixed id", async () => {
    const { adminSession, norms, repository } = harness;
    repository.update((state) => {
      state.norms.push({ ...structuredClone(state.norms[0]), id: "norm-0010" });
      state.votes = {
        "need:member-verified:norm-001": "yes",
        "need:member-verified:norm-0010": "no",
      };
    });

    await norms.remove(adminSession.id, "norm-001");

    expect(repository.read().votes).toEqual({ "need:member-verified:norm-0010": "no" });
  });

  it("continues the historical sequence after the highest numbered norm is deleted", async () => {
    const { adminSession, norms, repository } = harness;
    const first = await norms.create(adminSession.id, normInput({ title: "Čtvrtá norma" }));
    await norms.remove(adminSession.id, first.norm.id);

    const second = await norms.create(adminSession.id, normInput({ title: "Pátá norma" }));

    expect(first.norm.number).toBe("SOKOL-2026-004");
    expect(second.norm.number).toBe("SOKOL-2026-005");
    expect(repository.read().normSequenceByYear).toMatchObject({ 2026: 5 });
  });

  it("reserves distinct numbers when concurrent creates resume from delayed file stores", async () => {
    const { adminSession, audit, auth, clock, repository } = harness;
    const files = new Map();
    const releases = [];
    const delayedFileRepository = {
      storeFile(id, file) {
        return new Promise((resolve) => {
          releases.push(() => {
            files.set(id, file);
            resolve();
          });
        });
      },
      async readFile(id) {
        return files.get(id);
      },
      async removeFile(id) {
        if (id) files.delete(id);
      },
    };
    const concurrentNorms = createNormService({
      repository,
      auth,
      audit,
      fileRepository: delayedFileRepository,
      now: clock.now,
    });
    const firstFile = { name: "first.pdf", size: 10, type: "application/pdf" };
    const secondFile = { name: "second.pdf", size: 20, type: "application/pdf" };

    const firstPromise = concurrentNorms.create(
      adminSession.id,
      normInput({ title: "Souběžná první" }),
      firstFile,
    );
    const secondPromise = concurrentNorms.create(
      adminSession.id,
      normInput({ title: "Souběžná druhá" }),
      secondFile,
    );
    expect(releases).toHaveLength(2);
    releases[1]();
    releases[0]();
    const created = await Promise.all([firstPromise, secondPromise]);

    expect(created.map((result) => result.norm.number).sort()).toEqual([
      "SOKOL-2026-004",
      "SOKOL-2026-005",
    ]);
    expect(new Set(created.map((result) => result.norm.id))).toHaveProperty("size", 2);
    expect(new Set(created.map((result) => result.norm.file.id))).toHaveProperty("size", 2);
    expect(files.size).toBe(2);
    expect(repository.read().normSequenceByYear).toMatchObject({ 2026: 5 });
  });

  it("leaves no norm, sequence reservation or orphaned file when file storage fails", async () => {
    const { adminSession, audit, auth, clock, repository } = harness;
    const files = new Map();
    const failingFileRepository = {
      async storeFile(id, file) {
        files.set(id, file);
        throw new Error("file store failed");
      },
      async readFile(id) {
        return files.get(id);
      },
      async removeFile(id) {
        if (id) files.delete(id);
      },
    };
    const failingNorms = createNormService({
      repository,
      auth,
      audit,
      fileRepository: failingFileRepository,
      now: clock.now,
    });
    const before = repository.read();

    await expect(
      failingNorms.create(
        adminSession.id,
        normInput({ title: "Neuložená norma" }),
        { name: "broken.pdf", size: 10, type: "application/pdf" },
      ),
    ).rejects.toThrow("file store failed");

    const after = repository.read();
    expect(after.norms).toEqual(before.norms);
    expect(after.normSequenceByYear).toEqual(before.normSequenceByYear);
    expect(files.size).toBe(0);
  });
});

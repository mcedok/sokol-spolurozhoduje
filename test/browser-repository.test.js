import { describe, expect, it } from "vitest";
import { createBrowserRepository } from "../app/data/browser-repository.js";
import { createInitialState } from "../app/domain/demo-data.js";

describe("browser repository", () => {
  it("migrates legacy demo addresses and adds the documented demo member without replacing user changes", () => {
    localStorage.setItem(
      "sokol-spolurozhoduje-pilot-v2",
      JSON.stringify({
        schemaVersion: 3,
        users: [
          { id: "user-superadmin-demo", email: "superadmin@sokol.cz", firstName: "Petra" },
          { id: "user-admin-demo", email: "vlastni-adresa@example.cz", firstName: "Martin" },
        ],
        norms: [],
      }),
    );

    const state = createBrowserRepository({ storage: localStorage }).read();

    expect(state.users.find((user) => user.id === "user-superadmin-demo")).toMatchObject({
      email: "superadmin@sokol.demo",
      sokolUnit: "Česká obec sokolská",
      membershipId: "DEMO-SUPERADMIN-001",
    });
    expect(state.users.find((user) => user.id === "user-admin-demo")).toMatchObject({
      email: "vlastni-adresa@example.cz",
      sokolUnit: "TJ Sokol Praha",
      membershipId: "DEMO-ADMIN-001",
    });
    expect(state.users.find((user) => user.email === "administrator@sokol.demo")).toMatchObject({
      role: "admin",
      status: "active",
    });
    expect(state.users.find((user) => user.id === "user-member-demo")).toMatchObject({
      email: "clen@sokol.demo",
      membershipId: "DEMO-CLEN-001",
    });
  });

  it("migrates v2 norms to the access-control schema", () => {
    localStorage.setItem("sokol-spolurozhoduje-pilot-v2", JSON.stringify([{ id: "n1" }]));
    const state = createBrowserRepository({ storage: localStorage, now: () => 1 }).read();
    expect(state.schemaVersion).toBe(3);
    expect(state.norms[0]).toMatchObject({
      id: "n1",
      ownerAdminId: "user-admin-demo",
      visibilityMode: "public-detail",
    });
  });

  it("preserves an existing visibility mode during migration", () => {
    localStorage.setItem(
      "sokol-spolurozhoduje-pilot-v2",
      JSON.stringify({ schemaVersion: 3, norms: [{ id: "n1", visibilityMode: "title-only" }] }),
    );

    const state = createBrowserRepository({ storage: localStorage, now: () => 1 }).read();

    expect(state.norms[0].visibilityMode).toBe("title-only");
    expect(JSON.parse(localStorage.getItem("sokol-spolurozhoduje-pilot-v2")).norms[0].visibilityMode).toBe("title-only");
  });

  it("migrates per-year norm sequences from historical maxima without lowering a stored counter", () => {
    localStorage.setItem(
      "sokol-spolurozhoduje-pilot-v2",
      JSON.stringify({
        schemaVersion: 3,
        norms: [
          { id: "old-2025", number: "SOKOL-2025-007" },
          { id: "old-2026", number: "SOKOL-2026-004" },
          { id: "ignored", number: "OTHER-2026-999" },
        ],
        normSequenceByYear: { 2025: 5, 2026: 9 },
      }),
    );

    const state = createBrowserRepository({ storage: localStorage }).read();

    expect(state.normSequenceByYear).toEqual({ 2025: 7, 2026: 9 });
    expect(
      JSON.parse(localStorage.getItem("sokol-spolurozhoduje-pilot-v2")).normSequenceByYear,
    ).toEqual({ 2025: 7, 2026: 9 });
  });

  it("returns a recoverable initial state without deleting malformed storage", () => {
    localStorage.setItem("sokol-spolurozhoduje-pilot-v2", "{not-json");

    const state = createBrowserRepository({ storage: localStorage, now: () => 1 }).read();

    expect(state).toMatchObject({ schemaVersion: 3, recoveryRequired: true });
    expect(localStorage.getItem("sokol-spolurozhoduje-pilot-v2")).toBe("{not-json");
  });

  it("refuses updates during recovery and preserves malformed storage", () => {
    localStorage.setItem("sokol-spolurozhoduje-pilot-v2", "{not-json");
    const repository = createBrowserRepository({ storage: localStorage, now: () => 1 });

    expect(() => repository.update(() => {})).toThrow(/reset/i);
    expect(localStorage.getItem("sokol-spolurozhoduje-pilot-v2")).toBe("{not-json");
  });

  it("updates a cloned current state and persists the mutator result", () => {
    localStorage.setItem(
      "sokol-spolurozhoduje-pilot-v2",
      JSON.stringify({ schemaVersion: 3, norms: [{ id: "n1", title: "Původní" }] }),
    );
    const repository = createBrowserRepository({ storage: localStorage, now: () => 1 });
    const beforeUpdate = repository.read();

    const state = repository.update((draft) => {
      draft.norms[0].title = "Nový";
    });

    expect(beforeUpdate.norms[0].title).toBe("Původní");
    expect(state.norms[0].title).toBe("Nový");
    expect(JSON.parse(localStorage.getItem("sokol-spolurozhoduje-pilot-v2")).norms[0].title).toBe("Nový");
  });

  it("resets persisted state to a fresh access-control initial state", () => {
    localStorage.setItem("sokol-spolurozhoduje-pilot-v2", JSON.stringify([{ id: "old" }]));
    const repository = createBrowserRepository({ storage: localStorage, now: () => 1 });

    const state = repository.reset();

    expect(state).toEqual(createInitialState());
    expect(JSON.parse(localStorage.getItem("sokol-spolurozhoduje-pilot-v2"))).toEqual(state);
  });
});

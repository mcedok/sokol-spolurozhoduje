import { describe, expect, it } from "vitest";
import { createBrowserRepository } from "../app/data/browser-repository.js";
import { createInitialState } from "../app/domain/demo-data.js";

describe("browser repository", () => {
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

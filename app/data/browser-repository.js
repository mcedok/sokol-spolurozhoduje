import { createInitialState } from "../domain/demo-data.js";

const STORAGE_KEY = "sokol-spolurozhoduje-pilot-v2";
const DEFAULT_OWNER_ADMIN_ID = "user-admin-demo";

function migrateNorm(norm) {
  return {
    ...norm,
    ownerAdminId: norm.ownerAdminId || DEFAULT_OWNER_ADMIN_ID,
    visibilityMode: "public-detail",
  };
}

function migrateState(value) {
  const initialState = createInitialState();
  const legacyNorms = Array.isArray(value) ? value : value.norms;

  return {
    ...initialState,
    ...(Array.isArray(value) ? {} : value),
    schemaVersion: 3,
    norms: (legacyNorms || initialState.norms).map(migrateNorm),
    users: Array.isArray(value.users) ? value.users : initialState.users,
    challenges: Array.isArray(value.challenges) ? value.challenges : initialState.challenges,
    sessions: Array.isArray(value.sessions) ? value.sessions : initialState.sessions,
    auditEvents: Array.isArray(value.auditEvents) ? value.auditEvents : initialState.auditEvents,
    votes: value.votes && typeof value.votes === "object" ? value.votes : initialState.votes,
  };
}

export function createBrowserRepository({ storage }) {
  function read() {
    const saved = storage.getItem(STORAGE_KEY);
    if (!saved) return createInitialState();

    try {
      const state = migrateState(JSON.parse(saved));
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return state;
    } catch {
      return { ...createInitialState(), recoveryRequired: true };
    }
  }

  function update(mutator) {
    const state = structuredClone(read());
    mutator(state);
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  function reset() {
    const state = createInitialState();
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  return { read, update, reset };
}

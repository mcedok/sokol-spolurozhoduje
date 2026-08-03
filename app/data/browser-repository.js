import { createInitialState, deriveNormSequenceByYear } from "../domain/demo-data.js";

const STORAGE_KEY = "sokol-spolurozhoduje-pilot-v2";
const DEFAULT_OWNER_ADMIN_ID = "user-admin-demo";

function migrateNorm(norm) {
  return {
    ...norm,
    ownerAdminId: norm.ownerAdminId || DEFAULT_OWNER_ADMIN_ID,
    visibilityMode: norm.visibilityMode || "public-detail",
  };
}

const LEGACY_DEMO_EMAILS = {
  "user-superadmin-demo": "superadmin@sokol.cz",
  "user-admin-demo": "admin@sokol.cz",
};

function migrateUsers(users, initialUsers) {
  const migrated = (users || initialUsers).map((user) => {
    const initialUser = initialUsers.find((candidate) => candidate.id === user.id);
    if (!initialUser) return user;
    const retainsSeedIdentity =
      user.email === LEGACY_DEMO_EMAILS[user.id] ||
      user.email?.toLowerCase() === initialUser.email.toLowerCase();
    return {
      ...user,
      email: user.email === LEGACY_DEMO_EMAILS[user.id] ? initialUser.email : user.email,
      sokolUnit: user.sokolUnit ?? initialUser.sokolUnit,
      membershipId: user.membershipId ?? initialUser.membershipId,
      demoCredential:
        user.demoCredential ?? (retainsSeedIdentity ? initialUser.demoCredential : undefined),
    };
  });

  for (const initialUser of initialUsers) {
    if (
      migrated.some(
        (user) =>
          user.demoCredential === initialUser.demoCredential &&
          user.email?.toLowerCase() === initialUser.email.toLowerCase() &&
          user.role === initialUser.role,
      )
    ) {
      continue;
    }
    if (!migrated.some((user) => user.id === initialUser.id)) {
      migrated.push(initialUser);
      continue;
    }
    let suffix = 1;
    let credentialId = `${initialUser.id}-credential`;
    while (migrated.some((user) => user.id === credentialId)) {
      suffix += 1;
      credentialId = `${initialUser.id}-credential-${suffix}`;
    }
    migrated.push({ ...initialUser, id: credentialId });
  }
  return migrated;
}

function migrateState(value) {
  const initialState = createInitialState();
  const legacyNorms = Array.isArray(value) ? value : value.norms;
  const norms = (legacyNorms || initialState.norms).map(migrateNorm);

  return {
    ...initialState,
    ...(Array.isArray(value) ? {} : value),
    schemaVersion: 3,
    norms,
    normSequenceByYear: deriveNormSequenceByYear(
      norms,
      Array.isArray(value) ? undefined : value.normSequenceByYear,
    ),
    users: migrateUsers(Array.isArray(value.users) ? value.users : undefined, initialState.users),
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
    const current = read();
    if (current.recoveryRequired) {
      throw new Error("Data recovery requires reset.");
    }
    const state = structuredClone(current);
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

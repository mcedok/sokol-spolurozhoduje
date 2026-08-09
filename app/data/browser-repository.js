import { createInitialState, deriveNormSequenceByYear } from "../domain/demo-data.js";

const STORAGE_KEY = "sokol-spolurozhoduje-pilot-v2";
const DEFAULT_OWNER_ADMIN_ID = "user-admin-demo";
const CURRENT_SCHEMA_VERSION = 3;

function migrateNorm(norm) {
  return {
    ...norm,
    ownerAdminId: norm.ownerAdminId || DEFAULT_OWNER_ADMIN_ID,
    visibilityMode: norm.visibilityMode || "public-detail",
    closureReason: norm.closureReason || "",
  };
}

const LEGACY_DEMO_EMAILS = {
  "user-superadmin-demo": "superadmin@sokol.cz",
  "user-admin-demo": "admin@sokol.cz",
};

function migrateUsers(users, initialUsers) {
  if (!Array.isArray(users)) return initialUsers;

  return users.map((user) => {
    const initialUser = initialUsers.find((candidate) => candidate.id === user.id);
    if (!initialUser) return user;
    const email = user.email === LEGACY_DEMO_EMAILS[user.id] ? initialUser.email : user.email;
    const role = user.role ?? initialUser.role;
    const retainsSeedIdentity =
      role === initialUser.role &&
      (user.email === LEGACY_DEMO_EMAILS[user.id] ||
        email?.toLowerCase() === initialUser.email.toLowerCase());
    const migrated = {
      ...initialUser,
      ...user,
      email,
      role,
      sokolUnit: user.sokolUnit ?? initialUser.sokolUnit,
      membershipId: user.membershipId ?? initialUser.membershipId,
    };
    for (const credentialField of ["passwordHash", "passwordSalt", "passwordUpdatedAt"]) {
      if (!Object.prototype.hasOwnProperty.call(user, credentialField)) delete migrated[credentialField];
    }
    if (retainsSeedIdentity) migrated.demoCredential = initialUser.demoCredential;
    else delete migrated.demoCredential;
    return migrated;
  });
}

function migrateState(value) {
  const initialState = createInitialState();
  const legacyNorms = Array.isArray(value) ? value : value.norms;
  const norms = (legacyNorms || initialState.norms).map(migrateNorm);

  return {
    ...initialState,
    ...(Array.isArray(value) ? {} : value),
    schemaVersion: CURRENT_SCHEMA_VERSION,
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
  function recoveryState(recoveryReason) {
    return { ...createInitialState(), recoveryRequired: true, recoveryReason };
  }

  function read() {
    const saved = storage.getItem(STORAGE_KEY);
    if (!saved) return createInitialState();

    let parsed;
    try {
      parsed = JSON.parse(saved);
    } catch {
      return recoveryState("corrupted-json");
    }

    if (
      !Array.isArray(parsed) &&
      Number.isFinite(Number(parsed?.schemaVersion)) &&
      Number(parsed.schemaVersion) > CURRENT_SCHEMA_VERSION
    ) {
      return recoveryState("newer-schema");
    }

    try {
      const state = migrateState(parsed);
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return state;
    } catch {
      return recoveryState("incompatible-data");
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

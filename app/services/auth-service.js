import { CHALLENGE_TYPE, LIMITS, ROLE, USER_STATUS } from "../domain/constants.js";
import { DEMO_CREDENTIALS } from "../domain/demo-data.js";

const PASSWORD_REQUIREMENTS = {
  minimumLength: 10,
  uppercase: /[A-Z]/,
  lowercase: /[a-z]/,
  digit: /\d/,
  special: /[^A-Za-z0-9]/,
};

const ERROR_MESSAGES = {
  ACCOUNT_BLOCKED: "Uzivatelsky ucet je zablokovany.",
  CODE_EXPIRED: "Overovaci kod vyprsel.",
  CODE_LOCKED: "Overovaci kod byl uzamcen.",
  CODE_USED: "Overovaci kod uz byl pouzit.",
  EMAIL_EXISTS: "Ucet s timto e-mailem uz existuje.",
  INVALID_CODE: "Overovaci kod neni platny.",
  INVALID_CREDENTIALS: "E-mail nebo heslo nejsou platne.",
  INVALID_PROFILE: "Vyplnte vsechna povinna profilova pole.",
  INVALID_SESSION: "Relace neni platna.",
  INVALID_TOKEN: "Odkaz neni platny.",
  SESSION_EXPIRED: "Relace vyprsela.",
  SESSION_REVOKED: "Relace byla zrusena.",
  TOKEN_EXPIRED: "Odkaz vyprsel.",
  TOKEN_USED: "Odkaz uz byl pouzit.",
  UNAUTHORIZED: "Pro tuto akci nemate opravneni.",
  USER_NOT_FOUND: "Uzivatel nebyl nalezen.",
  WEAK_PASSWORD: "Heslo nesplnuje bezpecnostni pozadavky.",
};

const DEMO_ROLES = {
  superadmin: ROLE.SUPERADMIN,
  admin: ROLE.ADMIN,
  member: ROLE.MEMBER,
};

const DEMO_SEED_IDS = {
  superadmin: "user-superadmin-demo",
  admin: "user-admin-demo",
  member: "user-member-demo",
};

export class AuthError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || "Autentizace se nezdarila.");
    this.name = "AuthError";
    this.code = code;
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeMemberProfile(profile = {}) {
  const normalized = {
    firstName: String(profile.firstName || "").trim(),
    lastName: String(profile.lastName || "").trim(),
    email: normalizeEmail(profile.email),
    sokolUnit: String(profile.sokolUnit || "").trim(),
    membershipId: String(profile.membershipId || "").trim(),
  };

  if (Object.values(normalized).some((value) => !value)) throw new AuthError("INVALID_PROFILE");
  return normalized;
}

function assertStrongPassword(password) {
  const valid =
    typeof password === "string" &&
    password.length >= PASSWORD_REQUIREMENTS.minimumLength &&
    PASSWORD_REQUIREMENTS.uppercase.test(password) &&
    PASSWORD_REQUIREMENTS.lowercase.test(password) &&
    PASSWORD_REQUIREMENTS.digit.test(password) &&
    PASSWORD_REQUIREMENTS.special.test(password);

  if (!valid) throw new AuthError("WEAK_PASSWORD");
}

export function createAuthService({ repository, audit, cryptoAdapter, now }) {
  function findUserByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    const candidates = repository
      .read()
      .users.filter((candidate) => normalizeEmail(candidate.email) === normalizedEmail);
    const demoCredential = Object.entries(DEMO_CREDENTIALS).find(
      ([, credential]) => normalizeEmail(credential.email) === normalizedEmail,
    )?.[0];
    if (demoCredential) {
      const seeded = candidates.find(
        (candidate) =>
          candidate.demoCredential === demoCredential &&
          candidate.role === DEMO_ROLES[demoCredential],
      );
      if (seeded) return seeded;
    }
    return candidates[0];
  }

  function createId(prefix) {
    return `${prefix}-${cryptoAdapter.randomToken()}`;
  }

  function record(action, targetId, actorUserId = targetId, metadata = {}) {
    audit.record({ actorUserId, action, targetType: "user", targetId, metadata });
  }

  function createSessionRecord(userId) {
    const createdAt = now();
    return {
      id: createId("session"),
      userId,
      createdAt,
      expiresAt: createdAt + LIMITS.sessionMs,
      revokedAt: null,
    };
  }

  async function createChallenge(type, userId, secret, lifetime) {
    const credential = await cryptoAdapter.hashSecret(secret);
    const createdAt = now();
    return {
      id: createId("challenge"),
      type,
      userId,
      secretHash: credential.hash,
      secretSalt: credential.salt,
      createdAt,
      expiresAt: createdAt + lifetime,
      attempts: 0,
      usedAt: null,
      lockedAt: null,
      revokedAt: null,
    };
  }

  function getSession(sessionId) {
    const state = repository.read();
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new AuthError("INVALID_SESSION");
    if (session.revokedAt !== null) throw new AuthError("SESSION_REVOKED");
    if (session.expiresAt <= now()) throw new AuthError("SESSION_EXPIRED");

    const user = state.users.find((candidate) => candidate.id === session.userId);
    if (!user) throw new AuthError("INVALID_SESSION");
    if (user.status === USER_STATUS.BLOCKED) throw new AuthError("ACCOUNT_BLOCKED");
    if (user.status !== USER_STATUS.ACTIVE) throw new AuthError("INVALID_SESSION");

    return { ...session, user };
  }

  function logout(sessionId) {
    repository.update((state) => {
      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (session && session.revokedAt === null) session.revokedAt = now();
    });
  }

  function revokeUserSessions(userId) {
    repository.update((state) => {
      for (const session of state.sessions) {
        if (session.userId === userId && session.revokedAt === null) session.revokedAt = now();
      }
    });
  }

  function revokeUserChallenges(userId) {
    repository.update((state) => {
      for (const challenge of state.challenges) {
        if (challenge.userId === userId && challenge.usedAt === null && challenge.revokedAt === null) {
          challenge.revokedAt = now();
        }
      }
    });
  }

  async function issueMemberCode(user) {
    const demoCode =
      user.demoCredential === "member"
        ? DEMO_CREDENTIALS.member.code
        : cryptoAdapter.randomDigits(6);
    const challenge = await createChallenge(
      CHALLENGE_TYPE.MEMBER_CODE,
      user.id,
      demoCode,
      LIMITS.memberCodeMs,
    );
    repository.update((state) => state.challenges.push(challenge));
    record("auth.member_code_requested", user.id, user.id, { challengeId: challenge.id });
    return {
      kind: "member_code",
      challengeId: challenge.id,
      userId: user.id,
      recipientLabel: `${user.firstName} ${user.lastName}`.trim(),
      recipientEmail: user.email,
      demoCode,
    };
  }

  async function registerMember(profile) {
    const normalized = normalizeMemberProfile(profile);
    if (repository.read().users.some((user) => normalizeEmail(user.email) === normalized.email)) {
      throw new AuthError("EMAIL_EXISTS");
    }

    const user = {
      id: createId("user"),
      ...normalized,
      role: ROLE.MEMBER,
      status: USER_STATUS.PENDING,
      emailVerifiedAt: null,
    };
    repository.update((state) => state.users.push(user));
    record("auth.member_registered", user.id, user.id);
    return issueMemberCode(user);
  }

  function identify(email) {
    const user = findUserByEmail(email);
    if (!user) return { kind: "register" };
    if (user.role === ROLE.MEMBER) return { kind: "member" };
    return { kind: "password" };
  }

  async function requestMemberCode(email) {
    const user = findUserByEmail(email);
    if (!user || user.role !== ROLE.MEMBER || user.status === USER_STATUS.BLOCKED) {
      return { kind: "member_code" };
    }
    return issueMemberCode(user);
  }

  async function verifyMemberCode({ challengeId, code }) {
    const challenge = repository
      .read()
      .challenges.find(
        (candidate) => candidate.id === challengeId && candidate.type === CHALLENGE_TYPE.MEMBER_CODE,
    );
    if (!challenge) throw new AuthError("INVALID_CODE");
    if (challenge.revokedAt !== null) throw new AuthError("INVALID_CODE");
    if (challenge.usedAt !== null) throw new AuthError("CODE_USED");
    if (challenge.lockedAt !== null || challenge.attempts >= LIMITS.maxCodeAttempts) {
      throw new AuthError("CODE_LOCKED");
    }
    if (challenge.expiresAt <= now()) throw new AuthError("CODE_EXPIRED");

    const valid = await cryptoAdapter.verifySecret(code, challenge.secretSalt, challenge.secretHash);
    if (!valid) {
      let locked = false;
      repository.update((state) => {
        const current = state.challenges.find((candidate) => candidate.id === challenge.id);
        current.attempts += 1;
        if (current.attempts >= LIMITS.maxCodeAttempts) {
          current.lockedAt = now();
          locked = true;
        }
      });
      throw new AuthError(locked ? "CODE_LOCKED" : "INVALID_CODE");
    }

    const session = createSessionRecord(challenge.userId);
    repository.update((state) => {
      const current = state.challenges.find((candidate) => candidate.id === challenge.id);
      if (current.revokedAt !== null) throw new AuthError("INVALID_CODE");
      if (current.usedAt !== null) throw new AuthError("CODE_USED");
      const user = state.users.find((candidate) => candidate.id === challenge.userId);
      if (user.status === USER_STATUS.BLOCKED) throw new AuthError("ACCOUNT_BLOCKED");
      if (user.role !== ROLE.MEMBER || ![USER_STATUS.PENDING, USER_STATUS.ACTIVE].includes(user.status)) {
        throw new AuthError("INVALID_CODE");
      }
      current.usedAt = now();
      user.status = USER_STATUS.ACTIVE;
      user.emailVerifiedAt = now();
      user.lastLoginAt = session.createdAt;
      state.sessions.push(session);
    });
    record("auth.member_verified", challenge.userId, challenge.userId, { challengeId });
    return session;
  }

  async function loginWithPassword({ email, password }) {
    const user = findUserByEmail(email);
    if (!user?.passwordHash || !user.passwordSalt) throw new AuthError("INVALID_CREDENTIALS");
    if (user.status === USER_STATUS.BLOCKED) throw new AuthError("ACCOUNT_BLOCKED");
    if (user.status !== USER_STATUS.ACTIVE) throw new AuthError("INVALID_CREDENTIALS");

    const valid = await cryptoAdapter.verifySecret(password, user.passwordSalt, user.passwordHash);
    if (!valid) throw new AuthError("INVALID_CREDENTIALS");

    const session = createSessionRecord(user.id);
    repository.update((state) => {
      state.sessions.push(session);
      state.users.find((candidate) => candidate.id === user.id).lastLoginAt = session.createdAt;
    });
    record("auth.password_login", user.id, user.id);
    return session;
  }

  async function issuePasswordChallenge(type, user, actorUserId) {
    const demoToken = cryptoAdapter.randomToken();
    const challenge = await createChallenge(type, user.id, demoToken, LIMITS.passwordLinkMs);
    repository.update((state) => {
      if (type === CHALLENGE_TYPE.RESET_PASSWORD) {
        for (const candidate of state.challenges) {
          if (
            candidate.userId === user.id &&
            candidate.type === CHALLENGE_TYPE.RESET_PASSWORD &&
            candidate.usedAt === null &&
            candidate.revokedAt === null
          ) {
            candidate.revokedAt = challenge.createdAt;
          }
        }
      }
      state.challenges.push(challenge);
    });
    record(
      type === CHALLENGE_TYPE.SET_PASSWORD
        ? "auth.password_setup_requested"
        : "auth.password_reset_requested",
      user.id,
      actorUserId,
      { challengeId: challenge.id },
    );
    return {
      kind: type === CHALLENGE_TYPE.SET_PASSWORD ? "password_setup" : "password_reset_requested",
      challengeId: challenge.id,
      userId: user.id,
      recipientLabel: `${user.firstName} ${user.lastName}`.trim(),
      recipientEmail: user.email,
      demoToken,
    };
  }

  async function createPasswordSetup(actorSessionId, userId) {
    const actorSession = getSession(actorSessionId);
    if (actorSession.user.role !== ROLE.SUPERADMIN) throw new AuthError("UNAUTHORIZED");
    const user = repository.read().users.find((candidate) => candidate.id === userId);
    if (!user) throw new AuthError("USER_NOT_FOUND");
    return issuePasswordChallenge(CHALLENGE_TYPE.SET_PASSWORD, user, actorSession.userId);
  }

  async function findPasswordChallenge(token, type) {
    const candidates = repository.read().challenges.filter((challenge) => challenge.type === type);
    for (const challenge of candidates) {
      if (await cryptoAdapter.verifySecret(token, challenge.secretSalt, challenge.secretHash)) {
        return challenge;
      }
    }
    throw new AuthError("INVALID_TOKEN");
  }

  async function completePasswordChallenge({ token, password }, type) {
    assertStrongPassword(password);
    const challenge = await findPasswordChallenge(token, type);
    if (challenge.revokedAt !== null) throw new AuthError("INVALID_TOKEN");
    if (challenge.usedAt !== null) throw new AuthError("TOKEN_USED");
    if (challenge.expiresAt <= now()) throw new AuthError("TOKEN_EXPIRED");

    const credential = await cryptoAdapter.hashSecret(password);
    repository.update((state) => {
      const current = state.challenges.find((candidate) => candidate.id === challenge.id);
      if (current.revokedAt !== null) throw new AuthError("INVALID_TOKEN");
      if (current.usedAt !== null) throw new AuthError("TOKEN_USED");
      const user = state.users.find((candidate) => candidate.id === challenge.userId);
      if (user.status === USER_STATUS.BLOCKED) throw new AuthError("ACCOUNT_BLOCKED");
      current.usedAt = now();
      user.passwordHash = credential.hash;
      user.passwordSalt = credential.salt;
      user.passwordUpdatedAt = now();
      if (type === CHALLENGE_TYPE.SET_PASSWORD) {
        user.status = USER_STATUS.ACTIVE;
        user.emailVerifiedAt ||= now();
      }
      for (const session of state.sessions) {
        if (session.userId === user.id && session.revokedAt === null) session.revokedAt = now();
      }
      if (type === CHALLENGE_TYPE.RESET_PASSWORD) {
        for (const sibling of state.challenges) {
          if (
            sibling.id !== current.id &&
            sibling.userId === user.id &&
            sibling.type === CHALLENGE_TYPE.RESET_PASSWORD &&
            sibling.usedAt === null &&
            sibling.revokedAt === null
          ) {
            sibling.revokedAt = now();
          }
        }
      }
    });
    record(
      type === CHALLENGE_TYPE.SET_PASSWORD ? "auth.password_set" : "auth.password_reset",
      challenge.userId,
      challenge.userId,
      { challengeId: challenge.id },
    );
    return { kind: type === CHALLENGE_TYPE.SET_PASSWORD ? "password_set" : "password_reset_complete" };
  }

  function completePasswordSetup(input) {
    return completePasswordChallenge(input, CHALLENGE_TYPE.SET_PASSWORD);
  }

  async function requestPasswordReset(email) {
    const user = findUserByEmail(email);
    if (!user?.passwordHash || user.status === USER_STATUS.BLOCKED) {
      return { kind: "password_reset_requested" };
    }
    return issuePasswordChallenge(CHALLENGE_TYPE.RESET_PASSWORD, user, user.id);
  }

  function completePasswordReset(input) {
    return completePasswordChallenge(input, CHALLENGE_TYPE.RESET_PASSWORD);
  }

  async function changePassword({ sessionId, currentPassword, newPassword }) {
    const session = getSession(sessionId);
    assertStrongPassword(newPassword);
    const valid = await cryptoAdapter.verifySecret(
      currentPassword,
      session.user.passwordSalt,
      session.user.passwordHash,
    );
    if (!valid) throw new AuthError("INVALID_CREDENTIALS");

    const credential = await cryptoAdapter.hashSecret(newPassword);
    repository.update((state) => {
      const user = state.users.find((candidate) => candidate.id === session.userId);
      user.passwordHash = credential.hash;
      user.passwordSalt = credential.salt;
      user.passwordUpdatedAt = now();
      for (const current of state.sessions) {
        if (current.userId === user.id && current.revokedAt === null) current.revokedAt = now();
      }
    });
    record("auth.password_changed", session.userId, session.userId);
    return { kind: "password_changed" };
  }

  async function ensureDemoCredentials() {
    for (const [credentialName, credential] of Object.entries(DEMO_CREDENTIALS)) {
      if (!credential.password) continue;
      const user = repository.read().users.find(
        (candidate) =>
          candidate.id === DEMO_SEED_IDS[credentialName] &&
          candidate.demoCredential === credentialName &&
          candidate.role === DEMO_ROLES[credentialName] &&
          normalizeEmail(candidate.email) === normalizeEmail(credential.email),
      );
      if (!user || user.passwordHash) continue;

      const passwordCredential = await cryptoAdapter.hashSecret(credential.password);
      repository.update((state) => {
        const current = state.users.find((candidate) => candidate.id === user.id);
        if (!current.passwordHash) {
          current.passwordHash = passwordCredential.hash;
          current.passwordSalt = passwordCredential.salt;
        }
      });
    }
  }

  return {
    identify,
    registerMember,
    requestMemberCode,
    verifyMemberCode,
    loginWithPassword,
    createPasswordSetup,
    completePasswordSetup,
    requestPasswordReset,
    completePasswordReset,
    changePassword,
    getSession,
    logout,
    revokeUserSessions,
    revokeUserChallenges,
    ensureDemoCredentials,
  };
}

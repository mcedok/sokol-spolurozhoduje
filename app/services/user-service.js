import { CHALLENGE_TYPE, ROLE, USER_STATUS } from "../domain/constants.js";
import { assertAuthorized, canManageUsers } from "../security/access-control.js";

const USER_ERROR_MESSAGES = {
  EMAIL_EXISTS: "Ucet s timto e-mailem uz existuje.",
  INVALID_PROFILE: "Vyplnte vsechna povinna profilova pole.",
  INVALID_ROLE: "Vyberte platnou roli uzivatele.",
  INVALID_STATUS: "Vyberte platny stav uzivatele.",
  INVALID_TRANSFER_TARGET: "Novy vlastnik norem musi byt aktivni spravce.",
  LAST_ACTIVE_SUPERADMIN: "Posledniho aktivniho superadministratora nelze zablokovat ani degradovat.",
  TRANSFER_REQUIRED: "Pred degradaci spravce vyberte noveho vlastnika jeho norem.",
  USER_NOT_FOUND: "Uzivatel nebyl nalezen.",
};

const PROFILE_FIELDS = ["firstName", "lastName", "email", "sokolUnit", "membershipId"];
const PRIVILEGED_ROLES = new Set([ROLE.ADMIN, ROLE.SUPERADMIN]);
const USER_ROLES = new Set(Object.values(ROLE));
const MANAGED_STATUSES = new Set([USER_STATUS.ACTIVE, USER_STATUS.BLOCKED]);

export class UserServiceError extends Error {
  constructor(code) {
    super(USER_ERROR_MESSAGES[code] || "Sprava uzivatele se nezdarila.");
    this.name = "UserServiceError";
    this.code = code;
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeProfile(input = {}) {
  const profile = {
    firstName: String(input.firstName || "").trim(),
    lastName: String(input.lastName || "").trim(),
    email: normalizeEmail(input.email),
    sokolUnit: String(input.sokolUnit || "").trim(),
    membershipId: String(input.membershipId || "").trim(),
  };
  if (PROFILE_FIELDS.some((field) => !profile[field])) throw new UserServiceError("INVALID_PROFILE");
  return profile;
}

function publicUser(user) {
  const { demoCredential, passwordHash, passwordSalt, passwordUpdatedAt, ...safeUser } = user;
  return safeUser;
}

export function createUserService({ repository, auth, audit, now }) {
  const statusQueues = new Map();

  function getManagingActor(sessionId) {
    const session = auth.getSession(sessionId);
    assertAuthorized(canManageUsers(session.user), "manage_users");
    return session.user;
  }

  function findUser(userId, state = repository.read()) {
    const user = state.users.find((candidate) => candidate.id === userId);
    if (!user) throw new UserServiceError("USER_NOT_FOUND");
    return user;
  }

  function recordUserChange(actorUserId, action, targetId, metadata) {
    audit.record({ actorUserId, action, targetType: "user", targetId, metadata });
  }

  function assertNotLastActiveSuperadmin(state, user, nextRole, nextStatus) {
    const removesActiveSuperadmin =
      user.role === ROLE.SUPERADMIN &&
      user.status === USER_STATUS.ACTIVE &&
      (nextRole !== ROLE.SUPERADMIN || nextStatus !== USER_STATUS.ACTIVE);
    if (!removesActiveSuperadmin) return;

    const activeSuperadmins = state.users.filter(
      (candidate) =>
        candidate.role === ROLE.SUPERADMIN && candidate.status === USER_STATUS.ACTIVE,
    );
    if (activeSuperadmins.length <= 1) throw new UserServiceError("LAST_ACTIVE_SUPERADMIN");
  }

  function revokeAuthentication(userId) {
    auth.revokeUserSessions(userId);
    auth.revokeUserChallenges(userId);
  }

  function snapshotUserOperation(state, userId) {
    return {
      user: structuredClone(state.users.find((candidate) => candidate.id === userId) || null),
      sessions: structuredClone(state.sessions.filter((session) => session.userId === userId)),
      challenges: structuredClone(
        state.challenges.filter((challenge) => challenge.userId === userId),
      ),
      auditEventCount: state.auditEvents.length,
    };
  }

  function rollbackUserOperation(userId, snapshot) {
    repository.update((draft) => {
      const currentIndex = draft.users.findIndex((candidate) => candidate.id === userId);
      if (snapshot.user) {
        if (currentIndex === -1) draft.users.push(snapshot.user);
        else draft.users[currentIndex] = snapshot.user;
      } else if (currentIndex !== -1) {
        draft.users.splice(currentIndex, 1);
      }
      draft.sessions = [
        ...draft.sessions.filter((session) => session.userId !== userId),
        ...snapshot.sessions,
      ];
      draft.challenges = [
        ...draft.challenges.filter((challenge) => challenge.userId !== userId),
        ...snapshot.challenges,
      ];
      draft.auditEvents = [
        ...draft.auditEvents.slice(0, snapshot.auditEventCount),
        ...draft.auditEvents
          .slice(snapshot.auditEventCount)
          .filter((event) => !(event.targetType === "user" && event.targetId === userId)),
      ];
    });
  }

  function asSetPasswordDelivery(delivery) {
    return { ...delivery, kind: CHALLENGE_TYPE.SET_PASSWORD };
  }

  function listUsers(sessionId, filters = {}) {
    getManagingActor(sessionId);
    const query = String(filters.query || "").trim().toLowerCase();
    return repository
      .read()
      .users.filter((user) => {
        if (filters.role && user.role !== filters.role) return false;
        if (filters.status && user.status !== filters.status) return false;
        if (!query) return true;
        return PROFILE_FIELDS.some((field) => String(user[field] || "").toLowerCase().includes(query));
      })
      .map(publicUser);
  }

  function getUser(sessionId, userId) {
    getManagingActor(sessionId);
    return publicUser(findUser(userId));
  }

  async function createPrivilegedUser(sessionId, input) {
    const actor = getManagingActor(sessionId);
    if (!PRIVILEGED_ROLES.has(input?.role)) throw new UserServiceError("INVALID_ROLE");
    const profile = normalizeProfile(input);
    const state = repository.read();
    if (state.users.some((user) => normalizeEmail(user.email) === profile.email)) {
      throw new UserServiceError("EMAIL_EXISTS");
    }

    const user = {
      id: `user-${now()}-${state.users.length + 1}`,
      ...profile,
      role: input.role,
      status: USER_STATUS.INVITED,
      emailVerifiedAt: null,
      createdAt: now(),
    };
    const operationSnapshot = snapshotUserOperation(state, user.id);
    repository.update((draft) => draft.users.push(user));
    let delivery;
    try {
      delivery = await auth.createPasswordSetup(sessionId, user.id);
    } catch (error) {
      rollbackUserOperation(user.id, operationSnapshot);
      throw error;
    }
    recordUserChange(actor.id, "user.created", user.id, {
      oldRole: null,
      newRole: user.role,
      oldStatus: null,
      newStatus: user.status,
    });
    return asSetPasswordDelivery(delivery);
  }

  async function performSetUserStatus(actor, sessionId, userId, status) {
    const state = repository.read();
    const user = findUser(userId, state);
    const requiresPasswordSetup =
      user.status === USER_STATUS.BLOCKED &&
      status === USER_STATUS.ACTIVE &&
      PRIVILEGED_ROLES.has(user.role) &&
      !user.passwordHash;
    const nextStatus = requiresPasswordSetup
      ? USER_STATUS.INVITED
      : user.role === ROLE.MEMBER && status === USER_STATUS.ACTIVE && !user.emailVerifiedAt
        ? USER_STATUS.PENDING
        : status;
    assertNotLastActiveSuperadmin(state, user, user.role, nextStatus);
    const oldStatus = user.status;
    if (oldStatus === nextStatus) return publicUser(user);
    const operationSnapshot = snapshotUserOperation(state, userId);

    repository.update((draft) => {
      findUser(userId, draft).status = nextStatus;
    });
    if (status === USER_STATUS.BLOCKED) revokeAuthentication(userId);
    let delivery;
    if (requiresPasswordSetup) {
      revokeAuthentication(userId);
      try {
        delivery = await auth.createPasswordSetup(sessionId, userId);
      } catch (error) {
        rollbackUserOperation(userId, operationSnapshot);
        throw error;
      }
    }
    recordUserChange(actor.id, "user.status_changed", userId, { oldStatus, newStatus: nextStatus });
    if (requiresPasswordSetup) return asSetPasswordDelivery(delivery);
    return publicUser(findUser(userId));
  }

  async function setUserStatus(sessionId, userId, status) {
    const actor = getManagingActor(sessionId);
    if (!MANAGED_STATUSES.has(status)) throw new UserServiceError("INVALID_STATUS");

    let queue = statusQueues.get(userId);
    if (!queue) {
      queue = { tail: Promise.resolve(), lastStatus: null, lastOperation: null };
      statusQueues.set(userId, queue);
    }
    if (queue.lastStatus === status && queue.lastOperation) return queue.lastOperation;

    const operation = queue.tail.then(() =>
      performSetUserStatus(actor, sessionId, userId, status),
    );
    queue.lastStatus = status;
    queue.lastOperation = operation;
    queue.tail = operation.catch(() => undefined);
    void operation.finally(() => {
      if (queue.lastOperation === operation && statusQueues.get(userId) === queue) {
        statusQueues.delete(userId);
      }
    }).catch(() => undefined);
    return operation;
  }

  async function changeUserRole(sessionId, userId, role, transferNormsToUserId) {
    const actor = getManagingActor(sessionId);
    if (!USER_ROLES.has(role)) throw new UserServiceError("INVALID_ROLE");
    const state = repository.read();
    const user = findUser(userId, state);
    if (user.role === role) return publicUser(user);
    assertNotLastActiveSuperadmin(state, user, role, user.status);

    const oldRole = user.role;
    const oldStatus = user.status;
    const demotingToMember = PRIVILEGED_ROLES.has(oldRole) && role === ROLE.MEMBER;
    const promotingMember = oldRole === ROLE.MEMBER && PRIVILEGED_ROLES.has(role);
    const rotatingInvitedPrivilegedRole =
      oldStatus === USER_STATUS.INVITED &&
      PRIVILEGED_ROLES.has(oldRole) &&
      PRIVILEGED_ROLES.has(role);
    const requiresPasswordSetup = promotingMember || rotatingInvitedPrivilegedRole;
    const newStatus = promotingMember
      ? USER_STATUS.INVITED
      : demotingToMember
        ? user.emailVerifiedAt
          ? USER_STATUS.ACTIVE
          : USER_STATUS.PENDING
        : oldStatus;
    const ownedNorms = demotingToMember
      ? state.norms.filter((norm) => norm.ownerAdminId === userId)
      : [];
    let transferTarget;
    if (ownedNorms.length > 0) {
      if (!transferNormsToUserId) throw new UserServiceError("TRANSFER_REQUIRED");
      transferTarget = state.users.find((candidate) => candidate.id === transferNormsToUserId);
      if (
        !transferTarget ||
        transferTarget.id === userId ||
        transferTarget.status !== USER_STATUS.ACTIVE ||
        !PRIVILEGED_ROLES.has(transferTarget.role)
      ) {
        throw new UserServiceError("INVALID_TRANSFER_TARGET");
      }
    }

    const operationSnapshot = snapshotUserOperation(state, userId);

    repository.update((draft) => {
      const current = findUser(userId, draft);
      current.role = role;
      if (promotingMember) current.status = USER_STATUS.INVITED;
      if (demotingToMember) {
        current.status = current.emailVerifiedAt ? USER_STATUS.ACTIVE : USER_STATUS.PENDING;
        delete current.passwordHash;
        delete current.passwordSalt;
        delete current.passwordUpdatedAt;
        for (const norm of draft.norms) {
          if (norm.ownerAdminId === userId) norm.ownerAdminId = transferTarget.id;
        }
      }
    });

    revokeAuthentication(userId);
    let delivery;
    if (requiresPasswordSetup) {
      try {
        delivery = await auth.createPasswordSetup(sessionId, userId);
      } catch (error) {
        rollbackUserOperation(userId, operationSnapshot);
        throw error;
      }
    }
    recordUserChange(actor.id, "user.role_changed", userId, { oldRole, newRole: role });
    if (oldStatus !== newStatus) {
      recordUserChange(actor.id, "user.status_changed", userId, { oldStatus, newStatus });
    }
    for (const norm of ownedNorms) {
      audit.record({
        actorUserId: actor.id,
        action: "norm.ownership_transferred",
        targetType: "norm",
        targetId: norm.id,
        metadata: {
          oldOwnerAdminId: userId,
          newOwnerAdminId: transferTarget.id,
        },
      });
    }

    if (requiresPasswordSetup) return asSetPasswordDelivery(delivery);
    return publicUser(findUser(userId));
  }

  return {
    listUsers,
    getUser,
    createPrivilegedUser,
    setUserStatus,
    changeUserRole,
  };
}

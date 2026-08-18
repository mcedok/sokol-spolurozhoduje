import { ROLE, USER_STATUS } from "../domain/constants.js";

const AUTHORIZATION_MESSAGES = {
  participate: "Pro tuto akci nemáte oprávnění.",
  create_norm: "Nemáte oprávnění vytvářet normy.",
  manage_norm: "Nemáte oprávnění spravovat tuto normu.",
  manage_users: "Nemáte oprávnění spravovat uživatele.",
};

export class AuthorizationError extends Error {
  constructor(code) {
    super(AUTHORIZATION_MESSAGES[code] || "Nemáte pro tuto akci oprávnění.");
    this.name = "AuthorizationError";
    this.code = code;
  }
}

function isActive(user) {
  return user?.status === USER_STATUS.ACTIVE;
}

export function canParticipate(user) {
  return isActive(user) && Boolean(user.emailVerifiedAt);
}

export function canManageUsers(user) {
  return isActive(user) && user.role === ROLE.SUPERADMIN;
}

export function canCreateNorm(user) {
  return isActive(user) && [ROLE.ADMIN, ROLE.SUPERADMIN].includes(user.role);
}

export function canManageNorm(user, norm) {
  if (!isActive(user)) return false;
  if (user.role === ROLE.SUPERADMIN) return true;
  return user.role === ROLE.ADMIN && user.id === norm?.ownerAdminId;
}

export function assertAuthorized(condition, code) {
  if (!condition) throw new AuthorizationError(code);
}

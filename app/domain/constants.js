export const ROLE = { MEMBER: "member", ADMIN: "admin", SUPERADMIN: "superadmin" };

export const USER_STATUS = {
  INVITED: "invited",
  PENDING: "pending_verification",
  ACTIVE: "active",
  BLOCKED: "blocked",
};

export const CHALLENGE_TYPE = {
  MEMBER_CODE: "member_code",
  SET_PASSWORD: "set_password",
  RESET_PASSWORD: "reset_password",
};

export const LIMITS = {
  memberCodeMs: 10 * 60 * 1000,
  passwordLinkMs: 30 * 60 * 1000,
  sessionMs: 8 * 60 * 60 * 1000,
  maxCodeAttempts: 5,
};

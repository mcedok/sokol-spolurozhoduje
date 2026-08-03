import { describe, expect, it } from "vitest";
import {
  assertAuthorized,
  canCreateNorm,
  canManageNorm,
  canManageUsers,
  canParticipate,
} from "../app/security/access-control.js";
import { ROLE, USER_STATUS } from "../app/domain/constants.js";

const activeMember = {
  id: "member-active",
  role: ROLE.MEMBER,
  status: USER_STATUS.ACTIVE,
  emailVerifiedAt: "2026-08-03T00:00:00.000Z",
};

const blockedMember = { ...activeMember, id: "member-blocked", status: USER_STATUS.BLOCKED };
const adminA = { ...activeMember, id: "admin-a", role: ROLE.ADMIN };
const adminB = { ...activeMember, id: "admin-b", role: ROLE.ADMIN };
const superadmin = { ...activeMember, id: "superadmin", role: ROLE.SUPERADMIN };

describe("access control", () => {
  it("applies the participation and management permission matrix", () => {
    expect(canParticipate(undefined)).toBe(false);
    expect(canParticipate(activeMember)).toBe(true);
    expect(canParticipate(blockedMember)).toBe(false);
    expect(canCreateNorm(adminA)).toBe(true);
    expect(canCreateNorm(superadmin)).toBe(true);
    expect(canManageNorm(adminA, { ownerAdminId: adminA.id })).toBe(true);
    expect(canManageNorm(adminA, { ownerAdminId: adminB.id })).toBe(false);
    expect(canManageNorm(superadmin, { ownerAdminId: adminB.id })).toBe(true);
    expect(canManageUsers(adminA)).toBe(false);
    expect(canManageUsers(superadmin)).toBe(true);
  });

  it("rejects denied actions with a Czech authorization error", () => {
    expect(() => assertAuthorized(false, "manage_users")).toThrow("Nemáte oprávnění spravovat uživatele.");
    expect(() => assertAuthorized(true, "manage_users")).not.toThrow();
  });
});

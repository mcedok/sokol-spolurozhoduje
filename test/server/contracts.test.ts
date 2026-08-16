import { describe, expect, it } from "vitest";
import {
  appSnapshotSchema,
  documentAdminViewSchema,
  roleSchema,
  userStatusSchema,
} from "../../contracts/index";

describe("authoritative server contracts", () => {
  it("accepts approved access values and rejects unknown privileges", () => {
    expect(roleSchema.parse("member")).toBe("member");
    expect(roleSchema.parse("admin")).toBe("admin");
    expect(roleSchema.parse("superadmin")).toBe("superadmin");
    expect(roleSchema.safeParse("document_owner").success).toBe(false);
    expect(userStatusSchema.parse("pending_verification")).toBe("pending_verification");
    expect(userStatusSchema.safeParse("approved").success).toBe(false);
  });

  it("requires owner and row version on every administrative document view", () => {
    expect(() =>
      documentAdminViewSchema.parse({ publicId: "SOKOL-2026-001", title: "Norma" }),
    ).toThrow();
  });

  it("never exposes private member fields in the public snapshot shape", () => {
    const snapshot = appSnapshotSchema.parse({
      viewer: null,
      documents: [],
      managedDocuments: [],
      organizations: [],
      capabilities: { manageUsers: false, createDocument: false },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /"(email|membershipId|passwordHash)"\s*:/i,
    );
  });
});

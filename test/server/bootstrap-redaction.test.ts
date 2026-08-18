import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../contracts";
import { buildBootstrapSnapshot } from "../../server/bootstrap-service";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  seedActiveMember,
  seedOrganization,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

function expectPublicRedaction(snapshot: unknown) {
  expect(JSON.stringify(snapshot)).not.toMatch(
    /"(email|membershipId|ownerAdminId|rowVersion|passwordHash|tokenHash)"\s*:/i,
  );
}

describe("bootstrap privacy boundary", () => {
  it("redacts anonymous and member snapshots while scoping administrative data", async () => {
    await seedOrganization({ code: "PUBLIC", name: "TJ Sokol Veřejná" });
    const owner = await seedActiveAdmin();
    const other = await seedActiveAdmin();
    const member = await seedActiveMember();
    await testSql`
      insert into documents (
        number, title, explanatory_report, owner_admin_id, status, visibility_mode
      ) values
        ('SOKOL-2026-101', 'Veřejná norma', 'Důvod', ${owner.id}, 'published_open', 'public_detail'),
        ('SOKOL-2026-102', 'Členská norma', 'Důvod', ${other.id}, 'published_open', 'login_required_detail')
    `;

    const anonymous = await buildBootstrapSnapshot(testSql, null);
    expectPublicRedaction(anonymous);
    expect(anonymous.managedDocuments).toEqual([]);
    expect(anonymous.documents.map((item) => item.title)).toEqual(["Veřejná norma"]);

    const memberActor: Actor = {
      userId: member.id,
      role: "member",
      sessionId: crypto.randomUUID(),
    };
    const memberSnapshot = await buildBootstrapSnapshot(testSql, memberActor);
    expectPublicRedaction(memberSnapshot);
    expect(memberSnapshot.managedDocuments).toEqual([]);
    expect(memberSnapshot.documents.map((item) => item.title)).toHaveLength(2);
    expect(memberSnapshot.documents.map((item) => item.title)).toEqual(
      expect.arrayContaining(["Členská norma", "Veřejná norma"]),
    );

    const adminSnapshot = await buildBootstrapSnapshot(testSql, {
      userId: owner.id,
      role: "admin",
      sessionId: crypto.randomUUID(),
    });
    expect(adminSnapshot.managedDocuments).toHaveLength(1);
    expect(adminSnapshot.managedDocuments[0].ownerAdminId).toBe(owner.id);

    const superadmin = await seedActiveAdmin({ role: "superadmin" });
    const superSnapshot = await buildBootstrapSnapshot(testSql, {
      userId: superadmin.id,
      role: "superadmin",
      sessionId: crypto.randomUUID(),
    });
    expect(superSnapshot.managedDocuments).toHaveLength(2);
  });
});

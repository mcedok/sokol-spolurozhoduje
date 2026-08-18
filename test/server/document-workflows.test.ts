import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor, DocumentStatus } from "../../contracts";
import { createDocumentService } from "../../server/modules/documents/document-service";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  seedActiveMember,
  testSql,
} from "./db-test-context";

const documents = createDocumentService({ sql: testSql });

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

async function adminActor(role: "admin" | "superadmin" = "admin") {
  const user = await seedActiveAdmin({ role });
  return {
    user,
    actor: { userId: user.id, role, sessionId: crypto.randomUUID() } satisfies Actor,
  };
}

const createInput = (title: string, fourEyesRequired = false) => ({
  title,
  explanatoryReport: "Důvodová zpráva",
  visibilityMode: "public_detail" as const,
  fourEyesRequired,
  idempotencyKey: crypto.randomUUID(),
});

describe("document workflows", () => {
  it("allocates unique sequential numbers under concurrent creation", async () => {
    const { actor } = await adminActor();
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        documents.createDocument(actor, createInput(`Norma ${index}`)),
      ),
    );
    expect(new Set(created.map((item) => item.publicId)).size).toBe(10);
    expect(created.map((item) => item.publicId).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `SOKOL-2026-${String(index + 1).padStart(3, "0")}`),
    );
  });

  it("prevents an admin from changing another admin's document", async () => {
    const owner = await adminActor();
    const other = await adminActor();
    const owned = await documents.createDocument(owner.actor, createInput("Vlastní norma"));
    await expect(
      documents.updateDocument(other.actor, owned.id, {
        title: "Cizí změna",
        explanatoryReport: owned.explanatoryReport,
        visibilityMode: owned.visibilityMode,
        fourEyesRequired: owned.fourEyesRequired,
        rowVersion: owned.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows only superadmin to transfer ownership", async () => {
    const owner = await adminActor();
    const other = await adminActor();
    const owned = await documents.createDocument(owner.actor, createInput("Norma"));
    await expect(
      documents.transferOwnership(owner.actor, owned.id, other.user.id, {
        rowVersion: owned.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("anonymous list shows only published public-detail documents", async () => {
    const { actor } = await adminActor();
    const published = await documents.createDocument(actor, createInput("Veřejná"));
    const concept = await documents.createDocument(actor, createInput("Koncept"));
    const privateDetail = await documents.createDocument(actor, {
      ...createInput("Po přihlášení"),
      visibilityMode: "login_required_detail",
    });
    await testSql`
      update documents set status = 'published_open', comments_open = true
      where id in (${published.id}, ${privateDetail.id})
    `;
    const visible = await documents.listVisibleDocuments(null);
    expect(visible.map((item) => item.title)).toEqual(["Veřejná"]);
    expect(JSON.stringify(visible)).not.toMatch(/ownerAdminId|rowVersion/);
    expect(concept.status).toBe("concept");
  });

  it("verified member can read login-required detail", async () => {
    const { actor } = await adminActor();
    const member = await seedActiveMember();
    const detail = await documents.createDocument(actor, {
      ...createInput("Členská norma"),
      visibilityMode: "login_required_detail",
    });
    await testSql`update documents set status = 'published_open' where id = ${detail.id}`;
    const visible = await documents.listVisibleDocuments({
      userId: member.id,
      role: "member",
      sessionId: crypto.randomUUID(),
    });
    expect(visible.map((item) => item.title)).toContain("Členská norma");
    expect(JSON.stringify(visible)).not.toMatch(/ownerAdminId|rowVersion/);
  });

  it("stale document update is rejected", async () => {
    const { actor } = await adminActor();
    const owned = await documents.createDocument(actor, createInput("Původní"));
    await expect(
      documents.updateDocument(actor, owned.id, {
        title: "Nový název",
        explanatoryReport: owned.explanatoryReport,
        visibilityMode: owned.visibilityMode,
        fourEyesRequired: false,
        rowVersion: 999,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect((await testSql`select title from documents where id = ${owned.id}`)[0].title).toBe("Původní");
  });

  it("closing comments requires a reason", async () => {
    const { actor } = await adminActor();
    const owned = await documents.createDocument(actor, createInput("Norma"));
    await testSql`
      update documents set status = 'published_open', comments_open = true where id = ${owned.id}
    `;
    await expect(
      documents.changeDocumentStatus(actor, owned.id, "comments_closed", "  ", {
        rowVersion: owned.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CLOSURE_REASON_REQUIRED" });
  });

  it("approved and rejected only transition to archived", async () => {
    const { actor } = await adminActor();
    for (const source of ["approved", "rejected"] as const) {
      const owned = await documents.createDocument(actor, createInput(source));
      await testSql`update documents set status = ${source} where id = ${owned.id}`;
      for (const target of ["concept", "published_open"] as DocumentStatus[]) {
        await expect(
          documents.changeDocumentStatus(actor, owned.id, target, "", {
            rowVersion: owned.rowVersion,
            idempotencyKey: crypto.randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
      }
      await expect(
        documents.changeDocumentStatus(actor, owned.id, "archived", "", {
          rowVersion: owned.rowVersion,
          idempotencyKey: crypto.randomUUID(),
        }),
      ).resolves.toMatchObject({ status: "archived" });
    }
  });

  it("four-eyes publish creates pending approval", async () => {
    const { actor } = await adminActor();
    const owned = await documents.createDocument(actor, createInput("Čtyři oči", true));
    await testSql`update documents set status = 'ready' where id = ${owned.id}`;
    const unchanged = await documents.changeDocumentStatus(
      actor,
      owned.id,
      "published_open",
      "Připraveno",
      { rowVersion: owned.rowVersion, idempotencyKey: crypto.randomUUID() },
    );
    expect(unchanged.status).toBe("ready");
    const approvals = await testSql`
      select * from document_approvals where document_id = ${owned.id} and decision is null
    `;
    expect(approvals).toHaveLength(1);
  });

  it("superadmin approval applies requested state once", async () => {
    const owner = await adminActor();
    const supervisor = await adminActor("superadmin");
    const owned = await documents.createDocument(owner.actor, createInput("Schválení", true));
    await testSql`update documents set status = 'ready' where id = ${owned.id}`;
    await documents.changeDocumentStatus(owner.actor, owned.id, "published_open", "Ke schválení", {
      rowVersion: owned.rowVersion,
      idempotencyKey: crypto.randomUUID(),
    });
    const [approval] = await testSql<{ id: string }[]>`
      select id from document_approvals where document_id = ${owned.id}
    `;
    const applied = await documents.decideApproval(
      supervisor.actor,
      approval.id,
      "approved",
      "Schvaluji",
    );
    expect(applied.status).toBe("published_open");
    await expect(
      documents.decideApproval(supervisor.actor, approval.id, "approved", "Schvaluji"),
    ).resolves.toEqual(applied);
    expect(await testSql`select * from document_state_transitions where document_id = ${owned.id}`).toHaveLength(1);
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendDeniedAudit } from "../../server/modules/audit/audit-writer";
import { appendOutbox } from "../../server/modules/outbox/outbox-writer";
import { executeCommand } from "../../server/modules/shared/command-context";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

describe("transactional audit", () => {
  it("rolls back domain data and audit when the command fails", async () => {
    const actor = await seedActiveAdmin();

    await expect(
      executeCommand(
        testSql,
        {
          actor: { userId: actor.id, role: "admin", sessionId: crypto.randomUUID() },
          action: "document.create",
          targetType: "document",
          correlationId: crypto.randomUUID(),
        },
        async (tx) => {
          await appendOutbox(tx, {
            eventType: "document.created",
            aggregateType: "document",
            aggregateId: crypto.randomUUID(),
            payload: {},
            idempotencyKey: crypto.randomUUID(),
          });
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect(await testSql`select * from outbox_events`).toHaveLength(0);
    expect(await testSql`select * from audit_events`).toHaveLength(0);
  });

  it("redacts nested secrets from audit metadata", async () => {
    const actor = await seedActiveAdmin();
    await executeCommand(
      testSql,
      {
        actor: { userId: actor.id, role: "admin", sessionId: crypto.randomUUID() },
        action: "auth.changed",
        targetType: "user",
        targetId: actor.id,
        correlationId: crypto.randomUUID(),
        metadata: {
          email: "a@sokol.cz",
          password: "secret",
          nested: { authorizationHeader: "Bearer secret", harmless: "kept" },
        },
      },
      async () => undefined,
    );

    const [event] = await testSql<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events
    `;
    expect(event.metadata).toEqual({
      email: "a@sokol.cz",
      nested: { authorizationHeader: "[REDACTED]", harmless: "kept" },
      password: "[REDACTED]",
    });
  });

  it("records denied authorization without a domain mutation", async () => {
    const actor = await seedActiveAdmin();
    await appendDeniedAudit(testSql, {
      actor: { userId: actor.id, role: "admin", sessionId: crypto.randomUUID() },
      action: "document.update",
      targetType: "document",
      targetId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      metadata: { reason: "not_owner", code: "do-not-store" },
    });

    const [event] = await testSql<
      { outcome: string; metadata: Record<string, unknown> }[]
    >`select outcome, metadata from audit_events`;
    expect(event).toEqual({
      outcome: "denied",
      metadata: { code: "[REDACTED]", reason: "not_owner" },
    });
  });
});

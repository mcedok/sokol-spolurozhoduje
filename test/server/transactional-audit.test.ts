import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, appendDeniedAudit } from "../../server/modules/audit/audit-writer";
import { withTransaction } from "../../server/db/client";
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

  it("keeps one linear hash chain for multiple events in the same transaction", async () => {
    const actor = await seedActiveAdmin();
    const firstAction = "xlsx_import.row_classified";
    const secondAction = "xlsx_import.row_applied";
    await withTransaction(testSql, async (tx) => {
      await tx`
        insert into audit_events (
          id, actor_user_id, actor_role, action, target_type, outcome,
          correlation_id, metadata, event_hash
        ) values (
          'ffffffff-ffff-ffff-ffff-ffffffffffff', ${actor.id}, 'admin', 'seed',
          'test', 'allowed', ${crypto.randomUUID()}, '{}', ${"f".repeat(64)}
        )
      `;
      const auditActor = { userId: actor.id, role: "admin" as const, sessionId: crypto.randomUUID() };
      await appendAudit(tx, {
        actor: auditActor, action: firstAction, targetType: "comment",
        targetId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
      }, "allowed");
      await appendAudit(tx, {
        actor: auditActor, action: secondAction, targetType: "comment",
        targetId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
      }, "allowed");
    });

    const events = await testSql<{ action: string; previous_hash: string | null; event_hash: string }[]>`
      select action, previous_hash, event_hash from audit_events
      where action in (${firstAction}, ${secondAction}) order by created_at, id
    `;
    const classified = events.find((event) => event.action === firstAction)!;
    const applied = events.find((event) => event.action === secondAction)!;
    expect(applied.previous_hash).toBe(classified.event_hash);
    await expect(testSql`
      update audit_events set action='tampered' where event_hash=${applied.event_hash}
    `).rejects.toMatchObject({ code: "P0001" });
  });
});

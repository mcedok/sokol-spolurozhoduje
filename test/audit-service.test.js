import { describe, expect, it } from "vitest";
import { createAuditService } from "../app/services/audit-service.js";
import { createBrowserRepository } from "../app/data/browser-repository.js";
import { createMemoryStorage } from "./fakes.js";

describe("audit service", () => {
  it("records a target event without credentials in nested metadata", () => {
    const repository = createBrowserRepository({ storage: createMemoryStorage() });
    const audit = createAuditService(repository, () => "2026-08-03T12:00:00.000Z");

    audit.record({
      actorUserId: "admin-a",
      action: "user.updated",
      targetType: "user",
      targetId: "member-a",
      metadata: {
        displayName: "Člen A",
        password: "secret",
        code: "123456",
        nested: {
          token: "session-token",
          sessionId: "live-bearer-session",
          ResetToken: "mixed-case-token",
          passwordHash: "hash",
          passwordSalt: "salt",
          retained: "safe value",
        },
      },
    });

    expect(audit.listForTarget("user", "member-a")).toEqual([
      {
        actorUserId: "admin-a",
        action: "user.updated",
        targetType: "user",
        targetId: "member-a",
        metadata: { displayName: "Člen A", nested: { retained: "safe value" } },
        createdAt: "2026-08-03T12:00:00.000Z",
      },
    ]);
    expect(audit.listForTarget("user", "other-member")).toEqual([]);
  });
});

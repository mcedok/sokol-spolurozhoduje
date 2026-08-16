import { describe, expect, it, vi } from "vitest";
import { createServerApiClient } from "../../app/data/server-api-client.js";
import { createDataServices } from "../../app/data/create-data-services.js";

describe("server API client", () => {
  it("sends cookies, CSRF and optimistic concurrency headers", async () => {
    const updated = { id: crypto.randomUUID(), title: "Nový název" };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ document: updated }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createServerApiClient({ fetchImpl, csrfToken: () => "csrf" });
    const idempotencyKey = crypto.randomUUID();
    await client.normService.update("ignored-cookie-session", updated.id, {
      title: "Nový název",
      rowVersion: 3,
      idempotencyKey,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/documents/${updated.id}`,
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        headers: expect.objectContaining({
          "if-match": "3",
          "x-csrf-token": "csrf",
        }),
      }),
    );
  });

  it("selects browser data only when explicitly configured and rejects it in production", () => {
    const browserFactory = vi.fn(() => ({ backend: "browser" }));
    const serverFactory = vi.fn(() => ({ backend: "server" }));
    expect(
      createDataServices({
        env: { NEXT_PUBLIC_DATA_BACKEND: "browser", NODE_ENV: "development" },
        browserFactory,
        serverFactory,
      }),
    ).toEqual({ backend: "browser" });
    expect(() =>
      createDataServices({
        env: { NEXT_PUBLIC_DATA_BACKEND: "browser", NODE_ENV: "production" },
        browserFactory,
        serverFactory,
      }),
    ).toThrow(/production/i);
  });
});

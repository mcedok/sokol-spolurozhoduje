import { beforeEach, describe, expect, it, vi } from "vitest";

const { actor, currentActor, actorForMutation, versioning } = vi.hoisted(() => {
  const actor = {
    userId: "0198f413-2a36-7000-8000-000000000101",
    role: "admin" as const,
    sessionId: "0198f413-2a36-7000-8000-000000000102",
  };
  return {
    actor,
    currentActor: vi.fn().mockResolvedValue(actor),
    actorForMutation: vi.fn().mockResolvedValue(actor),
    versioning: {
      getMappings: vi.fn(),
      generateMappingsFromPreviousVersion: vi.fn(),
      decideMapping: vi.fn(),
    },
  };
});

vi.mock("../../server/http/route-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/http/route-utils")>(),
  currentActor,
}));

vi.mock("../../server/http/user-route-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/http/user-route-utils")>(),
  actorForMutation,
}));

vi.mock("../../server/runtime", () => ({
  getIdentityRuntime: () => ({ versioning }),
}));

const versionId = "0198f413-2a36-7000-8000-000000000110";
const mappingId = "0198f413-2a36-7000-8000-000000000111";
const key = "0198f413-2a36-7000-8000-000000000112";

async function loadRoutes() {
  const mappingListPath = "../../app/api/document-versions/[versionId]/mappings/route";
  const decisionPath = "../../app/api/block-mappings/[mappingId]/decision/route";
  const [mappingList, decision] = await Promise.all([
    import(mappingListPath),
    import(decisionPath),
  ]);
  return {
    getMappings: mappingList.GET as (
      request: Request,
      context: { params: Promise<{ versionId: string }> },
    ) => Promise<Response>,
    generateMappings: mappingList.POST as (
      request: Request,
      context: { params: Promise<{ versionId: string }> },
    ) => Promise<Response>,
    decideMapping: decision.PUT as (
      request: Request,
      context: { params: Promise<{ mappingId: string }> },
    ) => Promise<Response>,
  };
}

describe("version mapping routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an owned mapping review with no-store caching", async () => {
    const routes = await loadRoutes();
    versioning.getMappings.mockResolvedValue({
      id: crypto.randomUUID(),
      targetVersionId: versionId,
      status: "review_required",
      mappings: [],
    });

    const response = await routes.getMappings(
      new Request(`http://localhost/api/document-versions/${versionId}/mappings`),
      { params: Promise.resolve({ versionId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(versioning.getMappings).toHaveBeenCalledWith(actor, versionId, expect.any(String));
  });

  it("passes CSRF, concurrency and idempotency data to a mapping decision", async () => {
    const routes = await loadRoutes();
    versioning.decideMapping.mockResolvedValue({ id: crypto.randomUUID(), status: "confirmed" });
    const request = new Request(
      `http://localhost/api/block-mappings/${mappingId}/decision`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": key,
          "if-match": 'W/"7"',
        },
        body: JSON.stringify({
          decision: "confirm",
          reason: "Ověřeno proti oběma verzím.",
        }),
      },
    );

    const response = await routes.decideMapping(request, {
      params: Promise.resolve({ mappingId }),
    });

    expect(response.status).toBe(200);
    expect(versioning.decideMapping).toHaveBeenCalledWith(
      actor,
      mappingId,
      {
        decision: "confirm",
        reason: "Ověřeno proti oběma verzím.",
        rowVersion: 7,
        idempotencyKey: key,
      },
      expect.any(String),
    );
  });

  it("starts mapping against the previous ready version as an idempotent mutation", async () => {
    const routes = await loadRoutes();
    versioning.generateMappingsFromPreviousVersion.mockResolvedValue({
      id: crypto.randomUUID(),
      targetVersionId: versionId,
      status: "review_required",
      mappings: [],
    });
    const request = new Request(
      `http://localhost/api/document-versions/${versionId}/mappings`,
      {
        method: "POST",
        headers: {
          "x-csrf-token": "csrf",
          "idempotency-key": key,
        },
      },
    );

    const response = await routes.generateMappings(request, {
      params: Promise.resolve({ versionId }),
    });

    expect(response.status).toBe(200);
    expect(versioning.generateMappingsFromPreviousVersion).toHaveBeenCalledWith(
      actor,
      versionId,
      key,
      expect.any(String),
    );
  });
});

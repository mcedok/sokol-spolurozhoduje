import { beforeAll, expect, it } from "vitest";
import { GET as live } from "../../app/api/health/live/route";
import { GET as ready } from "../../app/api/health/ready/route";
import { migrateTestDatabase } from "./db-test-context";

beforeAll(migrateTestDatabase);

it("reports liveness without exposing configuration", async () => {
  const response = await live();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("reports readiness after a bounded database probe", async () => {
  process.env.DATABASE_URL ??=
    "postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test";
  const response = await ready();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ready" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

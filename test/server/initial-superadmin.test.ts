import { beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretService } from "../../server/modules/identity/secret-service";
import {
  bootstrapInitialSuperadmin,
  persistSetupToken,
  withProtectedSetupTokenFile,
} from "../../server/db/bootstrap-superadmin";
import {
  migrateTestDatabase,
  resetTestDatabase,
  testSql,
} from "./db-test-context";

const secrets = createSecretService({
  sessionHmacKey: "bootstrap-session-key-".repeat(2),
  otpHmacKey: "bootstrap-otp-key-".repeat(3),
  csrfHmacKey: "bootstrap-csrf-key-".repeat(3),
});

it("writes the bearer token only to an explicitly protected file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sokol-bootstrap-"));
  const target = join(directory, "setup-token.txt");
  try {
    await persistSetupToken(target, "secret-bearer-value");
    expect(await readFile(target, "utf8")).toBe("secret-bearer-value\n");
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
    await expect(persistSetupToken(target, "replacement")).rejects.toMatchObject({ code: "EEXIST" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

it("creates exactly one invited initial superadmin and a single-use setup token", async () => {
  const created = await bootstrapInitialSuperadmin(testSql, secrets, {
    email: "prvni@example.cz",
    firstName: "První",
    lastName: "Správce",
    organizationCode: "USTREDI",
    organizationName: "Česká obec sokolská",
  });
  expect(created.setupToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(await testSql`select role, status from users`).toEqual([
    { role: "superadmin", status: "invited" },
  ]);
  expect(await testSql`select kind from login_challenges`).toEqual([
    { kind: "set_password" },
  ]);
  expect(await testSql`select * from outbox_events`).toHaveLength(0);
  await expect(bootstrapInitialSuperadmin(testSql, secrets, {
    email: "druhy@example.cz",
    firstName: "Druhý",
    lastName: "Správce",
    organizationCode: "USTREDI",
    organizationName: "Česká obec sokolská",
  })).rejects.toThrow(/already exists/i);
});

it("removes an orphan token file when database bootstrap fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sokol-bootstrap-failure-"));
  const target = join(directory, "setup-token.txt");
  try {
    await expect(withProtectedSetupTokenFile(target, "orphan-secret", async () => {
      throw new Error("commit failed");
    })).rejects.toThrow("commit failed");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

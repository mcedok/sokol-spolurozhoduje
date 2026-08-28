import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLocalPilotDatabase,
  formatPilotMailbox,
  initializePilotEnvironment,
  prepareStandaloneAssets,
  resolveProcessCommand,
  startPilot,
  stopPilot,
  validatePilotEnvironment,
} from "../scripts/local-pilot.mjs";

const temporaryDirectories = [];

async function temporaryProject() {
  const root = await mkdtemp(join(tmpdir(), "sokol-local-pilot-"));
  temporaryDirectories.push(root);
  await writeFile(join(root, ".env.example"), [
    "DATABASE_URL=postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test",
    "SESSION_HMAC_KEY=replace-with-at-least-32-random-bytes",
    "OTP_HMAC_KEY=replace-with-at-least-32-random-bytes",
    "CSRF_HMAC_KEY=replace-with-at-least-32-random-bytes",
    "TOTP_ENCRYPTION_KEY=replace-with-exactly-32-random-bytes",
    "XLSX_MANIFEST_SECRET=replace-with-at-least-32-random-bytes",
    "WORKER_CALLBACK_SECRET=replace-with-an-independent-random-secret",
    "FIRST_ADMIN_TOKEN_FILE=./first-admin-token.txt",
    "",
  ].join("\n"));
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("local pilot environment", () => {
  it("creates independent secrets and preserves them on repeated initialization", async () => {
    const root = await temporaryProject();

    const first = await initializePilotEnvironment(root);
    const firstContents = await readFile(join(root, ".env.local"), "utf8");
    const second = await initializePilotEnvironment(root);
    const secondContents = await readFile(join(root, ".env.local"), "utf8");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(secondContents).toBe(firstContents);
    expect(firstContents).not.toContain("replace-with-");
    const secrets = [
      "SESSION_HMAC_KEY",
      "OTP_HMAC_KEY",
      "CSRF_HMAC_KEY",
      "TOTP_ENCRYPTION_KEY",
      "XLSX_MANIFEST_SECRET",
      "WORKER_CALLBACK_SECRET",
    ].map((name) => first.values.get(name));
    expect(secrets.every((value) => typeof value === "string" && value.length >= 32)).toBe(true);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(first.values.get("TOTP_ENCRYPTION_KEY")).toHaveLength(32);
    expect(first.values.get("FIRST_ADMIN_TOKEN_FILE")).toBe("./.pilot/first-admin-token.txt");
    expect(first.values.get("DATABASE_URL"))
      .toBe("postgres://sokol:local-only-password@127.0.0.1:55433/sokol_pilot");
    expect(first.values.get("COMPOSE_PROJECT_NAME")).toBe("sokol-spolurozhoduje-pilot");
    expect(first.values.get("POSTGRES_DB")).toBe("sokol_pilot");
    expect(first.values.get("POSTGRES_BIND_PORT")).toBe("55433");
    expect(first.values.get("AZURITE_BIND_PORT")).toBe("10001");
    expect(first.values.get("CLAMAV_BIND_PORT")).toBe("3311");
    expect(first.values.get("AZURE_BLOB_ENDPOINT"))
      .toBe("http://127.0.0.1:10001/devstoreaccount1");
    expect(first.values.get("CLAMAV_PORT")).toBe("3311");
  });

  it("never overwrites an existing local environment", async () => {
    const root = await temporaryProject();
    await writeFile(join(root, ".env.local"), "CUSTOM=value\n", "utf8");

    const result = await initializePilotEnvironment(root);

    expect(result.created).toBe(false);
    expect(await readFile(join(root, ".env.local"), "utf8")).toBe("CUSTOM=value\n");
  });

  it("rejects placeholder or missing secrets before starting services", () => {
    const incomplete = new Map([
      ["DATABASE_URL", "postgres://sokol:local-only-password@127.0.0.1:55433/sokol_pilot"],
      ["SESSION_HMAC_KEY", "replace-with-at-least-32-random-bytes"],
    ]);

    expect(() => validatePilotEnvironment(incomplete)).toThrow(/SESSION_HMAC_KEY/);
  });

  it.each([
    "postgres://sokol:password@db.internal:5432/sokol_pilot",
    "postgres://sokol:password@127.0.0.1:55432/sokol_test",
    "postgres://sokol:password@localhost:55433/production",
  ])("rejects a database outside the disposable local pilot boundary: %s", (url) => {
    expect(() => assertLocalPilotDatabase(url)).toThrow(/local database sokol_pilot/i);
  });

  it("accepts the explicit local pilot database", () => {
    expect(() => assertLocalPilotDatabase(
      "postgres://sokol:password@127.0.0.1:55433/sokol_pilot",
    )).not.toThrow();
  });

  it("starts dependencies and the conversion worker with the generated environment", async () => {
    const root = await temporaryProject();
    const commands = [];
    const lifecycle = [];

    const result = await startPilot(root, {
      run: async (command, args) => commands.push([command, ...args]),
      ensureSuperadmin: async () => lifecycle.push("admin"),
      startServer: async () => lifecycle.push("server"),
      waitForReadiness: async () => lifecycle.push("ready"),
    });

    expect(result.status).toBe("ready");
    expect(commands).toEqual([
      ["docker", "compose", "--env-file", ".env.local", "-f", "infra/local/compose.yaml",
        "up", "-d", "--wait", "postgres", "azurite", "clamav"],
      ["pnpm", "db:migrate"],
      ["pnpm", "pilot:ensure-storage"],
      ["docker", "compose", "--env-file", ".env.local", "-f", "infra/local/compose.yaml",
        "--profile", "conversion", "up", "-d", "--wait", "conversion-worker"],
      ["pnpm", "build:server"],
    ]);
    expect(lifecycle).toEqual(["admin", "server", "ready"]);
  });

  it("stops the exact recorded server process while preserving Docker volumes", async () => {
    const root = await temporaryProject();
    await initializePilotEnvironment(root);
    await writeFile(join(root, ".pilot", "server.pid"), "4123\n", "utf8");
    const stopped = [];
    const commands = [];

    await stopPilot(root, {
      stopProcess: async (pid) => stopped.push(pid),
      run: async (command, args) => commands.push([command, ...args]),
    });

    expect(stopped).toEqual([4123]);
    expect(commands).toEqual([[
      "docker", "compose", "--env-file", ".env.local", "-f", "infra/local/compose.yaml",
      "--profile", "conversion", "down",
    ]]);
    await expect(readFile(join(root, ".pilot", "server.pid"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("formats only supported local delivery events without internal identifiers", () => {
    const output = formatPilotMailbox([
      {
        event_type: "identity.member_code_requested",
        created_at: new Date("2026-08-24T20:00:00Z"),
        payload: { email: "clen@example.cz", code: "123456", userId: "private-id" },
      },
      {
        event_type: "identity.admin_invited",
        created_at: new Date("2026-08-24T20:01:00Z"),
        payload: { email: "admin@example.cz", setupToken: "one-time-token", role: "admin" },
      },
    ]);

    expect(output).toContain("clen@example.cz | kód 123456");
    expect(output).toContain("admin@example.cz | nastavovací token one-time-token");
    expect(output).not.toContain("private-id");
  });

  it("runs pnpm through Node on Windows instead of spawning a cmd shim", () => {
    expect(resolveProcessCommand("pnpm", ["db:migrate"], {
      platform: "win32",
      execPath: "C:\\runtime\\node.exe",
      npmExecPath: "C:\\runtime\\pnpm.cjs",
    })).toEqual({
      command: "C:\\runtime\\node.exe",
      args: ["C:\\runtime\\pnpm.cjs", "db:migrate"],
    });
  });

  it("copies public and Next static assets into the standalone server root", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "public"), { recursive: true });
    await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
    await mkdir(join(root, ".next", "standalone"), { recursive: true });
    await writeFile(join(root, "public", "logo.svg"), "logo", "utf8");
    await writeFile(join(root, ".next", "static", "chunks", "app.css"), "css", "utf8");

    await prepareStandaloneAssets(root);

    expect(await readFile(join(root, ".next", "standalone", "public", "logo.svg"), "utf8"))
      .toBe("logo");
    expect(await readFile(
      join(root, ".next", "standalone", ".next", "static", "chunks", "app.css"),
      "utf8",
    )).toBe("css");
  });
});

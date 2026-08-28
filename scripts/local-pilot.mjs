import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, open, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const generatedSecrets = new Map([
  ["SESSION_HMAC_KEY", () => randomBytes(32).toString("base64url")],
  ["OTP_HMAC_KEY", () => randomBytes(32).toString("base64url")],
  ["CSRF_HMAC_KEY", () => randomBytes(32).toString("base64url")],
  ["TOTP_ENCRYPTION_KEY", () => randomBytes(16).toString("hex")],
  ["XLSX_MANIFEST_SECRET", () => randomBytes(32).toString("base64url")],
  ["WORKER_CALLBACK_SECRET", () => randomBytes(32).toString("base64url")],
]);

const requiredSecrets = [...generatedSecrets.keys()];

export function assertLocalPilotDatabase(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Pilot maintenance is allowed only for local database sokol_pilot.");
  }
  if (
    parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || parsed.port !== "55433"
    || parsed.pathname !== "/sokol_pilot"
  ) {
    throw new Error("Pilot maintenance is allowed only for local database sokol_pilot on port 55433.");
  }
}

export function validatePilotEnvironment(values) {
  for (const name of requiredSecrets) {
    const value = values.get(name) ?? "";
    if (value.length < 32 || value.includes("replace-with-")) {
      throw new Error(`${name} must contain an independent local secret of at least 32 characters.`);
    }
  }
  if (values.get("TOTP_ENCRYPTION_KEY").length !== 32) {
    throw new Error("TOTP_ENCRYPTION_KEY must contain exactly 32 characters.");
  }
  const distinct = new Set(requiredSecrets.map((name) => values.get(name)));
  if (distinct.size !== requiredSecrets.length) {
    throw new Error("Each pilot secret must be independent.");
  }
  const databaseUrl = values.get("DATABASE_URL") ?? "";
  assertLocalPilotDatabase(databaseUrl);
  return values;
}

export function parseEnvironment(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function setEnvironmentValue(contents, name, value) {
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(contents)
    ? contents.replace(pattern, `${name}=${value}`)
    : `${contents.replace(/\s*$/, "\n")}${name}=${value}\n`;
}

export async function initializePilotEnvironment(root) {
  const pilotDirectory = join(root, ".pilot");
  await mkdir(join(pilotDirectory, "backups"), { recursive: true });
  const target = join(root, ".env.local");
  try {
    const existing = await readFile(target, "utf8");
    return { created: false, values: parseEnvironment(existing) };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let contents = await readFile(join(root, ".env.example"), "utf8");
  for (const [name, generate] of generatedSecrets) {
    contents = setEnvironmentValue(contents, name, generate());
  }
  contents = setEnvironmentValue(contents, "FIRST_ADMIN_TOKEN_FILE", "./.pilot/first-admin-token.txt");
  contents = setEnvironmentValue(contents, "DATABASE_URL",
    "postgres://sokol:local-only-password@127.0.0.1:55433/sokol_pilot");
  contents = setEnvironmentValue(contents, "AZURE_STORAGE_CONNECTION_STRING",
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10001/devstoreaccount1;");
  contents = setEnvironmentValue(contents, "AZURE_BLOB_ENDPOINT",
    "http://127.0.0.1:10001/devstoreaccount1");
  contents = setEnvironmentValue(contents, "CLAMAV_PORT", "3311");
  contents += [
    "",
    "# Oddělené lokální pilotní prostředí; automatické testy používají sokol_test na 55432.",
    "COMPOSE_PROJECT_NAME=sokol-spolurozhoduje-pilot",
    "POSTGRES_DB=sokol_pilot",
    "POSTGRES_BIND_PORT=55433",
    "AZURITE_BIND_PORT=10001",
    "CLAMAV_BIND_PORT=3311",
    "",
  ].join("\n");
  await writeFile(target, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { created: true, values: parseEnvironment(contents) };
}

export function resolveProcessCommand(command, args, runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  const execPath = runtime.execPath ?? process.execPath;
  const npmExecPath = runtime.npmExecPath ?? process.env.npm_execpath;
  if (platform === "win32" && command === "pnpm" && npmExecPath) {
    return { command: execPath, args: [npmExecPath, ...args] };
  }
  return {
    command: platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command,
    args,
  };
}

export async function runProcess(command, args, { cwd, env = process.env } = {}) {
  const resolved = resolveProcessCommand(command, args);
  await new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd, env, stdio: "inherit", windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}.`)));
  });
}

export async function prepareStandaloneAssets(root) {
  const standaloneRoot = join(root, ".next", "standalone");
  await mkdir(join(standaloneRoot, ".next"), { recursive: true });
  await cp(join(root, "public"), join(standaloneRoot, "public"), {
    recursive: true,
    force: true,
  });
  await cp(join(root, ".next", "static"), join(standaloneRoot, ".next", "static"), {
    recursive: true,
    force: true,
  });
}

function environmentObject(values) {
  return Object.fromEntries(values.entries());
}

export async function startStandaloneServer(root, environment) {
  const pilotDirectory = join(root, ".pilot");
  const standaloneRoot = join(root, ".next", "standalone");
  await prepareStandaloneAssets(root);
  const log = await open(join(pilotDirectory, "server.log"), "a");
  const child = spawn(process.execPath, [join(standaloneRoot, "server.js")], {
    cwd: standaloneRoot,
    detached: true,
    env: { ...process.env, ...environment, HOSTNAME: "127.0.0.1", PORT: "3000" },
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
  });
  child.unref();
  await writeFile(join(pilotDirectory, "server.pid"), `${child.pid}\n`, "utf8");
  await log.close();
}

export async function waitForPilotReadiness(origin = "http://127.0.0.1:3000") {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health/ready`);
      if (response.ok) return;
    } catch {}
    await delay(1_000);
  }
  throw new Error("Local pilot did not become ready within 60 seconds.");
}

export async function startPilot(root, dependencies = {}) {
  const initialized = await initializePilotEnvironment(root);
  const values = validatePilotEnvironment(initialized.values);
  const env = { ...process.env, ...environmentObject(values) };
  const run = dependencies.run ?? runProcess;
  const ensureSuperadmin = dependencies.ensureSuperadmin
    ?? (() => run("pnpm", ["pilot:ensure-admin"], { cwd: root, env }));
  const startServer = dependencies.startServer
    ?? (() => startStandaloneServer(root, environmentObject(values)));
  const waitForReadiness = dependencies.waitForReadiness ?? waitForPilotReadiness;

  await run("docker", [
    "compose", "--env-file", ".env.local", "-f", "infra/local/compose.yaml",
    "up", "-d", "--wait", "postgres", "azurite", "clamav",
  ], { cwd: root, env });
  await run("pnpm", ["db:migrate"], { cwd: root, env });
  await run("pnpm", ["pilot:ensure-storage"], { cwd: root, env });
  await ensureSuperadmin();
  await run("docker", [
    "compose", "--env-file", ".env.local", "-f", "infra/local/compose.yaml",
    "--profile", "conversion", "up", "-d", "--wait", "conversion-worker",
  ], { cwd: root, env });
  await run("pnpm", ["build:server"], { cwd: root, env });
  await startServer();
  await waitForReadiness(values.get("APP_ORIGIN") ?? "http://127.0.0.1:3000");
  return { status: "ready", environmentCreated: initialized.created };
}

export async function stopRecordedServer(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function stopPilot(root, dependencies = {}) {
  const pidFile = join(root, ".pilot", "server.pid");
  try {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Pilot server PID file is invalid.");
    await (dependencies.stopProcess ?? stopRecordedServer)(pid);
    await rm(pidFile, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const run = dependencies.run ?? runProcess;
  await run("docker", [
    "compose", "--env-file", ".env.local", "-f", "infra/local/compose.yaml",
    "--profile", "conversion", "down",
  ], { cwd: root });
  return { status: "stopped" };
}

export async function pilotStatus(root, dependencies = {}) {
  const run = dependencies.run ?? runProcess;
  await run("docker", [
    "compose", "--env-file", ".env.local", "-f", "infra/local/compose.yaml", "ps",
  ], { cwd: root });
  try {
    const response = await (dependencies.fetch ?? fetch)("http://127.0.0.1:3000/api/health/ready");
    return { status: response.ok ? "ready" : "unhealthy" };
  } catch {
    return { status: "stopped" };
  }
}

export function formatPilotMailbox(rows) {
  const formatted = [];
  for (const row of rows) {
    const email = typeof row.payload?.email === "string" ? row.payload.email : "neuvedený e-mail";
    let delivery;
    if (row.event_type === "identity.member_code_requested" && /^\d{6}$/.test(row.payload?.code)) {
      delivery = `kód ${row.payload.code}`;
    } else if (row.event_type === "identity.admin_invited" && row.payload?.setupToken) {
      delivery = `nastavovací token ${row.payload.setupToken}`;
    } else if (row.event_type === "identity.password_reset_requested" && row.payload?.token) {
      delivery = `obnovovací token ${row.payload.token}`;
    } else {
      continue;
    }
    formatted.push(`${new Date(row.created_at).toISOString()} | ${email} | ${delivery}`);
  }
  return formatted.length > 0 ? formatted.join("\n") : "Testovací schránka je prázdná.";
}

export async function readPilotMailbox(databaseUrl) {
  assertLocalPilotDatabase(databaseUrl);
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql`
      select event_type, created_at, payload
      from outbox_events
      where event_type in (
        'identity.member_code_requested',
        'identity.admin_invited',
        'identity.password_reset_requested'
      )
      order by created_at desc
      limit 20
    `;
    return formatPilotMailbox(rows);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function main() {
  const root = process.cwd();
  const command = process.argv[2] ?? "status";
  if (command === "init") {
    const result = await initializePilotEnvironment(root);
    process.stdout.write(result.created
      ? "Pilot environment created in .env.local.\n"
      : "Existing .env.local preserved.\n");
    return;
  }
  if (command === "start") {
    const result = await startPilot(root);
    process.stdout.write(`Local pilot is ${result.status} at http://127.0.0.1:3000.\n`);
    return;
  }
  if (command === "stop") {
    await stopPilot(root);
    process.stdout.write("Local pilot stopped; database and file volumes were preserved.\n");
    return;
  }
  if (command === "status") {
    const result = await pilotStatus(root);
    process.stdout.write(`Local pilot status: ${result.status}.\n`);
    if (result.status !== "ready") process.exitCode = 1;
    return;
  }
  if (command === "mailbox") {
    const initialized = await initializePilotEnvironment(root);
    const values = validatePilotEnvironment(initialized.values);
    process.stdout.write("POUZE LOKÁLNÍ PILOT — jednorázové údaje nikomu nepřeposílejte.\n");
    process.stdout.write(`${await readPilotMailbox(values.get("DATABASE_URL"))}\n`);
    return;
  }
  throw new Error(`Unknown local pilot command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

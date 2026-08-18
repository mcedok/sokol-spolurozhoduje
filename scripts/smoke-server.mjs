import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { delimiter, dirname, isAbsolute } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { hash } from "@node-rs/argon2";
import { generateSecret, generateSync } from "otplib";
import postgres from "postgres";
import { assertMatchingDisposableSmokeDatabases } from "./smoke-safety.mjs";

const hostDatabaseUrl = process.env.DATABASE_URL ??
  "postgres://sokol:local-only-password@127.0.0.1:55432/sokol_test";
const containerDatabaseUrl = process.env.SMOKE_CONTAINER_DATABASE_URL ??
  "postgres://sokol:local-only-password@host.docker.internal:55432/sokol_test";
const docker = process.env.DOCKER_BIN ?? "docker";
const dockerEnvironment = isAbsolute(docker)
  ? { ...process.env, PATH: `${dirname(docker)}${delimiter}${process.env.PATH ?? ""}` }
  : process.env;
const image = process.env.SMOKE_IMAGE ?? "sokol-spolurozhoduje:phase-a";
const operationsImage = `${image}-operations`;
const port = Number(process.env.SMOKE_PORT ?? 33117);
const containerName = `sokol-phase-a-smoke-${process.pid}`;
const origin = `http://127.0.0.1:${port}`;
const keys = {
  session: "smoke-session-key-12345678901234567890",
  otp: "smoke-otp-key-1234567890123456789012",
  csrf: "smoke-csrf-key-12345678901234567890",
  totp: "0123456789abcdef0123456789abcdef",
};
const sql = postgres(hostDatabaseUrl, { max: 2 });
let container;
let assertions = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  process.stdout.write(`PASS ${message}\n`);
}

function encryptTotp(secret) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keys.totp), nonce);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

async function seedAdmin({ email, role, password }) {
  const secret = generateSecret();
  const [user] = await sql`
    insert into users (
      organization_id, first_name, last_name, email, role, status, email_verified_at
    ) select id, 'Smoke', 'Správce', ${email}, ${role}, 'active', now()
      from organizations where code = 'SMOKE'
    returning id
  `;
  await sql`
    insert into admin_credentials (
      user_id, password_hash, totp_secret_ciphertext, totp_enabled_at
    ) values (${user.id}, ${await hash(password)}, ${encryptTotp(secret)}, now())
  `;
  return { ...user, email, password, secret };
}

async function resetAndSeed() {
  await sql.unsafe(`
    truncate table
      document_approvals, document_sequences, outbox_events, audit_events,
      document_state_transitions, documents, sessions, login_challenges,
      admin_credentials, users, organizations
    restart identity cascade
  `);
  await sql`insert into organizations (code, name) values ('SMOKE', 'TJ Sokol Smoke')`;
  return seedAdmin({
    email: "superadmin.smoke@example.cz",
    role: "superadmin",
    password: "Smoke-Superadmin-1!",
  });
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

async function request(path, { method = "GET", body, cookie, csrf, idempotencyKey, version } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  if (version) headers["if-match"] = `"${version}"`;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, data, cookie: cookieFrom(response) };
}

async function expectStatus(result, status, label) {
  check(result.response.status === status,
    `${label} (${result.response.status}${result.data?.code ? ` ${result.data.code}` : ""})`);
  return result;
}

async function adminLogin(account) {
  const password = await expectStatus(await request("/api/auth/admin/password", {
    method: "POST", body: { email: account.email, password: account.password },
  }), 200, `heslo ${account.email}`);
  const mfa = await expectStatus(await request("/api/auth/admin/mfa", {
    method: "POST",
    body: { loginAttemptId: password.data.loginAttemptId, token: generateSync({ secret: account.secret }) },
  }), 200, `MFA ${account.email}`);
  check(Boolean(mfa.cookie), `session cookie ${account.email}`);
  check(Boolean(mfa.data.csrfToken), `CSRF token ${account.email}`);
  return { cookie: mfa.cookie, csrf: mfa.data.csrfToken, user: mfa.data.user };
}

async function portIsOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function waitForReadiness() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await request("/api/health/ready");
      if (result.response.status === 200) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Server nebyl připraven do 20 sekund.");
}

async function run() {
  assertMatchingDisposableSmokeDatabases(
    hostDatabaseUrl,
    containerDatabaseUrl,
    process.env.SMOKE_ALLOW_DATABASE_RESET,
  );
  if (process.env.SMOKE_SKIP_BUILD !== "1") {
    const applicationBuild = spawnSync(docker, ["build", "--tag", image, "."], {
      cwd: process.cwd(), env: dockerEnvironment, stdio: "inherit",
    });
    check(applicationBuild.status === 0, "aktuální aplikační Docker image");
    const operationsBuild = spawnSync(docker, [
      "build", "--target", "operations", "--tag", operationsImage, ".",
    ], { cwd: process.cwd(), env: dockerEnvironment, stdio: "inherit" });
    check(operationsBuild.status === 0, "aktuální operační Docker image");
  }
  const migrate = spawnSync(docker, [
    "run", "--rm", "--add-host", "host.docker.internal:host-gateway",
    "-e", `DATABASE_URL=${containerDatabaseUrl}`,
    operationsImage, "pnpm", "db:migrate",
  ], { env: dockerEnvironment, stdio: "inherit" });
  check(migrate.status === 0, "databázové migrace");
  const superadminAccount = await resetAndSeed();

  check(!(await portIsOpen()), `port ${port} je před testem volný`);
  container = spawn(docker, [
    "run", "--rm", "--name", containerName,
    "--add-host", "host.docker.internal:host-gateway",
    "-p", `127.0.0.1:${port}:3000`,
    "-e", `DATABASE_URL=${containerDatabaseUrl}`,
    "-e", `SESSION_HMAC_KEY=${keys.session}`,
    "-e", `OTP_HMAC_KEY=${keys.otp}`,
    "-e", `CSRF_HMAC_KEY=${keys.csrf}`,
    "-e", `TOTP_ENCRYPTION_KEY=${keys.totp}`,
    "-e", `APP_ORIGIN=${origin}`,
    image,
  ], { env: dockerEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  container.stdout.on("data", (chunk) => { logs += chunk; });
  container.stderr.on("data", (chunk) => { logs += chunk; });
  await waitForReadiness();
  check(true, "kontejner je připraven");

  const live = await expectStatus(await request("/api/health/live"), 200, "liveness");
  check(live.data.status === "ok", "liveness neodhaluje konfiguraci");
  const anonymous = await expectStatus(await request("/api/bootstrap"), 200, "anonymní bootstrap");
  check(anonymous.data.viewer === null, "anonymní bootstrap nemá identitu");
  check(!/"(email|membershipId|ownerAdminId|rowVersion)"\s*:/i.test(JSON.stringify(anonymous.data)),
    "anonymní bootstrap neobsahuje interní pole");

  const memberRequest = await expectStatus(await request("/api/auth/member/request-code", {
    method: "POST",
    body: {
      email: "clen.smoke@example.cz", firstName: "Jan", lastName: "Člen",
      organizationCode: "SMOKE", membershipId: null,
    },
  }), 202, "žádost o členský kód");
  const [memberOutbox] = await sql`
    select payload from outbox_events
    where aggregate_id = ${memberRequest.data.challengeId}
      and event_type = 'identity.member_code_requested'
  `;
  const memberLogin = await expectStatus(await request("/api/auth/member/verify-code", {
    method: "POST",
    body: { challengeId: memberRequest.data.challengeId, code: memberOutbox.payload.code },
  }), 200, "ověření členského kódu");
  check(memberLogin.data.user.role === "member", "člen má členskou roli");

  const superadmin = await adminLogin(superadminAccount);
  const inviteKey = randomUUID();
  const invited = await expectStatus(await request("/api/users", {
    method: "POST", cookie: superadmin.cookie, csrf: superadmin.csrf,
    idempotencyKey: inviteKey,
    body: {
      email: "admin.smoke@example.cz", firstName: "Anna", lastName: "Admin",
      organizationCode: "SMOKE", membershipId: null, role: "admin",
    },
  }), 201, "vytvoření administrátora");
  check(invited.data.user.status === "invited", "nový administrátor je pozvaný");
  const [invite] = await sql`select payload from outbox_events where idempotency_key = ${inviteKey}`;
  const setup = await expectStatus(await request("/api/auth/admin/setup", {
    method: "POST", body: { token: invite.payload.setupToken, password: "Smoke-Admin-2!" },
  }), 200, "první heslo administrátora");
  const enroll = await expectStatus(await request("/api/auth/admin/mfa/enroll", {
    method: "POST", body: { setupAttemptId: setup.data.setupAttemptId },
  }), 200, "zahájení MFA administrátora");
  const enrolledSecret = new URL(enroll.data.otpauthUri).searchParams.get("secret");
  check(Boolean(enrolledSecret), "MFA enrollment obsahuje tajemství pro autentikátor");
  const adminLoginResult = await expectStatus(await request("/api/auth/admin/mfa/confirm", {
    method: "POST",
    body: { setupAttemptId: setup.data.setupAttemptId, token: generateSync({ secret: enrolledSecret }) },
  }), 200, "potvrzení MFA administrátora");
  const admin = {
    cookie: adminLoginResult.cookie,
    csrf: adminLoginResult.data.csrfToken,
  };

  const documentKey = randomUUID();
  const documentInput = {
    title: "Smoke norma", explanatoryReport: "Důvodová zpráva",
    visibilityMode: "public_detail", fourEyesRequired: false,
  };
  const created = await expectStatus(await request("/api/documents", {
    method: "POST", cookie: admin.cookie, csrf: admin.csrf,
    idempotencyKey: documentKey,
    body: documentInput,
  }), 201, "vytvoření dokumentu");
  check(/^SOKOL-\d{4}-\d{3}$/.test(created.data.document.publicId), "dokument má pořadové číslo");
  const replayed = await expectStatus(await request("/api/documents", {
    method: "POST", cookie: admin.cookie, csrf: admin.csrf,
    idempotencyKey: documentKey, body: documentInput,
  }), 201, "idempotentní opakování vytvoření dokumentu");
  check(replayed.data.document.id === created.data.document.id, "opakování nezdvojilo dokument");
  const [{ count: documentOutboxCount }] = await sql`
    select count(*)::int as count from outbox_events where idempotency_key = ${documentKey}
  `;
  check(documentOutboxCount === 1, "opakování nezdvojilo outbox událost");

  let currentDocument = created.data.document;
  for (const status of [
    "file_check", "conversion", "conversion_review", "ready", "published_open",
  ]) {
    const changed = await expectStatus(await request(
      `/api/documents/${currentDocument.id}/status`,
      {
        method: "POST", cookie: admin.cookie, csrf: admin.csrf,
        idempotencyKey: randomUUID(), version: currentDocument.rowVersion,
        body: { status, reason: `Smoke přechod ${status}` },
      },
    ), 200, `stav dokumentu ${status}`);
    currentDocument = changed.data.document;
  }
  const publicDocumentSnapshot = await expectStatus(
    await request("/api/bootstrap"), 200, "veřejný publikovaný dokument",
  );
  check(publicDocumentSnapshot.data.documents.some((item) => item.title === "Smoke norma"),
    "publikovaný dokument je veřejně viditelný");
  check(!/"(email|membershipId|ownerAdminId|rowVersion)"\s*:/i.test(
    JSON.stringify(publicDocumentSnapshot.data),
  ), "veřejný dokument neobsahuje interní pole");

  const otherAccount = await seedAdmin({
    email: "jiny.admin.smoke@example.cz", role: "admin", password: "Smoke-Other-3!",
  });
  const other = await adminLogin(otherAccount);
  const denied = await request(`/api/documents/${created.data.document.id}`, {
    method: "PATCH", cookie: other.cookie, csrf: other.csrf,
    version: currentDocument.rowVersion,
    body: {
      title: "Cizí změna", explanatoryReport: "Důvodová zpráva",
      visibilityMode: "public_detail", fourEyesRequired: false,
    },
  });
  await expectStatus(denied, 403, "zákaz změny cizího dokumentu");
  check(denied.data.code === "FORBIDDEN", "zákaz vrací bezpečný kód FORBIDDEN");

  const transferred = await expectStatus(await request(
    `/api/documents/${created.data.document.id}/owner`,
    {
      method: "POST", cookie: superadmin.cookie, csrf: superadmin.csrf,
      idempotencyKey: randomUUID(), version: currentDocument.rowVersion,
      body: { ownerAdminId: otherAccount.id },
    },
  ), 200, "převod vlastnictví superadministrátorem");
  check(transferred.data.document.ownerAdminId === otherAccount.id,
    "nový administrátor je vlastníkem dokumentu");

  const [memberRow] = await sql`
    select id, row_version from users where email = 'clen.smoke@example.cz'
  `;
  await expectStatus(await request(`/api/users/${memberRow.id}/status`, {
    method: "POST", cookie: superadmin.cookie, csrf: superadmin.csrf,
    idempotencyKey: randomUUID(), version: memberRow.row_version,
    body: { status: "blocked" },
  }), 200, "zablokování člena superadministrátorem");
  await expectStatus(await request("/api/auth/session", {
    cookie: memberLogin.cookie,
  }), 401, "blokace zneplatní členskou relaci");

  await expectStatus(await request("/api/auth/logout", {
    method: "POST", cookie: admin.cookie, csrf: admin.csrf,
  }), 204, "odhlášení administrátora");
  await expectStatus(await request("/api/auth/session", {
    cookie: admin.cookie,
  }), 401, "odhlášení zneplatní správcovskou relaci");
  const audit = await sql`select action from audit_events`;
  check(audit.some((row) => row.action === "authorization.denied"), "audit obsahuje zamítnutí oprávnění");
  check(logs.length < 200_000, "serverové logy zůstaly v bezpečné velikosti");
}

async function cleanup() {
  if (container && container.exitCode === null) {
    spawnSync(docker, ["stop", "--time", "5", containerName], {
      env: dockerEnvironment, stdio: "ignore",
    });
  }
  await sql.end({ timeout: 2 });
  for (let attempt = 0; attempt < 20 && await portIsOpen(); attempt += 1) await delay(250);
  check(!(await portIsOpen()), `port ${port} je po testu uvolněný`);
}

try {
  await run();
  process.stdout.write(`SMOKE PASS (${assertions} kontrol)\n`);
} catch (error) {
  process.stderr.write(`SMOKE FAIL: ${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) {
    process.stderr.write(`CLEANUP FAIL: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

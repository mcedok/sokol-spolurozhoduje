import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { delimiter, dirname, isAbsolute } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { hash } from "@node-rs/argon2";
import { generateSecret, generateSync } from "otplib";
import postgres from "postgres";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
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
const workerImage = `${image}-worker`;
const port = Number(process.env.SMOKE_PORT ?? 33117);
const containerName = `sokol-phase-a-smoke-${process.pid}`;
const workerContainerName = `${containerName}-worker`;
const smokeNetworkName = `${containerName}-network`;
const origin = `http://127.0.0.1:${port}`;
const keys = {
  session: "smoke-session-key-12345678901234567890",
  otp: "smoke-otp-key-1234567890123456789012",
  csrf: "smoke-csrf-key-12345678901234567890",
  totp: "0123456789abcdef0123456789abcdef",
};
const smokeStorageConnection = process.env.SMOKE_STORAGE_CONNECTION_STRING
  ?? "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey="
    + "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/"
    + "K1SZFPTOtr/KBHBeksoGMGw==;"
    + "BlobEndpoint=http://host.docker.internal:10000/devstoreaccount1;";
const sql = postgres(hostDatabaseUrl, { max: 2 });
let container;
let workerContainer;
let assertions = 0;
let logs = "";
let workerLogs = "";

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
  return { ...user, email, role, password, secret };
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

async function uploadXlsx(path, bytes, { cookie, csrf }) {
  const form = new FormData();
  form.set("file", new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "smoke-working.xlsx");
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      cookie,
      "x-csrf-token": csrf,
      "idempotency-key": randomUUID(),
    },
    body: form,
  });
  const data = await response.json();
  return { response, data, cookie: cookieFrom(response) };
}

async function poll(path, cookie, terminal, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await request(path, { cookie });
    if (terminal.includes(result.data?.status)) return result;
    await delay(500);
  }
  throw new Error(`${label} nebyl dokončen do 40 sekund.`);
}

function changeFirstRowPriority(bytes, priority) {
  const archive = unzipSync(new Uint8Array(bytes));
  const sheetName = Object.keys(archive).find((name) => name.toLowerCase() === "xl/worksheets/sheet2.xml");
  if (!sheetName) throw new Error("Pracovní list Vypořádání nebyl v XLSX nalezen.");
  const xml = strFromU8(archive[sheetName]);
  let changed = false;
  const updated = xml.replace(/<c([^>]*\br="I2"[^>]*)>[\s\S]*?<\/c>/, (_cell, attributes) => {
    changed = true;
    const cleaned = attributes.replace(/\s+t="[^"]*"/g, "");
    return `<c${cleaned} t="inlineStr"><is><t>${priority}</t></is></c>`;
  });
  if (!changed) throw new Error("Buňku priority I2 se nepodařilo v XLSX změnit.");
  archive[sheetName] = strToU8(updated);
  return zipSync(archive, { level: 6 });
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
  if (account.role === "admin") {
    check(Boolean(password.cookie), `session cookie ${account.email}`);
    check(Boolean(password.data.csrfToken), `CSRF token ${account.email}`);
    return { cookie: password.cookie, csrf: password.data.csrfToken, user: password.data.user };
  }
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
    const workerBuild = spawnSync(docker, [
      "build", "--file", "worker/Dockerfile", "--target", "runtime",
      "--tag", workerImage, ".",
    ], { cwd: process.cwd(), env: dockerEnvironment, stdio: "inherit" });
    check(workerBuild.status === 0, "aktuální XLSX worker Docker image");
  }
  const migrate = spawnSync(docker, [
    "run", "--rm", "--add-host", "host.docker.internal:host-gateway",
    "-e", `DATABASE_URL=${containerDatabaseUrl}`,
    operationsImage, "pnpm", "db:migrate",
  ], { env: dockerEnvironment, stdio: "inherit" });
  check(migrate.status === 0, "databázové migrace");
  const superadminAccount = await resetAndSeed();

  check(!(await portIsOpen()), `port ${port} je před testem volný`);
  const network = spawnSync(docker, ["network", "create", smokeNetworkName], {
    env: dockerEnvironment, stdio: "ignore",
  });
  check(network.status === 0, "dočasná izolovaná Docker síť");
  container = spawn(docker, [
    "run", "--rm", "--name", containerName,
    "--network", smokeNetworkName,
    "--add-host", "host.docker.internal:host-gateway",
    "-p", `127.0.0.1:${port}:3000`,
    "-e", `DATABASE_URL=${containerDatabaseUrl}`,
    "-e", `SESSION_HMAC_KEY=${keys.session}`,
    "-e", `OTP_HMAC_KEY=${keys.otp}`,
    "-e", `CSRF_HMAC_KEY=${keys.csrf}`,
    "-e", `TOTP_ENCRYPTION_KEY=${keys.totp}`,
    "-e", `APP_ORIGIN=${origin}`,
    "-e", `AZURE_STORAGE_CONNECTION_STRING=${smokeStorageConnection}`,
    "-e", "AZURE_BLOB_ENDPOINT=http://localhost:10000/devstoreaccount1",
    "-e", "XLSX_MANIFEST_KEY_ID=smoke-xlsx-key",
    "-e", "WORKER_CALLBACK_SECRET=smoke-worker-callback-secret",
    image,
  ], { env: dockerEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  logs = "";
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
  check(setup.data.kind === "password_ready", "běžný administrátor po nastavení hesla nevyžaduje MFA");
  const admin = await adminLogin({
    email: "admin.smoke@example.cz", password: "Smoke-Admin-2!", role: "admin",
  });

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

  const [{ id: adminUserId }] = await sql`
    select id from users where email='admin.smoke@example.cz'
  `;
  const versionId = randomUUID();
  await sql`
    insert into document_versions (
      id, document_id, version_number, status, created_by_user_id,
      review_completed_by_user_id, review_completed_at
    ) values (
      ${versionId}, ${currentDocument.id}, 1, 'ready', ${adminUserId},
      ${adminUserId}, now()
    )
  `;
  const blockUid = randomUUID();
  const blockRevisionId = randomUUID();
  await sql`insert into document_blocks (block_uid, document_id) values (${blockUid}, ${currentDocument.id})`;
  await sql`
    insert into block_revisions (
      block_revision_id, block_uid, document_version_id, block_order, block_type,
      structured_content, plain_text, normalized_hash, parser_version, revision_origin
    ) values (
      ${blockRevisionId}, ${blockUid}, ${versionId}, 1, 'paragraph', '{}',
      'Smoke blok', ${"a".repeat(64)}, 'smoke', 'converted'
    )
  `;
  const renewedMemberCsrf = await expectStatus(await request("/api/auth/session/csrf", {
    method: "POST", cookie: memberLogin.cookie,
  }), 200, "obnova CSRF po simulovaném reloadu člena");
  const publicDetail = await expectStatus(await request(
    `/api/public/documents/${currentDocument.publicId}`, { cookie: memberLogin.cookie },
  ), 200, "veřejný detail s převedeným blokem");
  check(publicDetail.data.document.version.blocks.some((block) => block.blockUid === blockUid),
    "veřejný detail obsahuje stabilní komentovatelný blok");
  const createdComment = await expectStatus(await request(
    `/api/public/documents/${currentDocument.publicId}/blocks/${blockUid}/comments`, {
      method: "POST", cookie: memberLogin.cookie, csrf: renewedMemberCsrf.data.csrfToken,
      idempotencyKey: randomUUID(), version: publicDetail.data.document.participationVersion,
      body: { type: "proposal", text: "Smoke připomínka", priority: "normal" },
    },
  ), 201, "bloková připomínka po reloadu relace");
  const votedComment = await expectStatus(await request(
    `/api/public/comments/${createdComment.data.comment.publicId}/vote`, {
      method: "PUT", cookie: memberLogin.cookie, csrf: renewedMemberCsrf.data.csrfToken,
      idempotencyKey: randomUUID(), version: createdComment.data.participationVersion,
      body: { value: 1, commentRowVersion: createdComment.data.comment.rowVersion },
    },
  ), 200, "hlas pro blokovou připomínku");
  await expectStatus(await request(
    `/api/public/documents/${currentDocument.publicId}/need-vote`, {
      method: "PUT", cookie: memberLogin.cookie, csrf: renewedMemberCsrf.data.csrfToken,
      idempotencyKey: randomUUID(), version: votedComment.data.participationVersion,
      body: { value: "yes" },
    },
  ), 200, "hlas o potřebnosti dokumentu");
  const [{ id: commentId }] = await sql`
    select id from comments where public_id=${createdComment.data.comment.publicId}
  `;

  workerContainer = spawn(docker, [
    "run", "--rm", "--name", workerContainerName,
    "--network", smokeNetworkName,
    "--add-host", "host.docker.internal:host-gateway",
    "-e", `DATABASE_URL=jdbc:postgresql://host.docker.internal:55432/sokol_test`,
    "-e", "DATABASE_USER=sokol",
    "-e", "DATABASE_PASSWORD=local-only-password",
    "-e", `AZURE_STORAGE_CONNECTION_STRING=${smokeStorageConnection}`,
    "-e", "CLAMAV_HOST=host.docker.internal",
    "-e", "CLAMAV_PORT=3310",
    "-e", "WORKER_ID=smoke-xlsx-worker",
    "-e", "XLSX_MANIFEST_KEY_ID=smoke-xlsx-key",
    "-e", "XLSX_MANIFEST_SECRET=smoke-xlsx-signing-secret",
    "-e", `APPLICATION_INTERNAL_URL=http://${containerName}:3000`,
    "-e", "WORKER_CALLBACK_SECRET=smoke-worker-callback-secret",
    workerImage,
  ], { env: dockerEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  workerLogs = "";
  workerContainer.stdout.on("data", (chunk) => { workerLogs += chunk; });
  workerContainer.stderr.on("data", (chunk) => { workerLogs += chunk; });

  const xlsxExport = await expectStatus(await request(
    `/api/documents/${currentDocument.id}/xlsx-exports`, {
      method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      idempotencyKey: randomUUID(), body: { documentVersionId: versionId },
    },
  ), 202, "založení pracovního XLSX exportu");
  const completedXlsx = await expectStatus(await poll(
    `/api/xlsx-exports/${xlsxExport.data.id}`, admin.cookie, ["completed", "failed"], "XLSX export",
  ), 200, "dokončení pracovního XLSX exportu");
  check(completedXlsx.data.status === "completed" && completedXlsx.data.downloadReady,
    "worker dokončil pracovní XLSX export");
  const xlsxLink = await expectStatus(await request(
    `/api/xlsx-exports/${xlsxExport.data.id}/download-link`, { cookie: admin.cookie },
  ), 200, "odkaz pracovního XLSX");
  const hostDownloadUrl = new URL(xlsxLink.data.url);
  hostDownloadUrl.hostname = "127.0.0.1";
  hostDownloadUrl.port = "10000";
  const downloadedXlsx = await fetch(hostDownloadUrl);
  check(downloadedXlsx.ok, "pracovní XLSX lze stáhnout z objektového úložiště");
  const changedXlsx = changeFirstRowPriority(await downloadedXlsx.arrayBuffer(), "high");
  const acceptedXlsx = await expectStatus(await uploadXlsx(
    `/api/documents/${currentDocument.id}/xlsx-imports?exportJobId=${xlsxExport.data.id}`,
    changedXlsx,
    admin,
  ), 202, "upload upraveného pracovního XLSX");
  const completedImport = await expectStatus(await poll(
    `/api/xlsx-imports/${acceptedXlsx.data.id}`, admin.cookie, ["completed", "failed", "awaiting_resolution"],
    "XLSX import",
  ), 200, "dokončení pracovního XLSX importu");
  check(completedImport.data.status === "completed", "bezkonfliktní XLSX změna se použila automaticky");
  const [changedComment] = await sql`select priority from comments where id=${commentId}`;
  check(changedComment.priority === "high", "XLSX import změnil prioritu připomínky");
  const xlsxAudit = await sql`
    select action from audit_events
    where target_id in (${xlsxExport.data.id}, ${acceptedXlsx.data.id}, ${commentId})
  `;
  check(xlsxAudit.some((row) => row.action === "xlsx_import.worker_compared"),
    "worker zapsal hashovaný audit porovnání XLSX");
  check(xlsxAudit.some((row) => row.action === "xlsx_import.row_applied"),
    "automatická změna má řádkový hashovaný audit");

  const publicExport = await expectStatus(await request(
    `/api/documents/${currentDocument.id}/exports`, {
      method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      idempotencyKey: randomUUID(),
      body: {
        documentVersionId: versionId,
        visibility: "public",
        filters: { statuses: [], priorities: [], types: [] },
        options: {},
      },
    },
  ), 202, "založení veřejného PDF exportu");
  check(publicExport.data.status === "queued" && publicExport.data.downloadReady === false
    && !("outputFileId" in publicExport.data),
  "veřejné exportní API skryje interní file ID a vrátí stav fronty");
  const internalExport = await expectStatus(await request(
    `/api/documents/${currentDocument.id}/exports`, {
      method: "POST", cookie: admin.cookie, csrf: admin.csrf,
      idempotencyKey: randomUUID(),
      body: {
        documentVersionId: versionId,
        visibility: "internal",
        filters: { statuses: ["settled"], priorities: ["high"], types: ["proposal"] },
        options: { includeAuthorEmail: true, includeMembershipId: false, includeInternalNote: false },
      },
    },
  ), 202, "založení interního filtrovaného PDF exportu");
  const outputFileId = randomUUID();
  await sql`
    insert into file_objects (
      id, document_id, data_owner_user_id, purpose, container, object_key,
      original_name, declared_mime, detected_mime, size_bytes, sha256,
      av_status, av_checked_at, object_status, retention_class
    ) values (
      ${outputFileId}, ${currentDocument.id}, ${adminUserId}, 'pdf_export', 'derivatives',
      ${`smoke/pdf/${outputFileId}.pdf`}, 'smoke-export.pdf', 'application/pdf',
      'application/pdf', 100, ${"f".repeat(64)}, 'clean', now(), 'derivative', 'document'
    )
  `;
  await sql`
    update export_jobs set status='completed', output_file_id=${outputFileId},
      pdfa_validated=true, validation_report='{"compliant":true}'::jsonb,
      completed_at=now(), updated_at=now(), row_version=row_version+1
    where id=${internalExport.data.id}
  `;
  const completedExport = await expectStatus(await request(
    `/api/export-jobs/${internalExport.data.id}`, { cookie: admin.cookie },
  ), 200, "stav dokončeného interního PDF exportu");
  check(completedExport.data.status === "completed" && completedExport.data.downloadReady === true
    && !("outputFileId" in completedExport.data),
  "stav exportu zpřístupní stažení bez interního file ID");
  const exportDownload = await expectStatus(await request(
    `/api/export-jobs/${internalExport.data.id}/download-link`, { cookie: admin.cookie },
  ), 200, "krátkodobý odkaz interního PDF exportu");
  check(exportDownload.data.url.includes("sig=") && exportDownload.data.expiresAt,
    "interní PDF má časově omezený podepsaný odkaz");

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
  if (workerContainer && workerContainer.exitCode === null) {
    spawnSync(docker, ["stop", "--time", "5", workerContainerName], {
      env: dockerEnvironment, stdio: "ignore",
    });
  }
  if (container && container.exitCode === null) {
    spawnSync(docker, ["stop", "--time", "5", containerName], {
      env: dockerEnvironment, stdio: "ignore",
    });
  }
  spawnSync(docker, ["network", "rm", smokeNetworkName], {
    env: dockerEnvironment, stdio: "ignore",
  });
  await sql.end({ timeout: 2 });
  for (let attempt = 0; attempt < 20 && await portIsOpen(); attempt += 1) await delay(250);
  check(!(await portIsOpen()), `port ${port} je po testu uvolněný`);
}

try {
  await run();
  process.stdout.write(`SMOKE PASS (${assertions} kontrol)\n`);
} catch (error) {
  process.stderr.write(`SMOKE FAIL: ${error.stack ?? error}\n`);
  if (typeof logs === "string" && logs) {
    process.stderr.write(`SERVER LOGS:\n${logs.slice(-20_000)}\n`);
  }
  if (typeof workerLogs === "string" && workerLogs) {
    process.stderr.write(`WORKER LOGS:\n${workerLogs.slice(-20_000)}\n`);
  }
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) {
    process.stderr.write(`CLEANUP FAIL: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

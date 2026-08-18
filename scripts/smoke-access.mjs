import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_HOST = "localhost";
const APP_PORT = Number(process.env.SMOKE_ACCESS_PORT || 4175);
const CDP_HOST = "127.0.0.1";
const CDP_PORT = Number(process.env.SMOKE_ACCESS_CDP_PORT || 9335);
const OVERALL_TIMEOUT_MS = Number(process.env.SMOKE_ACCESS_TIMEOUT_MS || 180_000);
const STEP_TIMEOUT_MS = 15_000;
const APP_URL = `http://${APP_HOST}:${APP_PORT}`;
const CDP_URL = `http://${CDP_HOST}:${CDP_PORT}`;
const ARTIFACT_DIR = resolve(PROJECT_ROOT, ".superpowers", "smoke-access");
const PROFILE_PREFIX = "sokol-smoke-access-";
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const COPY = {
  login: "P\u0159ihl\u00e1sit",
  continue: "Pokra\u010dovat",
  logout: "Odhl\u00e1sit",
  users: "U\u017eivatel\u00e9",
  administration: "Administrace",
  myNorms: "Moje normy",
};

const assertions = [];
const browserErrors = [];
const resourceErrors = [];
const devOutput = [];
const abortController = new AbortController();
let devProcess;
let chromeProcess;
let chromeProfile;
let socket;
let commandSequence = 0;
const pendingCommands = new Map();

function mark(message) {
  process.stdout.write(`[smoke:access] ${message}\n`);
}

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
  assertions.push(message);
  mark(`PASS ${message}`);
}

function throwIfAborted() {
  if (abortController.signal.aborted) {
    throw abortController.signal.reason || new Error("Smoke run aborted.");
  }
}

function collectOutput(stream, prefix) {
  stream?.on("data", (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      devOutput.push(`${prefix}: ${line}`);
      if (devOutput.length > 80) devOutput.shift();
    }
  });
}

function isPortFree(host, port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function waitUntil(check, description, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    throwIfAborted();
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const detail = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}.${detail}`);
}

async function waitForHttp() {
  await waitUntil(async () => {
    if (devProcess?.exitCode !== null) {
      throw new Error(`Vinext exited with code ${devProcess.exitCode}.`);
    }
    try {
      const response = await fetch(APP_URL, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch {
      return false;
    }
  }, `Vinext readiness at ${APP_URL}`, 35_000);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === "win32" && join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "win32" && join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "win32" && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "darwin" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    process.platform === "linux" && "/usr/bin/google-chrome",
    process.platform === "linux" && "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error("Google Chrome was not found. Set CHROME_PATH to its executable.");
  }
  return executable;
}

function startDevServer() {
  const cli = resolve(PROJECT_ROOT, "node_modules", "vinext", "dist", "cli.js");
  if (!existsSync(cli)) throw new Error(`Vinext CLI is missing: ${cli}`);
  devProcess = spawn(
    process.execPath,
    [cli, "dev", "--host", APP_HOST, "--port", String(APP_PORT)],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  collectOutput(devProcess.stdout, "dev");
  collectOutput(devProcess.stderr, "dev:error");
  mark(`Vinext started as PID ${devProcess.pid}`);
}

function startChrome() {
  chromeProfile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  chromeProcess = spawn(
    findChrome(),
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-address=${CDP_HOST}`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${chromeProfile}`,
      "about:blank",
    ],
    { cwd: PROJECT_ROOT, windowsHide: true, stdio: "ignore" },
  );
  mark(`Chrome started as PID ${chromeProcess.pid}`);
}

async function connectCdp() {
  await waitUntil(async () => {
    if (chromeProcess?.exitCode !== null) {
      throw new Error(`Chrome exited with code ${chromeProcess.exitCode}.`);
    }
    try {
      const response = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) return false;
      const targets = await response.json();
      return targets.some((candidate) => candidate.type === "page");
    } catch {
      return false;
    }
  }, "Chrome CDP endpoint", 20_000);

  const targets = await fetch(`${CDP_URL}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome page target is unavailable.");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Timed out opening the CDP socket.")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      rejectPromise(event.error || new Error("CDP socket failed."));
    }, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = pendingCommands.get(message.id);
      if (!pending) return;
      pendingCommands.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      browserErrors.push(`exception: ${message.params.exceptionDetails.text}`);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      browserErrors.push(
        `console.error: ${message.params.args.map((argument) => argument.value || argument.description || "").join(" ")}`,
      );
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      const { text: entryText, url } = message.params.entry;
      resourceErrors.push([entryText, url].filter(Boolean).join(" · "));
    }
  });
  socket.addEventListener("close", () => {
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP socket closed."));
    }
    pendingCommands.clear();
  });
  mark("CDP connected");
}

function send(method, params = {}) {
  throwIfAborted();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("CDP socket is not open."));
  }
  commandSequence += 1;
  const id = commandSequence;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      rejectPromise(new Error(`CDP command timed out: ${method}`));
    }, 10_000);
    pendingCommands.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function waitFor(expression, description, timeout = STEP_TIMEOUT_MS) {
  await waitUntil(() => evaluate(expression), description, timeout);
}

async function setViewport(width, height, mobile) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await evaluate("window.dispatchEvent(new Event('resize'))");
  await sleep(150);
}

async function installBrowserHelpers() {
  await evaluate(`(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const normalized = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const root = (selector) => document.querySelector(selector) || document;
    window.__accessSmoke = {
      click(selector) {
        const element = document.querySelector(selector);
        if (!visible(element)) throw new Error('Visible element not found: ' + selector);
        element.click();
      },
      clickText(text, scope = 'body', contains = false) {
        const expected = normalized(text);
        const element = [...root(scope).querySelectorAll('button, [role="button"]')]
          .filter(visible)
          .find((candidate) => {
            const actual = normalized(candidate.textContent);
            return contains ? actual.includes(expected) : actual === expected;
          });
        if (!element) throw new Error('Visible control not found: ' + text + ' in ' + scope);
        element.click();
      },
      setValue(selector, value) {
        const element = document.querySelector(selector);
        if (!visible(element)) throw new Error('Visible field not found: ' + selector);
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      },
      visible,
    };
  })()`);
}

async function clickText(text, scope = "body", contains = false) {
  await evaluate(`window.__accessSmoke.clickText(${JSON.stringify(text)}, ${JSON.stringify(scope)}, ${contains})`);
}

async function setValue(selector, value) {
  await evaluate(`window.__accessSmoke.setValue(${JSON.stringify(selector)}, ${JSON.stringify(value)})`);
}

async function openLogin() {
  await waitUntil(async () => {
    if (await evaluate("Boolean(document.querySelector('[data-auth-step]'))")) return true;
    await clickText(COPY.login, ".topbar");
    await sleep(100);
    return evaluate("document.querySelector('[data-auth-step]')?.dataset.authStep === 'identify'");
  }, "login dialog readiness");
}

async function loginWithPassword(email, password, role) {
  await openLogin();
  await setValue('[data-auth-step="identify"] input[name="email"]', email);
  await clickText(COPY.continue, "[data-auth-step]");
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'password'", `${role} password step`);
  await setValue('[data-auth-step="password"] input[name="password"]', password);
  await clickText(COPY.login, "[data-auth-step]");
  await waitFor("Boolean(document.querySelector('.userMenu.signedIn')) && !document.querySelector('[data-auth-step]')", `${role} login`);
}

async function logout() {
  await clickText(COPY.logout, ".userMenu.signedIn");
  await waitFor("Boolean(document.querySelector('.userMenu.signedOut'))", "logout");
}

async function screenshot(name, clip) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const capture = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: Boolean(clip),
    ...(clip ? { clip } : {}),
  });
  const output = resolve(ARTIFACT_DIR, name);
  writeFileSync(output, Buffer.from(capture.data, "base64"));
  return output;
}

async function runBrowserWorkflows() {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await setViewport(1440, 900, false);
  await send("Page.navigate", { url: APP_URL });
  await waitFor("document.readyState === 'complete'", "document load", 25_000);
  await waitFor("Boolean(document.querySelector('.normCard .cardFooter button'))", "public norm cards", 25_000);
  await waitFor(`Object.keys(document.querySelector('.normCard .cardFooter button')).some((key) => key.startsWith('__reactProps'))`, "React hydration", 25_000);
  await installBrowserHelpers();
  await evaluate("window.__accessSmoke.click('.normCard .cardFooter button')");
  await waitFor("Boolean(document.querySelector('.detailPage .reasonBox'))", "public norm detail");
  const desktopMetrics = await evaluate(`({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    heading: document.querySelector('.detailPage h1')?.textContent.trim(),
    reasonVisible: window.__accessSmoke.visible(document.querySelector('.reasonBox')),
  })`);
  assert(desktopMetrics.overflow <= 1, "desktop public detail has no horizontal overflow at 1440x900", desktopMetrics);
  assert(Boolean(desktopMetrics.heading) && desktopMetrics.reasonVisible, "desktop public norm detail renders its heading and reason report", desktopMetrics);
  const contributionCtaMetrics = await evaluate(`(() => {
    const button = document.querySelector('.contributionHeader .primaryButton');
    const parse = (color) => (color.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = (color) => {
      const channels = parse(color).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
    };
    const style = getComputedStyle(button);
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      contrast,
    };
  })()`);
  assert(
    contributionCtaMetrics.backgroundColor === "rgb(215, 25, 63)" && contributionCtaMetrics.contrast >= 4.5,
    "the Návrh změny call-to-action keeps the Sokol red treatment with accessible contrast",
    contributionCtaMetrics,
  );
  const desktopScreenshot = await screenshot("desktop-public-detail-1440x900.png");

  await setViewport(390, 844, true);
  const voteTargetMetrics = await evaluate(`(() => {
    const controls = [...document.querySelectorAll('.needVote button, .voteRow button')]
      .filter(window.__accessSmoke.visible)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { label: button.getAttribute('aria-label') || button.textContent.trim(), width: rect.width, height: rect.height };
      });
    return { controls, undersized: controls.filter((control) => control.width < 43.5 || control.height < 43.5) };
  })()`);
  assert(voteTargetMetrics.controls.length > 0 && voteTargetMetrics.undersized.length === 0, "mobile voting controls provide at least 44x44px targets", voteTargetMetrics);
  await openLogin();
  await setValue('[data-auth-step="identify"] input[name="email"]', "smoke.member@example.cz");
  await clickText(COPY.continue, "[data-auth-step]");
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'register'", "member registration form");
  const registrationMetrics = await evaluate(`(() => {
    const dialog = document.querySelector('[data-auth-step="register"]');
    const grid = dialog.querySelector('.formGrid');
    const rect = dialog.getBoundingClientRect();
    const undersized = [...dialog.querySelectorAll('button, input, select')]
      .filter(window.__accessSmoke.visible)
      .filter((control) => control.getBoundingClientRect().height < 43.5)
      .map((control) => control.name || control.textContent.trim() || control.tagName);
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      gridColumns: getComputedStyle(grid).gridTemplateColumns,
      dialogWithinViewport: rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5,
      undersized,
    };
  })()`);
  assert(registrationMetrics.overflow <= 1, "mobile member registration has no horizontal overflow at 390x844", registrationMetrics);
  assert(registrationMetrics.gridColumns.trim().split(/\s+/).length === 1, "mobile member registration uses a one-column form", registrationMetrics);
  assert(registrationMetrics.dialogWithinViewport, "mobile registration dialog stays inside the viewport", registrationMetrics);
  assert(registrationMetrics.undersized.length === 0, "mobile registration controls are at least 44px high", registrationMetrics);
  await setValue('[data-auth-step="register"] input[name="firstName"]', "Smoke");
  await setValue('[data-auth-step="register"] input[name="lastName"]', "Member");
  await setValue('[data-auth-step="register"] input[name="email"]', "smoke.member@example.cz");
  await setValue('[data-auth-step="register"] input[name="sokolUnit"]', "TJ Sokol Smoke");
  await setValue('[data-auth-step="register"] input[name="membershipId"]', "SMOKE-MEMBER-1");
  await evaluate("window.__accessSmoke.click('[data-auth-step=\"register\"] form button.primaryButton')");
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'member-code'", "member registration code step");
  const codeStepMetrics = await evaluate(`(() => {
    const dialog = document.querySelector('[data-auth-step="member-code"]');
    return {
      codeVisible: window.__accessSmoke.visible(dialog.querySelector('input[name="code"]')),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      undersized: [...dialog.querySelectorAll('button, input, select')]
        .filter(window.__accessSmoke.visible)
        .filter((control) => control.getBoundingClientRect().height < 43.5)
        .map((control) => control.name || control.textContent.trim() || control.tagName),
    };
  })()`);
  assert(codeStepMetrics.codeVisible, "mobile member registration reaches the visible code step", codeStepMetrics);
  assert(codeStepMetrics.overflow <= 1 && codeStepMetrics.undersized.length === 0, "mobile member code-step controls are at least 44px high without horizontal overflow", codeStepMetrics);
  await evaluate("window.__accessSmoke.click('[data-auth-step] .demoInbox button')");
  await waitFor("document.querySelector('[data-auth-step=\"member-code\"] input[name=\"code\"]')?.value.length === 6", "simulated member code insertion");
  await evaluate("window.__accessSmoke.click('[data-auth-step=\"member-code\"] form button.primaryButton')");
  await waitFor("Boolean(document.querySelector('.userMenu.signedIn')) && !document.querySelector('[data-auth-step]')", "completed member registration and login");
  const memberIdentity = await evaluate(`({
    identity: document.querySelector('.userMenu.signedIn .userIdentity strong')?.textContent.trim(),
    adminNavigation: [...document.querySelectorAll('.topbar nav button')]
      .some((button) => ['Administrace', 'Uživatelé'].includes(button.textContent.trim())),
  })`);
  assert(memberIdentity.identity === "Smoke Member" && !memberIdentity.adminNavigation, "verified member is signed in without administrator navigation", memberIdentity);

  const contributionTitle = "Smoke komentář k ověření";
  await evaluate("window.__accessSmoke.click('.contributionHeader button:not(.primaryButton)')");
  await waitFor("Boolean(document.querySelector('.modal[role=\"dialog\"] input[name=\"title\"]'))", "member comment dialog");
  await setValue('.modal[role="dialog"] input[name="section"]', "§ 4 odst. 1");
  await setValue('.modal[role="dialog"] input[name="title"]', contributionTitle);
  await setValue('.modal[role="dialog"] textarea[name="text"]', "Browserový smoke komentář ověřuje propojení registrace a aktivní účasti.");
  await evaluate("window.__accessSmoke.click('.modal[role=\"dialog\"] button.primaryButton')");
  await waitFor(`!document.querySelector('.modal[role="dialog"]') && document.body.textContent.includes(${JSON.stringify(contributionTitle)})`, "member comment publication");
  await evaluate("window.__accessSmoke.click('.needVote button:first-child')");
  await waitFor("document.querySelector('.needVote button:first-child')?.getAttribute('aria-pressed') === 'true'", "member need vote selection");
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.submissionCard')]
      .find((candidate) => candidate.textContent.includes(${JSON.stringify(contributionTitle)}));
    const button = card?.querySelector('.voteRow button[aria-label="↑"]');
    if (!button) throw new Error('Vote control for the smoke contribution was not found.');
    button.click();
  })()`);
  await waitFor(`(() => {
    const card = [...document.querySelectorAll('.submissionCard')]
      .find((candidate) => candidate.textContent.includes(${JSON.stringify(contributionTitle)}));
    return card?.querySelector('.voteRow button[aria-label="↑"]')?.getAttribute('aria-pressed') === 'true';
  })()`, "member contribution vote selection");
  await evaluate("window.__accessSmoke.click('.userMenuActions button:first-child')");
  await waitFor("Boolean(document.querySelector('.memberProfile'))", "member profile");
  const profileMetrics = await evaluate(`({
    identity: document.querySelector('.memberProfileHeading h1')?.textContent.trim(),
    contributionVisible: document.querySelector('#profile-contributions')?.parentElement.textContent.includes(${JSON.stringify(contributionTitle)}),
    voteCount: document.querySelector('#profile-votes')?.parentElement.querySelectorAll('li').length || 0,
    passwordForm: Boolean(document.querySelector('.passwordChange')),
  })`);
  assert(profileMetrics.identity === "Smoke Member" && profileMetrics.contributionVisible && profileMetrics.voteCount >= 2, "member profile lists the published comment and both votes", profileMetrics);
  assert(!profileMetrics.passwordForm, "passwordless member profile does not expose administrator password controls", profileMetrics);
  await logout();

  await loginWithPassword("superadmin@sokol.demo", "SuperSokol!2026", "superadministrator");
  await clickText(COPY.users, ".topbar nav");
  await waitFor("Boolean(document.querySelector('.userAdministration .userTable'))", "superadministrator user table");
  const rowAccessibility = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.userRowButton')]
      .find((candidate) => candidate.textContent.includes('administrator@sokol.demo'));
    return {
      exists: Boolean(button),
      type: button?.getAttribute('type'),
      accessibleText: button?.textContent.replace(/\\s+/g, ' ').trim(),
      height: button?.getBoundingClientRect().height || 0,
    };
  })()`);
  assert(rowAccessibility.exists && rowAccessibility.type === "button", "mobile user rows expose semantic selection buttons", rowAccessibility);
  assert(rowAccessibility.accessibleText.includes("administrator@sokol.demo"), "mobile user-row accessible text identifies the selected account", rowAccessibility);
  await clickText("administrator@sokol.demo", ".userTable", true);
  await waitFor("Boolean(document.querySelector('.userAdministrationLayout.hasDetail .userDetailPanel'))", "mobile selected-user detail");
  const userMetrics = await evaluate(`(() => {
    const table = document.querySelector('.userTableWrap');
    const detail = document.querySelector('.userDetailPanel');
    const tableRect = table.getBoundingClientRect();
    const detailRect = detail.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      tableDisplay: getComputedStyle(table).display,
      detailDisplay: getComputedStyle(detail).display,
      detailBelowTable: detailRect.top >= tableRect.bottom - 1,
      detailLabel: detail.getAttribute('aria-label'),
      rowDisplay: getComputedStyle(document.querySelector('.userTable tbody tr')).display,
    };
  })()`);
  assert(userMetrics.overflow <= 1, "mobile user administration has no horizontal overflow at 390x844", userMetrics);
  assert(userMetrics.tableDisplay !== "none" && userMetrics.detailDisplay !== "none", "mobile keeps the user table and selected detail visible", userMetrics);
  assert(userMetrics.detailBelowTable, "mobile selected-user detail is positioned below the list", userMetrics);
  assert(Boolean(userMetrics.detailLabel) && userMetrics.rowDisplay === "block", "mobile user administration uses accessible detail labeling and stacked rows", userMetrics);
  const detailClip = await evaluate(`(() => {
    const detail = document.querySelector('.userDetailPanel');
    const absoluteTop = window.scrollY + detail.getBoundingClientRect().top;
    const y = Math.max(0, absoluteTop - 90);
    return {
      x: 0,
      y,
      width: 390,
      height: Math.min(844, document.documentElement.scrollHeight - y),
      scale: 1,
    };
  })()`);
  const mobileScreenshot = await screenshot("mobile-user-detail-390x844.png", detailClip);

  const invitedAdminEmail = "smoke.admin@example.cz";
  const invitedAdminPassword = "SmokeAdmin!2026";
  await evaluate("window.__accessSmoke.click('.userAdministrationHeading .primaryButton')");
  await waitFor("Boolean(document.querySelector('#create-user-title'))", "create-administrator dialog");
  await setValue('.modal input[name="firstName"]', "Smoke");
  await setValue('.modal input[name="lastName"]', "Admin");
  await setValue('.modal input[name="email"]', invitedAdminEmail);
  await setValue('.modal input[name="sokolUnit"]', "TJ Sokol Smoke");
  await setValue('.modal input[name="membershipId"]', "SMOKE-ADMIN-1");
  await evaluate("window.__accessSmoke.click('.modal button.primaryButton')");
  await waitFor(`!document.querySelector('#create-user-title') && [...document.querySelectorAll('.userAdministration > .demoInbox li')].some((item) => item.textContent.includes(${JSON.stringify(invitedAdminEmail)}))`, "administrator invitation delivery");
  await evaluate(`(() => {
    const delivery = [...document.querySelectorAll('.userAdministration > .demoInbox li')]
      .find((item) => item.textContent.includes(${JSON.stringify(invitedAdminEmail)}));
    if (!delivery) throw new Error('Smoke administrator setup delivery was not found.');
    delivery.querySelector('button').click();
  })()`);
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'set-password'", "administrator first-password setup");
  await setValue('[data-auth-step="set-password"] input[name="newPassword"]', invitedAdminPassword);
  await evaluate("window.__accessSmoke.click('[data-auth-step=\"set-password\"] form button.primaryButton')");
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'identify'", "administrator first password completion");
  await evaluate("window.__accessSmoke.click('[data-auth-step] .modalClose')");
  await waitFor("!document.querySelector('[data-auth-step]')", "administrator setup dialog close");
  const createdUserMetrics = await evaluate(`({
    rowVisible: [...document.querySelectorAll('.userRowButton')]
      .some((button) => button.textContent.includes(${JSON.stringify(invitedAdminEmail)})),
    columns: [...document.querySelectorAll('.userTable thead th')].map((header) => header.textContent.trim()),
  })`);
  assert(createdUserMetrics.rowVisible && createdUserMetrics.columns.length === 5, "superadministrator creates an administrator and sees the five-column account table", createdUserMetrics);

  const foreignNormTitle = "Smoke norma vlastněná superadministrátorem";
  await clickText(COPY.administration, ".topbar nav");
  await waitFor("Boolean(document.querySelector('.adminPage .adminHeading .primaryButton'))", "superadministrator norm administration");
  await evaluate("window.__accessSmoke.click('.adminPage .adminHeading .primaryButton')");
  await waitFor("Boolean(document.querySelector('#create-norm-dialog-title'))", "create-norm dialog");
  await setValue('.wideModal input[name="title"]', foreignNormTitle);
  await setValue('.wideModal input[name="category"]', "Směrnice");
  await setValue('.wideModal input[name="submittedBy"]', "Superadministrátor Smoke");
  await setValue('.wideModal input[name="responsible"]', "Kancelář ČOS");
  await setValue('.wideModal select[name="status"]', "K připomínkování");
  await setValue('.wideModal input[name="deadline"]', "2026-12-31");
  await setValue('.wideModal textarea[name="summary"]', "Veřejný materiál pro ověření vlastnického omezení administrátora.");
  await setValue('.wideModal textarea[name="reason"]', "Tato norma vznikla pouze uvnitř izolovaného browserového smoke testu.");
  await evaluate("window.__accessSmoke.click('.wideModal button.primaryButton')");
  await waitFor(`!document.querySelector('#create-norm-dialog-title') && document.querySelector('.adminWorkspace h2')?.textContent.trim() === ${JSON.stringify(foreignNormTitle)}`, "superadministrator-owned norm creation");
  assert(await evaluate(`document.querySelector('.adminWorkspace h2')?.textContent.trim() === ${JSON.stringify(foreignNormTitle)}`), "superadministrator can create and immediately manage a numbered norm");
  await logout();

  await loginWithPassword(invitedAdminEmail, invitedAdminPassword, "new administrator");
  await clickText(COPY.administration, ".topbar nav");
  await waitFor(`document.querySelector('.adminPage h1')?.textContent.trim() === ${JSON.stringify(COPY.myNorms)}`, "new administrator workspace");
  const foreignNormWorkspace = await evaluate(`({
    manageableCount: document.querySelectorAll('.adminNormList > button').length,
    foreignTitlePresent: document.querySelector('.adminPage')?.textContent.includes(${JSON.stringify(foreignNormTitle)}),
    usersNavigationPresent: [...document.querySelectorAll('.topbar nav button')]
      .some((button) => button.textContent.trim() === ${JSON.stringify(COPY.users)}),
  })`);
  assert(foreignNormWorkspace.manageableCount === 0 && !foreignNormWorkspace.foreignTitlePresent, "new administrator cannot see the superadministrator-owned norm in Moje normy", foreignNormWorkspace);
  assert(!foreignNormWorkspace.usersNavigationPresent, "new administrator cannot access superadministrator user management", foreignNormWorkspace);
  await clickText("Normy", ".topbar nav");
  await waitFor(`[...document.querySelectorAll('.normCard')].some((card) => card.textContent.includes(${JSON.stringify(foreignNormTitle)}))`, "foreign norm in public catalog");
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.normCard')]
      .find((candidate) => candidate.textContent.includes(${JSON.stringify(foreignNormTitle)}));
    if (!card) throw new Error('Foreign smoke norm was not found in the public catalog.');
    card.querySelector('.cardFooter button').click();
  })()`);
  await waitFor(`document.querySelector('.detailPage h1')?.textContent.trim() === ${JSON.stringify(foreignNormTitle)}`, "foreign norm public detail");
  const foreignNormDetail = await evaluate(`({
    title: document.querySelector('.detailPage h1')?.textContent.trim(),
    manageControl: [...document.querySelectorAll('.detailActions button')]
      .some((button) => button.textContent.trim() === 'Spravovat'),
    replyForms: document.querySelectorAll('.replyForm').length,
  })`);
  assert(!foreignNormDetail.manageControl && foreignNormDetail.replyForms === 0, "administrator cannot manage or answer contributions on another owner's public norm", foreignNormDetail);
  await logout();

  await loginWithPassword("administrator@sokol.demo", "AdminSokol!2026", "administrator");
  await clickText(COPY.administration, ".topbar nav");
  await waitFor(`document.querySelector('.adminPage h1')?.textContent.trim() === ${JSON.stringify(COPY.myNorms)}`, "administrator owned-norm workspace");
  const adminMetrics = await evaluate(`(() => {
    const layout = document.querySelector('.adminLayout');
    const list = document.querySelector('.adminNormList');
    const workspace = document.querySelector('.adminWorkspace');
    const listRect = list.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      heading: document.querySelector('.adminPage h1')?.textContent.trim(),
      manageableCount: list.querySelectorAll('button').length,
      activeCount: list.querySelectorAll('button.active').length,
      workspaceVisible: window.__accessSmoke.visible(workspace),
      workspaceBelowList: workspaceRect.top >= listRect.bottom - 1,
      usersNavigationPresent: [...document.querySelectorAll('.topbar nav button')]
        .some((button) => button.textContent.trim() === ${JSON.stringify(COPY.users)}),
    };
  })()`);
  assert(adminMetrics.overflow <= 1, "mobile administrator workspace has no horizontal overflow at 390x844", adminMetrics);
  assert(adminMetrics.heading === COPY.myNorms && adminMetrics.manageableCount > 0 && adminMetrics.activeCount === 1, "administrator sees an owned, selected norm in Moje normy", adminMetrics);
  assert(adminMetrics.workspaceVisible && adminMetrics.workspaceBelowList, "mobile owned-norm workspace is visible below its norm list", adminMetrics);
  assert(!adminMetrics.usersNavigationPresent, "administrator has no superadministrator user-management navigation", adminMetrics);
  assert(!(await evaluate(`document.querySelector('.adminPage')?.textContent.includes(${JSON.stringify(foreignNormTitle)})`)), "seed administrator workspace excludes the superadministrator-owned norm");
  await logout();

  const resetPassword = "AdminReset!2026";
  await openLogin();
  await setValue('[data-auth-step="identify"] input[name="email"]', "administrator@sokol.demo");
  await clickText(COPY.continue, "[data-auth-step]");
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'password'", "password-reset account identification");
  await clickText("Zapomenuté heslo", "[data-auth-step]");
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'forgot-password'", "password-reset request form");
  await evaluate("window.__accessSmoke.click('[data-auth-step=\"forgot-password\"] form button.primaryButton')");
  await waitFor("Boolean(document.querySelector('[data-auth-step=\"forgot-password\"] .demoInbox button'))", "password-reset demo delivery");
  await evaluate("window.__accessSmoke.click('[data-auth-step=\"forgot-password\"] .demoInbox button')");
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'set-password'", "password-reset link opening");
  await setValue('[data-auth-step="set-password"] input[name="newPassword"]', resetPassword);
  await evaluate("window.__accessSmoke.click('[data-auth-step=\"set-password\"] form button.primaryButton')");
  await waitFor("document.querySelector('[data-auth-step]')?.dataset.authStep === 'password'", "password-reset completion");
  await setValue('[data-auth-step="password"] input[name="password"]', "AdminSokol!2026");
  await evaluate("window.__accessSmoke.click('[data-auth-step=\"password\"] form button.primaryButton')");
  await waitFor("Boolean(document.querySelector('[data-auth-step=\"password\"] .authError'))", "old password rejection after reset");
  const oldPasswordMetrics = await evaluate(`({
    signedIn: Boolean(document.querySelector('.userMenu.signedIn')),
    error: document.querySelector('[data-auth-step="password"] .authError')?.textContent.trim(),
  })`);
  assert(!oldPasswordMetrics.signedIn && Boolean(oldPasswordMetrics.error), "old administrator password is rejected after UI reset", oldPasswordMetrics);
  await setValue('[data-auth-step="password"] input[name="password"]', resetPassword);
  await evaluate("window.__accessSmoke.click('[data-auth-step=\"password\"] form button.primaryButton')");
  await waitFor("Boolean(document.querySelector('.userMenu.signedIn')) && !document.querySelector('[data-auth-step]')", "new password login after reset");
  assert(await evaluate("document.querySelector('.userMenu.signedIn .userIdentity small')?.textContent.trim() === 'Administrátor'"), "administrator signs in with the new password after UI reset");
  await logout();

  assert(browserErrors.length === 0, "real-browser workflows emit no runtime exceptions or console errors", browserErrors);
  assert(resourceErrors.length === 0, "real-browser workflows load all requested resources without HTTP errors", resourceErrors);
  return {
    assertions,
    browserErrors,
    resourceErrors,
    screenshots: [desktopScreenshot, mobileScreenshot],
  };
}

async function stopProcessTree(child, label) {
  if (!child?.pid || child.exitCode !== null) return;
  mark(`Stopping ${label} PID ${child.pid}`);
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true, stdio: "ignore" });
    await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), sleep(1_500)]);
    if (child.exitCode === null) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
  } else {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), sleep(1_500)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

function removeOwnedVinextLock() {
  const lockPath = resolve(PROJECT_ROOT, ".vinext", "dev", "lock.json");
  if (!existsSync(lockPath)) return;
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return;
  }
  if (resolve(lock.cwd || "") !== PROJECT_ROOT || Number(lock.port) !== APP_PORT) return;
  rmSync(lockPath);
  for (const directory of [dirname(lockPath), dirname(dirname(lockPath))]) {
    if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
  }
}

function removeChromeProfile() {
  if (!chromeProfile) return;
  const expectedRoot = resolve(tmpdir());
  if (resolve(dirname(chromeProfile)) !== expectedRoot || !basename(chromeProfile).startsWith(PROFILE_PREFIX)) {
    throw new Error(`Refusing to remove unexpected Chrome profile path: ${chromeProfile}`);
  }
  rmSync(chromeProfile, { recursive: true, force: true });
}

async function cleanup() {
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  await stopProcessTree(chromeProcess, "Chrome");
  await stopProcessTree(devProcess, "Vinext");
  removeOwnedVinextLock();
  removeChromeProfile();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await isPortFree(APP_HOST, APP_PORT)) && (await isPortFree(CDP_HOST, CDP_PORT))) {
      mark("Exact PID trees, ports, and temporary Chrome profile cleaned up");
      return;
    }
    await sleep(100);
  }
  throw new Error(`Smoke cleanup did not release ports ${APP_PORT} and ${CDP_PORT}.`);
}

async function run() {
  assert(Number.isInteger(APP_PORT) && APP_PORT > 0 && APP_PORT < 65_536, "application smoke port is valid", APP_PORT);
  assert(Number.isInteger(CDP_PORT) && CDP_PORT > 0 && CDP_PORT < 65_536, "Chrome debugging port is valid", CDP_PORT);
  assert(APP_PORT !== CDP_PORT, "application and Chrome debugging ports are distinct");
  assert(await isPortFree(APP_HOST, APP_PORT), `application port ${APP_PORT} is free before launch`);
  assert(await isPortFree(CDP_HOST, CDP_PORT), `Chrome debugging port ${CDP_PORT} is free before launch`);
  startDevServer();
  await waitForHttp();
  mark(`Vinext ready at ${APP_URL}`);
  startChrome();
  await connectCdp();
  return runBrowserWorkflows();
}

let result;
let failure;
const watchdog = setTimeout(() => {
  abortController.abort(new Error(`Smoke exceeded its ${OVERALL_TIMEOUT_MS}ms bound.`));
}, OVERALL_TIMEOUT_MS);
watchdog.unref();
abortController.signal.addEventListener("abort", () => {
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
}, { once: true });

try {
  result = await run();
} catch (error) {
  failure = error;
} finally {
  clearTimeout(watchdog);
  try {
    await cleanup();
  } catch (cleanupError) {
    failure ||= cleanupError;
  }
}

if (failure) {
  process.stderr.write(`[smoke:access] FAIL ${failure.stack || failure.message}\n`);
  if (devOutput.length) process.stderr.write(`[smoke:access] Vinext tail:\n${devOutput.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ status: "passed", ...result }, null, 2)}\n`);
}

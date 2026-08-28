import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";

const appUrl = process.env.PILOT_UI_URL ?? "http://127.0.0.1:3000";
const cdpPort = Number(process.env.PILOT_UI_CDP_PORT ?? 9336);
const cdpUrl = `http://127.0.0.1:${cdpPort}`;
const profilePrefix = "sokol-local-pilot-ui-";
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
let chrome;
let profile;
let socket;
let sequence = 0;
const pending = new Map();
const browserErrors = [];
const resourceErrors = [];
const requests = new Map();

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === "win32" && join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "win32" && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "linux" && "/usr/bin/google-chrome",
  ].filter(Boolean);
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error("Google Chrome was not found.");
  return executable;
}

async function waitUntil(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function connect() {
  await waitUntil(async () => {
    try {
      const response = await fetch(`${cdpUrl}/json/list`);
      return response.ok;
    } catch {
      return false;
    }
  }, "Chrome CDP");
  const targets = await fetch(`${cdpUrl}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === "page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", rejectPromise, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id);
      message.error ? command.reject(new Error(message.error.message)) : command.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      browserErrors.push(message.params.exceptionDetails.text);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      browserErrors.push(message.params.args.map((argument) => argument.value ?? argument.description ?? "").join(" "));
    }
    if (message.method === "Network.requestWillBeSent") {
      requests.set(message.params.requestId, message.params.request.url);
    }
    if (message.method === "Network.loadingFailed" && !message.params.canceled) {
      resourceErrors.push(`${message.params.errorText} ${message.params.type} ${requests.get(message.params.requestId) ?? "unknown-url"}`);
    }
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400) {
      resourceErrors.push(`${message.params.response.status} ${message.params.response.url}`);
    }
  });
}

function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function run() {
  const ready = await fetch(`${appUrl}/api/health/ready`);
  if (!ready.ok) throw new Error(`Pilot readiness returned ${ready.status}.`);
  profile = mkdtempSync(join(tmpdir(), profilePrefix));
  chrome = spawn(findChrome(), [
    "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  await connect();
  await Promise.all(["Page.enable", "Runtime.enable", "Network.enable"].map((method) => send(method)));
  await send("Page.navigate", { url: appUrl });
  await waitUntil(() => evaluate("document.readyState === 'complete'"), "page load");
  await waitUntil(() => evaluate("[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Přihlásit')"), "login button");
  await waitUntil(() => evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim() === 'Přihlásit');
    return Boolean(button && Object.keys(button).some((key) => key.startsWith('__reactProps$')));
  })()`), "React hydration of the login button");
  try {
    await waitUntil(() => evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent.trim() === 'Přihlásit');
      return Boolean(button && !button.disabled);
    })()`), "application initialization");
  } catch (error) {
    const requestCounts = [...requests.values()].reduce((counts, url) => {
      counts[url] = (counts[url] ?? 0) + 1;
      return counts;
    }, {});
    const pageState = await evaluate(`(() => ({
      text: document.body.innerText.slice(-500),
      loginDisabled: [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent.trim() === 'Přihlásit')?.disabled,
      retryVisible: [...document.querySelectorAll('button')]
        .some((candidate) => candidate.textContent.trim() === 'Zkusit znovu')
    }))()`);
    throw new Error(`${error.message} ${JSON.stringify({
      pageState,
      browserErrors: [...new Set(browserErrors)].slice(0, 20),
      resourceErrors: [...new Set(resourceErrors)].slice(0, 20),
      requestCount: requests.size,
      requestCounts,
      requests: [...new Set(requests.values())].slice(-30),
    })}`);
  }
  const bootstrap = await evaluate("fetch('/api/bootstrap').then(async (response) => ({ status: response.status, body: await response.json() }))");
  if (bootstrap.status !== 200) throw new Error(`Browser bootstrap returned ${bootstrap.status}.`);
  await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Přihlásit').click()");
  await waitUntil(() => evaluate("Boolean(document.querySelector('[role=dialog]'))"), "login dialog");
  const failedToast = await evaluate("document.body.innerText.includes('Failed to fetch')");
  if (failedToast) throw new Error("The browser still displays Failed to fetch.");
  const uniqueBrowserErrors = [...new Set(browserErrors)];
  const uniqueResourceErrors = [...new Set(resourceErrors)];
  if (uniqueBrowserErrors.length || uniqueResourceErrors.length) {
    throw new Error(`Browser errors: ${JSON.stringify({
      browserErrors: uniqueBrowserErrors.slice(0, 20),
      resourceErrors: uniqueResourceErrors.slice(0, 20),
      resourceErrorCount: resourceErrors.length,
    })}`);
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", bootstrap: 200, loginDialog: true, browserErrors: uniqueBrowserErrors, resourceErrors: uniqueResourceErrors })}\n`);
}

try {
  await run();
} finally {
  if (socket?.readyState <= WebSocket.OPEN) socket.close();
  if (chrome?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else chrome.kill("SIGTERM");
    await sleep(500);
  }
  if (profile) {
    const root = resolve(tmpdir());
    if (resolve(dirname(profile)) !== root || !basename(profile).startsWith(profilePrefix)) {
      throw new Error(`Refusing to remove unexpected Chrome profile: ${profile}`);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

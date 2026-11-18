import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { AttachEndpoint } from "../../manager/dist/attach-endpoint.js";

const characterize = process.argv.includes("--characterize");
let passed = 0;
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  passed++;
  console.log(`PASS ${name}`);
};
const browser = (process.env.PATH ?? "").split(delimiter).flatMap((dir) =>
  ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].map((name) => join(dir, name))).find(existsSync);
assert(browser, "a Chromium-family browser is required, with no substitute");
const profile = mkdtempSync(join(tmpdir(), "console-browser-"));
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const brokerPort = await freePort();
const server = `nats://127.0.0.1:${brokerPort}`;
const space = "browsersecurity";
const broker = spawn("nats-server", ["-p", String(brokerPort), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let chrome: ChildProcess | undefined;
let dashboard: ChildProcess | undefined;
let seed: CotalEndpoint | undefined;
let manager: AttachEndpoint | undefined;
let resolveReferrer: ((value: string | undefined) => void) | undefined;
const sink = createServer((req, res) => { if (req.url === "/destination") resolveReferrer?.(req.headers.referer); res.end("arrived"); });
let sequence = 0;
let wire = "";
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
const responses: { session?: string; status: number; type: string }[] = [];
const failures: { session?: string; blocked?: string }[] = [];
let dashboardOutput = "";
const managerOutput: string[] = [];
const originalError = console.error;
const originalLog = console.log;
console.error = (...values: unknown[]) => { managerOutput.push(values.map(String).join(" ")); };

async function cdp(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`browser command timed out: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    (chrome!.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}
async function evaluate(session: string, expression: string): Promise<any> {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  assert(!result.exceptionDetails, "browser probe must execute without an exception");
  return result.result?.value;
}
async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(label);
}
async function page(url: string): Promise<string> {
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Network.enable", {}, sessionId);
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__security = { violations: [], errors: [] };
    addEventListener('securitypolicyviolation', e => window.__security.violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
    addEventListener('error', () => window.__security.errors.push('page error'));
    addEventListener('unhandledrejection', () => window.__security.errors.push('unhandled rejection'));
  ` }, sessionId);
  await cdp("Page.navigate", { url }, sessionId);
  return sessionId;
}
async function security(name: string, session: string, token: string, base: string, ready: string): Promise<void> {
  await until(() => evaluate(session, ready), `${name} page must render its live data`);
  await evaluate(session, "document.fonts.ready.then(() => true)");
  await delay(300);
  check(`${name}: shipped scripts, styles and live data render`, await evaluate(session, ready));
  if (!characterize && name.startsWith("manager")) {
    await cdp("Page.reload", {}, session);
    await until(() => evaluate(session, ready), `${name}: reload retains authorized access`);
    check(`${name}: a clean-address reload retains authorized access`, await evaluate(session, ready));
    check(`${name}: unrelated query fields survive cleanup`, await evaluate(session, "new URL(location.href).searchParams.get('view') === 'console'"));
    check(`${name}: the terminal loads and renders the unavailable-session response`, await evaluate(session, "document.querySelector('.pane .name')?.textContent === 'terminal-control' && document.querySelector('.xterm') !== null"));
  }
  check(`${name}: no application asset is blocked by CSP`, (await evaluate(session, "window.__security.violations")).length === 0 && !failures.some((f) => f.session === session && f.blocked === "csp"));
  check(`${name}: page has no uncaught script error`, (await evaluate(session, "window.__security.errors")).length === 0);
  check(`${name}: script and stylesheet requests succeed`, responses.some((r) => r.session === session && r.type === "Script") && responses.some((r) => r.session === session && r.type === "Stylesheet") && responses.filter((r) => r.session === session && ["Script", "Stylesheet", "Font"].includes(r.type)).every((r) => r.status === 200));
  const clean = await evaluate(session, `!location.href.includes(${JSON.stringify(token)})`);
  check(`${name}: address bar ${characterize && name.startsWith("manager") ? "retains the bootstrap token before hardening" : "contains no bootstrap token"}`, characterize && name.startsWith("manager") ? !clean : clean);
  const injected = await evaluate(session, `(() => { const s = document.createElement('script'); s.textContent = 'window.__injectedConsoleScript = true'; document.head.append(s); return window.__injectedConsoleScript === true; })()`);
  await delay(100);
  check(`${name}: unrelated inline script ${characterize ? "executes without a policy" : "is refused by CSP"}`, characterize ? injected : !injected);
  check(`${name}: inline-script control ${characterize ? "has no CSP violation" : "reports a script-src violation"}`, await evaluate(session, characterize ? "window.__security.violations.length === 0" : "window.__security.violations.some(v => v.blocked === 'inline' && v.directive === 'script-src-elem')"));
  const seen = new Promise<string | undefined>((resolve) => { resolveReferrer = resolve; });
  const destination = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/destination`;
  await evaluate(session, `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(destination)}; a.textContent = 'outside'; document.body.append(a); a.click(); return true; })()`);
  const referer = await Promise.race([seen, delay(10_000).then(() => { throw new Error("cross-origin navigation must reach the sink"); })]);
  check(`${name}: cross-origin Referer contains no token`, !referer?.includes(token));
  if (characterize) console.log(`OBSERVED ${name}: cross-origin Referer ${referer === undefined ? "absent" : referer === base + "/" ? "origin only" : "present without token"}`);
  check(`${name}: ${characterize ? "default browser policy withholds the credential" : "no-referrer omits the Referer header"}`, characterize ? !referer?.includes(token) : referer === undefined);
}

try {
  for (let i = 0; !(await isReachable(server)); i++) { assert(i < 100, "private broker starts"); await delay(100); }
  await setupSpaceStreams({ servers: server, space });
  seed = new CotalEndpoint({ space, servers: server, channels: ["general"], consume: false, card: { id: newIdentity().id, name: "browser-control", kind: "endpoint" } });
  seed.on("error", () => {});
  await seed.start();
  await seed.multicast("browser-live-control", { channel: "general" });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const token = randomBytes(32).toString("hex");
  manager = new AttachEndpoint(() => [{ name: "terminal-control", id: "local.terminal", space, status: "running" }], () => [], 0, undefined, "127.0.0.1", token);
  await manager.start();
  const managerBase = new URL(manager.consoleUrl()).origin;
  const port = await freePort();
  dashboard = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./openapi-server.ts", import.meta.url)), server, space, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  dashboard.stdout!.on("data", (data: Buffer) => { dashboardOutput += data.toString(); });
  dashboard.stderr!.on("data", (data: Buffer) => { dashboardOutput += data.toString(); });
  let launchUrl: string | undefined;
  await until(async () => {
    for (const line of dashboardOutput.split("\n")) {
      if (!line.startsWith('{"ready":')) continue;
      launchUrl = JSON.parse(line).launchUrl;
    }
    return launchUrl !== undefined;
  }, "dashboard starts without printing its private launch credential in an operator log");
  assert(launchUrl);
  const dashboardToken = new URL(launchUrl).searchParams.get("k")!;
  const dashboardBase = new URL(launchUrl).origin;
  chrome = spawn(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  (chrome.stdio[4] as Readable).on("data", (data: Buffer) => {
    wire += data.toString();
    for (let end; (end = wire.indexOf("\0")) !== -1;) {
      const message = JSON.parse(wire.slice(0, end)); wire = wire.slice(end + 1);
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) continue;
        clearTimeout(entry.timer); pending.delete(message.id);
        if (message.error) entry.reject(new Error("browser protocol refused a command")); else entry.resolve(message.result);
      } else if (message.method === "Network.responseReceived") {
        responses.push({ session: message.sessionId, status: message.params.response.status, type: message.params.type });
      } else if (message.method === "Network.loadingFailed") {
        failures.push({ session: message.sessionId, blocked: message.params.blockedReason });
      }
    }
  });
  for (const suffix of [`#t=${token}`, `?t=${token}`]) {
    const session = await page(managerBase + "/?view=console" + (suffix.startsWith("?") ? "&" + suffix.slice(1) : suffix));
    await security(suffix.startsWith("#") ? "manager fragment" : "manager query", session, token, managerBase, "document.getElementById('meta')?.textContent?.startsWith('1 agent') === true && document.querySelector('.xterm-rows')?.textContent?.includes('attach failed (503)') === true");
  }
  const dashboardPage = await page(launchUrl + "#/channel/general");
  await security("dashboard", dashboardPage, dashboardToken, dashboardBase, "document.getElementById('root')?.textContent?.includes('browser-live-control') === true");
  const sessionCookie = await cdp("Network.getCookies", { urls: [dashboardBase] }, dashboardPage);
  const cookie = sessionCookie.cookies.find((c: { name: string }) => c.name === "cotal_web_session");
  check("dashboard: existing query launch link still mints an HttpOnly session cookie", cookie?.httpOnly === true);
  const html = await fetch(dashboardBase, { headers: { cookie: `cotal_web_session=${cookie.value}` } });
  const managerHtml = await fetch(managerBase);
  for (const [name, response] of [["dashboard", html], ["manager", managerHtml]] as const) {
    check(`${name}: Content-Security-Policy ${characterize ? "is absent before hardening" : "restricts scripts to its own origin"}`, characterize ? response.headers.get("content-security-policy") === null : response.headers.get("content-security-policy")?.includes("script-src 'self'") && !response.headers.get("content-security-policy")?.includes("unsafe-eval"));
    check(`${name}: Referrer-Policy ${characterize && name === "dashboard" ? "is absent before hardening" : "is no-referrer"}`, response.headers.get("referrer-policy") === (characterize && name === "dashboard" ? null : "no-referrer"));
    check(`${name}: X-Content-Type-Options ${characterize ? "is absent before hardening" : "is nosniff"}`, response.headers.get("x-content-type-options") === (characterize ? null : "nosniff"));
  }
  const refused = await fetch(dashboardBase + "/api/roster?k=" + dashboardToken, { method: "POST", headers: { cookie: `cotal_web_session=${cookie.value}` }, body: "body-control" });
  check("dashboard: an authenticated malformed request exercises the server diagnostic path", refused.status === 413);
  await delay(150);
  const diagnostics = dashboardOutput.split("\n").filter((line) => !line.startsWith('{"ready":'));
  check("dashboard: server diagnostics omit the launch token", diagnostics.some((line) => line.includes("request refused")) && diagnostics.every((line) => !line.includes(dashboardToken)));
  check("manager: server writes no token-bearing diagnostic for page or authorized data requests", managerOutput.every((line) => !line.includes(token)));
  check("dashboard: the spent documented launch link refuses a second session", (await fetch(launchUrl, { redirect: "manual" })).status === 401);
  console.log(`browser security: ${passed} checks passed (${characterize ? "characterization" : "regression"})`);
  emitSentinel({ passed, failed: 0 });
} finally {
  console.error = originalError;
  console.log = originalLog;
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (chrome) await killAndAwaitExit(chrome);
  if (dashboard) await killAndAwaitExit(dashboard);
  await manager?.stop();
  sink.closeAllConnections();
  await new Promise<void>((resolve) => sink.close(() => resolve()));
  await seed?.stop();
  await killAndAwaitExit(broker);
  release();
  rmSync(profile, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
}

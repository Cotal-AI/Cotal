import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { emitSentinel, freePort, killAndAwaitExit, skipSuite, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { AttachEndpoint } from "../../implementations/manager/dist/attach-endpoint.js";

const DASHBOARD_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MANAGER_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
let passed = 0;
let failed = 0;
const check = (name: string, condition: unknown) => {
  if (condition) passed++; else failed++;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};
// Extra stdio slots are POSIX file descriptors, not Chromium's named Windows pipe handles.
if (process.platform === "win32") skipSuite("console browser security requires POSIX Chromium debugging pipes; Windows handle transport is not implemented");
const browser = (() => {
  const named = process.env.COTAL_SMOKE_BROWSER;
  if (named) {
    if (!existsSync(named)) throw new Error("COTAL_SMOKE_BROWSER names no file");
    return named;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of ["chrome-headless-shell", "chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  throw new Error("no Chromium-family browser on PATH and COTAL_SMOKE_BROWSER is unset; console browser security requires a real browser and has no substitute");
})();
const frame = Buffer.from('{"value":"界🙂"}\0');
const splitDecoder = new StringDecoder("utf8");
let decoded = "";
for (const byte of frame) decoded += splitDecoder.write(Buffer.from([byte]));
decoded += splitDecoder.end();
check("browser pipe: split multi-byte UTF-8 frame decodes without corruption", decoded === frame.toString("utf8"));
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

function securityHeaders(name: string, response: Response, policy: string): void {
  check(`${name}: complete Content-Security-Policy matches exactly`, response.headers.get("content-security-policy") === policy);
  check(`${name}: Referrer-Policy is no-referrer`, response.headers.get("referrer-policy") === "no-referrer");
  check(`${name}: X-Content-Type-Options is nosniff`, response.headers.get("x-content-type-options") === "nosniff");
}

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
  check(`${name}: first load has no application CSP violation`, (await evaluate(session, "window.__security.violations")).length === 0 && !failures.some((f) => f.session === session && f.blocked === "csp"));
  if (name.startsWith("manager")) {
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
  check(`${name}: address bar contains no bootstrap token`, clean);
  const injected = await evaluate(session, `(() => { const s = document.createElement('script'); s.textContent = 'window.__injectedConsoleScript = true'; document.head.append(s); return window.__injectedConsoleScript === true; })()`);
  await delay(100);
  check(`${name}: unrelated inline script is refused by CSP`, !injected);
  check(`${name}: inline-script control reports a script-src violation`, await evaluate(session, "window.__security.violations.some(v => v.blocked === 'inline' && v.directive === 'script-src-elem')"));
  // The manager's no-referrer header predates this change. Its emitted value is checked below.
  // Only the dashboard's new navigation policy is an enforcement control here.
  if (name.startsWith("manager")) return;
  const seen = new Promise<string | undefined>((resolve) => { resolveReferrer = resolve; });
  const destination = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/destination`;
  await evaluate(session, `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(destination)}; a.textContent = 'outside'; document.body.append(a); a.click(); return true; })()`);
  const referer = await Promise.race([seen, delay(10_000).then(() => { throw new Error("cross-origin navigation must reach the sink"); })]);
  check(`${name}: cross-origin Referer contains no token`, !referer?.includes(token));
  check(`${name}: no-referrer omits the Referer header`, referer === undefined);
  check(`${name}: navigation to a different origin completes`, new URL(destination).origin !== base);
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
  dashboard = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../implementations/web/smoke/console-security-server.ts", import.meta.url)), server, space, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  dashboard.stdout!.on("data", (data: Buffer) => { dashboardOutput += data.toString(); });
  dashboard.stderr!.on("data", (data: Buffer) => { dashboardOutput += data.toString(); });
  let launchUrl: string | undefined;
  let launchNonce: string | undefined;
  await until(async () => {
    for (const line of dashboardOutput.split("\n")) {
      if (!line.startsWith('{"ready":')) continue;
      const record = JSON.parse(line);
      launchUrl = record.launchUrl;
      launchNonce = record.launchNonce;
    }
    return launchUrl !== undefined;
  }, "dashboard starts without printing its private launch credential in an operator log");
  assert(launchUrl && launchNonce);
  const dashboardToken = new URL(launchUrl).searchParams.get("k")!;
  const dashboardBase = new URL(launchUrl).origin;
  chrome = spawn(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: true });
  const decoder = new StringDecoder("utf8");
  (chrome.stdio[4] as Readable).on("data", (data: Buffer) => {
    wire += decoder.write(data);
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
  const exchange = await fetch(launchUrl, { redirect: "manual" });
  check("dashboard exchange: documented query link returns 302", exchange.status === 302);
  securityHeaders("dashboard exchange", exchange, DASHBOARD_POLICY);
  const exchangeCookie = exchange.headers.get("set-cookie")?.split(";")[0];
  assert(exchangeCookie, "exchange sets the browser session");
  const browserLaunch = await fetch(dashboardBase + "/api/browser-launch", { method: "POST", headers: { "x-cotal-browser-launch": launchNonce } });
  check("dashboard initial browser-launch: authenticated launch request succeeds", browserLaunch.status === 200);
  securityHeaders("dashboard initial browser-launch", browserLaunch, DASHBOARD_POLICY);
  const browserLaunchUrl = (await browserLaunch.json() as { launchUrl: string }).launchUrl;
  const browserToken = new URL(browserLaunchUrl).searchParams.get("k")!;
  const dashboardPage = await page(browserLaunchUrl + "#/channel/general");
  await security("dashboard", dashboardPage, browserToken, dashboardBase, "document.getElementById('root')?.textContent?.includes('browser-live-control') === true");
  const sessionCookie = await cdp("Network.getCookies", { urls: [dashboardBase] }, dashboardPage);
  const cookie = sessionCookie.cookies.find((c: { name: string }) => c.name === "cotal_web_session");
  check("dashboard: existing query launch link still mints an HttpOnly session cookie", cookie?.httpOnly === true);
  const headers = { cookie: `cotal_web_session=${cookie.value}` };
  securityHeaders("dashboard HTML", await fetch(dashboardBase, { headers }), DASHBOARD_POLICY);
  securityHeaders("manager HTML", await fetch(managerBase), MANAGER_POLICY);
  for (const [name, base, options, paths] of [
    ["dashboard", dashboardBase, { headers }, [["JSON", "/api/roster", 200], ["asset", "/theme-boot.js", 200], ["404", "/missing-security-resource", 404]]],
    ["manager", managerBase, { headers: { authorization: `Bearer ${token}` } }, [["JSON", "/agents", 200], ["asset", "/assets/xterm.js", 200], ["404", "/missing-security-resource", 404]]],
  ] as const) {
    for (const [kind, path, status] of paths) {
      const response = await fetch(base + path, options);
      check(`${name} ${kind}: response has the expected status`, response.status === status);
      check(`${name} ${kind}: X-Content-Type-Options is nosniff`, response.headers.get("x-content-type-options") === "nosniff");
      await response.arrayBuffer();
    }
  }
  const launch = await fetch(dashboardBase + "/api/browser-launch", { method: "POST", headers: { "x-cotal-browser-launch": launchNonce } });
  check("dashboard browser-launch: authenticated launch request succeeds", launch.status === 200);
  securityHeaders("dashboard browser-launch", launch, DASHBOARD_POLICY);
  const nextLaunch = (await launch.json() as { launchUrl: string }).launchUrl;
  check("dashboard browser-launch: returns a new same-origin single-use link", new URL(nextLaunch).origin === dashboardBase && new URL(nextLaunch).searchParams.get("k") !== dashboardToken);
  const nextExchange = await fetch(nextLaunch, { redirect: "manual" });
  check("dashboard browser-launch: fresh link exchanges successfully", nextExchange.status === 302);
  securityHeaders("dashboard renewed exchange", nextExchange, DASHBOARD_POLICY);
  check("dashboard browser-launch: new link refuses replay", (await fetch(nextLaunch, { redirect: "manual" })).status === 401);
  check("dashboard: the spent documented launch link refuses a second session", (await fetch(launchUrl, { redirect: "manual" })).status === 401);
  console.log(`browser security: ${passed} passed, ${failed} failed`);
  emitSentinel({ passed, failed });
  process.exitCode = failed ? 1 : 0;
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  // A wrapper script such as Debian's chromium-headless-shell runs the browser as its child, which
  // outlives a signal to the wrapper and holds the debugging pipes open, so end the whole group.
  if (chrome?.pid !== undefined) try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* already gone */ }
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

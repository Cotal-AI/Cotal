import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [binary, node, frontend] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.ok(process.env.DISPLAY && process.env.DBUS_SESSION_BUS_ADDRESS, "run under a disposable X server and D-Bus session");
assert.ok(binary && node && frontend, "pass the debug native app, Node sidecar and built renderer directory");
const root = mkdtempSync(join(tmpdir(), "cotal-native-conflicts-"));
const home = join(root, "home");
const bin = join(root, "bin");
const app = join(bin, "cotal-desktop");
const trace = join(home, "requests.jsonl");
const assets = resolve(frontend);
for (const dir of [home, bin]) mkdirSync(dir, { mode: 0o700 });
copyFileSync(binary, app);
copyFileSync(node, join(bin, "cotal-node"));

// The fixture is behind the native stdin bridge. The webview uses the real Tauri command,
// closed Rust request type, validation, serialization, and sidecar spawn for every click.
function fixture() {
  const { appendFileSync, readFileSync, existsSync } = require("node:fs");
  const { join } = require("node:path");
  const readline = require("node:readline");
  const from = "https://cloud.cotal.ai/api/auth", to = "https://cotal.cloud/api/auth";
  const status = { state: "ready", version: "0.183.1", managers: [], agents: [] };
  const traceFile = join(process.env.HOME, "requests.jsonl");
  const row = (space, idp) => ({ space, label: space, mode: "user", idp, kind: "team", catalogId: `sp_${space}` });
  function spaces(requests, refresh) {
    const moved = requests.filter(item => item.migrateFrom).length >= 2;
    const replaced = requests.some(item => item.op === "space-conflict-resolve");
    const details = [
      ...(!moved ? [{ space: "old-space", catalogLabel: "Old space", catalogIdp: to, existingOrigin: "catalog", existingIdp: from, existingSignedIn: true }] : []),
      ...(!replaced ? [{ space: "saved-manual", catalogLabel: "Saved manual", catalogIdp: to, existingOrigin: "manual" }] : []),
    ];
    return { kind: "spaces", refresh: refresh ? details.length ? "partial" : "complete" : "not-requested", unreadable: 0,
      collisions: refresh ? details.length : 0, collisionDetails: refresh ? details : [], failedProviders: [],
      spaces: requests.some(item => item.op === "login") ? [row("new-space", to), row("old-space", moved ? to : from)] : [],
      signedInProviders: requests.some(item => item.op === "login") ? [to, from] : [],
      ...(refresh && !moved ? { migration: { fromIdp: from, toIdp: to, spaces: ["old-space"] } } : {}),
    };
  }
  const lines = readline.createInterface({ input: process.stdin });
  lines.once("line", line => {
    lines.close();
    const req = JSON.parse(line);
    appendFileSync(traceFile, `${JSON.stringify(req)}\n`);
    const requests = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").map(JSON.parse) : [];
    const emit = value => console.log(JSON.stringify({ v: 1, ok: true, ...value }));
    const result = payload => emit({ event: "result", result: payload });
    switch (req.op) {
      case "about": return result({ version: status.version, machine: "Fixture computer", platform: "linux", arch: "x64", memoryBytes: 8589934592 });
      case "status": return result(status);
      case "status-watch": emit({ event: "status", watchMode: "push", result: status }); return setInterval(() => {}, 1000);
      case "login": return result(req.migrateFrom && requests.filter(item => item.migrateFrom).length === 1
        ? { outcome: "failed", reason: "expired", message: "The approval code expired." }
        : { outcome: "signed-in", idp: req.idp, sub: "fixture-user" });
      case "spaces": return result(spaces(requests, req.refresh));
      case "space-conflict-resolve": return result(spaces(requests, true));
      case "service-status": return result({ state: "disconnected" });
      case "agent-apps": return result({ apps: [], management: "local" });
      case "update-policy": return result({ auto: true });
      default: throw new Error(`Unexpected native fixture request: ${req.op}`);
    }
  });
}

// This runs next to the built renderer in the real WebKit window. It does not replace invoke.
async function drive() {
  const visible = selector => document.querySelector(selector)?.getClientRects().length > 0;
  const wait = async (predicate, label) => {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`${label}: ${document.querySelector("#connection-title").textContent}; ${document.querySelector("#refusal-detail").textContent}`);
  };
  const click = async selector => {
    await wait(() => visible(selector) && !document.querySelector(selector).disabled, selector);
    document.querySelector(selector).click();
  };
  const failures = [];
  try {
    await wait(() => !document.querySelector(".app").classList.contains("loading"), "native window ready");
    await click("#login");
    await click("#move-account");
    try {
      await wait(() => visible("#recover") && document.querySelector("#recover").textContent === "Get a new code", "Move reaches the expiry reply");
      await click("#recover");
      await wait(() => document.querySelector("#notice").textContent.includes("Moved your spaces") || (visible("#space-conflicts-callout") && !visible("#move-account")), "Get a new code retries the move");
    } catch (error) {
      failures.push(error.message);
      if (visible("#recover")) await click("#recover");
    }
    await click("#open-conflicts");
    // Approve the local fixture replacement without intercepting any Tauri command.
    window.confirm = () => true;
    await click('[data-space="saved-manual"] button[aria-label^="Use "]');
    await wait(() => !document.querySelector('[data-space="saved-manual"]'), "Use reaches the sidecar and clears the row");
  } catch (error) {
    failures.push(error.message);
  }
  await fetch("/__native_conflict_result", { method: "POST", body: JSON.stringify(failures) });
}

let complete;
const result = new Promise(resolve => { complete = resolve; });
function serve(req, res) {
  if (req.url === "/__native_conflict_result" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { res.end(); complete(JSON.parse(body)); });
    return;
  }
  if (req.url === "/__native_conflict_driver.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(`void (${drive.toString()})();`);
  }
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    return res.end(readFileSync(join(assets, "index.html"), "utf8").replace("</body>", '<script type="module" src="/__native_conflict_driver.js"></script></body>'));
  }
  const file = resolve(assets, `.${req.url}`);
  if (!file.startsWith(`${assets}/`)) { res.writeHead(404); return res.end(); }
  const types = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  try { res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream"); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
}

const server = createServer(serve);
let child;
try {
  // Tauri debug builds use the configured development address. Resource placement matches Linux bundles.
  for (const name of ["Cotal", "cotal-desktop"]) {
    const runtime = join(root, "lib", name, "runtime", "dist");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "cotal.js"), `(${fixture.toString()})();\n`);
  }
  server.listen(1420, "127.0.0.1");
  await once(server, "listening");
  child = spawn(app, [], { cwd: dirname(app), detached: true, stdio: "inherit",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache") } });
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(["Native window did not report a result"]), 30_000); });
  const failures = await Promise.race([result, timeout, once(child, "exit").then(([code, signal]) => [`Native app exited: ${code ?? signal}`])]);
  clearTimeout(timer);
  let requests = [];
  try { requests = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse); } catch { /* No request reached the sidecar. */ }
  const actions = requests.filter(item => item.migrateFrom || item.op === "space-conflict-resolve");
  console.log("Native conflict actions:", JSON.stringify(actions));
  assert.deepEqual(failures, []);
  const idp = "https://cotal.cloud/api/auth";
  const move = { op: "login", idp, migrateFrom: "https://cloud.cotal.ai/api/auth" };
  assert.deepEqual(actions, [move, move, { op: "space-conflict-resolve", idp, space: "saved-manual" }]);
  console.log("PASS: native Move, Get a new code, and Use reached the sidecar");
} finally {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, "exit"), delay(2000)]);
  }
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}

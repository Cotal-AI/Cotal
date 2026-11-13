/** Signal cancellation through the built CLI, a foreground daemon and a loopback device provider. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordMesh } from "@cotal-ai/workspace";
import { emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon-login-signals smoke: Linux only");
const keep = process.env.COTAL_DAEMON_SMOKE_KEEP === "1";
const root = mkdtempSync(join(process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir(), "dls-"));
const cli = join(dirname(fileURLToPath(import.meta.url)), "../dist/cotal.js");
assert.ok(existsSync(cli), "build the CLI before running this suite");
const home = join(root, "home"), config = join(root, "config"), runtime = join(root, "rt");
const cotal = join(root, "cotal"), daemonHome = join(root, "daemon"), native = join(root, "native");
for (const dir of [home, config, runtime, cotal, daemonHome, native]) mkdirSync(dir, { mode: 0o700 });
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_HOME: cotal,
  COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", PATH: `${native}:${env.PATH}` });
// Only the fixture's directory discovery is allowed. Every native service effect is refused.
for (const name of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
  writeFileSync(join(native, name), `#!${process.execPath}\n${name === "systemctl" ? `if (process.argv.slice(2).join(' ') === '--user show-environment') { console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)}); process.exit(0); }` : ""}\nprocess.exit(99);\n`, { mode: 0o700 });
}

let polls = 0, approved = false, holdPrompt = false;
let releasePrompt: (() => void) | undefined;
let codeRequests = 0;
const token = "signal-smoke-session-marker";
const idp = createServer(async (req, res) => {
  const route = new URL(req.url!, "http://127.0.0.1").pathname;
  const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (route.endsWith("/device/code")) {
    codeRequests++;
    if (holdPrompt) await new Promise<void>((resolve) => { releasePrompt = resolve; });
    return void send(200, { device_code: "signal-smoke-device", user_code: "SIGNAL", verification_uri: "http://127.0.0.1/approve",
      verification_uri_complete: "http://127.0.0.1/approve?code=SIGNAL", expires_in: 60, interval: 1 });
  }
  if (route.endsWith("/device/token")) {
    polls++;
    return void (approved ? send(200, { access_token: token, expires_in: 3600 }) : send(400, { error: "authorization_pending" }));
  }
  if (route === "/api/auth/token") {
    const jwt = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"signal-smoke-user"}').toString("base64url")}.sig`;
    return void send(200, { token: jwt });
  }
  send(404, {});
});
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/api/auth`;
const children = new Set<ChildProcess>();
function run(args: string[]) {
  const child = spawn(process.execPath, [cli, "daemon", ...args, "--daemon-home", daemonHome], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "", err = "";
  child.stdout.on("data", (b) => { out += String(b); });
  child.stderr.on("data", (b) => { err += String(b); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { children.delete(child); resolve({ code, signal, out, err }); });
  });
  const timer = args[0] === "serve" ? undefined : setTimeout(() => child.kill("SIGKILL"), 20_000);
  void done.finally(() => { if (timer) clearTimeout(timer); });
  return { child, done, stderr: () => err, stdout: () => out };
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 10_000;
  while (!predicate()) { assert.ok(Date.now() < end, `timed out: ${label}`); await sleep(20); }
}
let failures = 0, passed = 0;
async function cell(name: string, body: () => Promise<void>) {
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`); }
}

const unit = `cotal-daemon-${createHash("sha256").update(daemonHome).digest("hex").slice(0, 16)}.service`;
const unitDir = join(config, "systemd/user");
mkdirSync(unitDir, { recursive: true, mode: 0o700 });
const unitPath = join(unitDir, unit);
const unitBytes = `[Unit]\nDescription=Cotal machine daemon\n\n[Service]\nType=simple\nExecStart="${process.execPath}" "${cli}" daemon serve --daemon-home "${daemonHome}"\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
writeFileSync(unitPath, unitBytes, { mode: 0o600 });
writeFileSync(join(daemonHome, "service-unit.json"), JSON.stringify({ v: 1, unit, unitPath, daemonHome,
  unitSha256: createHash("sha256").update(unitBytes).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
// Only the service-only setup path needs a registered space. No broker is needed before sign-in.
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = cotal;
try {
  recordMesh({ space: "signal-smoke", server: "nats://127.0.0.1:1", root, mode: "user", ts: new Date().toISOString(),
    userAuth: { provider: "cotal", idp: { url, issuer: url, audience: url } } });
} finally {
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
}
const commands = [
  { name: "login", args: ["login", "--idp", url], prompt: "Approve sign-in" },
  { name: "setup discovery", args: ["setup", "--space", "discovery-smoke", "--idp", url], prompt: "Approve this machine" },
  { name: "setup service-only", args: ["setup", "--no-manager", "--space", "signal-smoke", "--idp", url, "--wait", "0"], prompt: "Approve this machine" },
];
const sessionFile = join(daemonHome, "idp-sessions.json");
const daemon = run(["serve"]);
// The daemon stays up longer than an individual CLI call.
try {
  await until(() => daemon.stdout().includes("daemon ready at "), "foreground daemon ready");
  for (const command of commands) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const presentation of ["rich", "plain", "json"] as const) {
        await cell(`${command.name} ${signal} ${presentation}`, async () => {
          const before = polls;
          const attempt = run([...command.args, ...(presentation === "rich" ? [] : [`--${presentation}`])]);
          await until(() => attempt.stderr().includes(command.prompt) && polls > before, "prompt and provider poll");
          attempt.child.kill(signal);
          const result = await attempt.done;
          const atExit = polls;
          await sleep(1100);
          console.log(JSON.stringify({ command: command.name, signal, presentation, code: result.code, exitSignal: result.signal,
            hasCancellation: /cancelled/.test(result.err + result.out), hasHelp: /Usage\n/.test(result.err), pollsAtExit: atExit, pollsAfter: polls }));
          assert.equal(polls, atExit, "provider polling stopped before CLI exit");
          assert.equal(existsSync(sessionFile), false, "no session saved");
          assert.equal(result.code, 1);
          assert.equal(result.signal, null);
          if (presentation === "json") {
            const doc = JSON.parse(result.out);
            assert.equal(doc.outcome, "refused");
            assert.equal(doc.error.code, "USAGE_INVALID");
            assert.equal(doc.error.cause.code, "CANCELLED");
          } else {
            assert.match(result.err, /cancelled/);
            assert.doesNotMatch(result.err, /Usage\n|Examples\n|Options\n/);
          }
          const status = await run(["status", "--json"]).done;
          assert.equal(status.code, 0);
          assert.equal(JSON.parse(status.out).result.state, "ready");
        });
      }
    }
  }
  // Before the prompt there is no attempt ID to cancel. Closing the socket is the safe boundary.
  for (const command of commands) for (const signal of ["SIGINT", "SIGTERM"] as const) {
    await cell(`${command.name} ${signal} before prompt`, async () => {
      holdPrompt = true;
      const before = codeRequests;
      const attempt = run([...command.args, "--json"]);
      try {
        await until(() => codeRequests > before, "provider device request");
        attempt.child.kill(signal);
        const result = await attempt.done;
        console.log(JSON.stringify({ command: command.name, signal, beforePrompt: true, code: result.code, exitSignal: result.signal }));
        assert.equal(result.code, 1);
        const doc = JSON.parse(result.out);
        assert.equal(doc.error.code, "USAGE_INVALID");
        assert.equal(doc.error.cause.code, "ABANDONED");
        assert.equal(existsSync(sessionFile), false);
      } finally { holdPrompt = false; releasePrompt?.(); releasePrompt = undefined; }
    });
  }
  await cell("unknown login flag still prints usage", async () => {
    const result = await run(["login", "--signal-smoke-unknown"]).done;
    assert.equal(result.code, 1);
    assert.match(result.err, /signal-smoke-unknown/);
    assert.match(result.err, /Usage\n/);
  });
  await cell("approval still signs in and saves a session", async () => {
    const ready = await run(["status", "--json"]).done;
    assert.equal(ready.code, 0);
    assert.equal(JSON.parse(ready.out).result.state, "ready");
    approved = true;
    const result = await run(["login", "--idp", url]).done;
    assert.equal(result.code, 0);
    assert.match(result.out, /Signed in/);
    assert.ok(existsSync(sessionFile));
    assert.doesNotMatch(result.out + result.err, new RegExp(token));
  });
} finally {
  releasePrompt?.();
  for (const child of children) child.kill("SIGTERM");
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  })));
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  console.log(`signal smoke root: ${root}`);
  if (!keep) rmSync(root, { recursive: true, force: true });
}
assert.equal(failures, 0, `${failures} signal cells failed`);
emitSentinel({ passed, failed: failures });

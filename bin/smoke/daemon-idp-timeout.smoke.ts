/** Foreground daemon timeout configuration through the built CLI, with a counting loopback IdP. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon-idp-timeout smoke: Linux only");
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cotal.js");
assert.ok(existsSync(cli), "build cotal-ai before running this suite");
const root = mkdtempSync(join(tmpdir(), "idp6111-"));
chmodSync(root, 0o700);
const standins = join(root, "standins");
mkdirSync(standins, { mode: 0o700 });
for (const name of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
  writeFileSync(join(standins, name), "#!/bin/sh\necho 'host service control forbidden' >&2\nexit 99\n", { mode: 0o700 });
}
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
let requests: string[] = [];
let origin = "";
const idp = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/device/code") {
    res.end(JSON.stringify({ device_code: "test-device", user_code: "TEST6111", verification_uri: `${origin}/verify`, verification_uri_complete: `${origin}/verify?code=TEST6111`, expires_in: 60, interval: 1 }));
  } else if (req.url === "/api/auth/device/token") {
    res.end(JSON.stringify({ access_token: "test-session", expires_in: 3600 }));
  } else if (req.url === "/api/auth/token") {
    const payload = Buffer.from(JSON.stringify({ sub: "test-6111", iss: origin, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    res.setHeader("link", `<${origin}/api/auth/spaces>; rel="https://cotal.ai/relations/space-catalog"`);
    res.end(JSON.stringify({ token: `eyJhbGciOiJub25lIn0.${payload}.test` }));
  } else if (req.url === "/api/auth/spaces") {
    res.end(JSON.stringify({ v: 1, account: { idpUrl: `${origin}/api/auth`, issuer: origin, sub: "test-6111" }, spaces: [] }));
  } else { res.statusCode = 404; res.end("{}"); }
});
await new Promise<void>((done) => idp.listen(0, "127.0.0.1", done));
const address = idp.address();
assert.ok(address && typeof address !== "string");
origin = `http://127.0.0.1:${address.port}`;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function launch(args: string[], env: NodeJS.ProcessEnv, log: string) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (data) => { out += String(data); });
  child.stderr.on("data", (data) => { err += String(data); });
  const closed = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      writeFileSync(`${log}.stdout`, out);
      writeFileSync(`${log}.stderr`, err);
      writeFileSync(`${log}.exit`, `${code}\n`);
      done(code);
    });
  });
  return { child, closed, out: () => out, err: () => err };
}
async function waitFor(predicate: () => boolean, child: ChildProcess): Promise<void> {
  const end = Date.now() + 15_000;
  while (!predicate() && child.exitCode === null && child.signalCode === null) {
    assert.ok(Date.now() < end, "child did not settle or become ready within 15s");
    await sleep(25);
  }
}
async function finish(run: ReturnType<typeof launch>): Promise<number | null> {
  const timer = setTimeout(() => run.child.kill("SIGKILL"), 15_000);
  try { return await run.closed; } finally { clearTimeout(timer); }
}

let failures = 0;
let caseNumber = 0;
try {
  for (const explicit of [false, true]) {
    for (const json of [false, true]) {
      for (const timeout of ["invalid", "0", "-1", "Infinity", ""]) {
        const name = `${explicit ? "explicit" : "default"}-${json ? "json" : "text"}-${timeout || "empty"}`;
        await runCase(name, explicit, json, timeout, false);
      }
    }
    for (const timeout of ["5000", undefined]) {
      await runCase(`${explicit ? "explicit" : "default"}-valid-${timeout ?? "unset"}`, explicit, true, timeout, true);
    }
  }
} finally {
  await new Promise<void>((done, reject) => idp.close((error) => error ? reject(error) : done()));
}
console.log(`daemon-idp-timeout: ${failures} failed; evidence ${root}`);
if (failures) process.exitCode = 1;
emitSentinel({ passed: caseNumber - failures, failed: failures });

async function runCase(name: string, explicit: boolean, json: boolean, timeout: string | undefined, valid: boolean): Promise<void> {
  const dir = join(root, String(++caseNumber));
  mkdirSync(dir, { mode: 0o700 });
  for (const sub of ["home", "config", "rt", "cotal", "daemon"]) mkdirSync(join(dir, sub), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...cleanEnv, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: join(dir, "rt"), COTAL_HOME: join(dir, "cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1", PATH: `${standins}:${process.env.PATH}` };
  const target = explicit ? ["--daemon-home", join(dir, "daemon")] : [];
  requests = [];
  const daemon = launch(["daemon", "serve", ...target, ...(json ? ["--json"] : [])], { ...env, ...(timeout === undefined ? {} : { COTAL_IDP_TIMEOUT_MS: timeout }) }, join(dir, "serve"));
  try {
    await waitFor(() => daemon.out().includes("daemon ready at "), daemon.child);
    const ready = daemon.out().includes("daemon ready at ");
    // On unchanged code, record the reported defect through login before reporting the failed assertion.
    if (ready) {
      const login = launch(["daemon", "login", ...target, "--idp", `${origin}/api/auth`, "--json"], env, join(dir, "login"));
      const code = await finish(login);
      const doc = JSON.parse(login.out()) as { outcome: string; result?: { outcome: string }; error?: { code: string; message: string; cause?: { code: string } } };
      console.log(`${name}: login exit=${code} outcome=${doc.outcome} code=${doc.error?.code ?? "none"} cause=${doc.error?.cause?.code ?? "none"} requests=${requests.length} prompt=${login.err().includes("Approve sign-in")}`);
      if (valid) {
        assert.equal(code, 0);
        assert.equal(doc.result?.outcome, "signed-in");
        assert.ok(login.err().includes("Approve sign-in"));
        assert.ok(requests.includes("POST /api/auth/device/code"));
        assert.ok(requests.includes("POST /api/auth/device/token"));
        assert.ok(requests.includes("GET /api/auth/token"));
        for (const file of ["idp-sessions.json", "space-catalogs.json"]) {
          assert.equal(statSync(join(dir, explicit ? "daemon" : "cotal", file)).mode & 0o777, 0o600);
        }
      } else {
        assert.equal(code, 5);
        assert.equal(doc.error?.code, "OPERATION_FAILED");
        assert.equal(doc.error?.cause?.code, "REFUSED");
        assert.ok(doc.error?.message.includes("a session may have been saved"));
        assert.equal(requests.length, 0);
      }
    }
    if (!valid) {
      assert.equal(requests.length, 0);
      for (const home of ["daemon", "cotal"]) {
        for (const file of ["idp-sessions.json", "space-catalogs.json"]) assert.equal(existsSync(join(dir, home, file)), false);
      }
      assert.equal(ready, false, "invalid timeout must refuse startup before readiness, not become a provider failure during login");
      assert.equal(await finish(daemon), 1);
      const doc = json ? JSON.parse(daemon.out()) as { outcome: string; error: { code: string; message: string } } : undefined;
      if (doc) {
        assert.equal(doc.outcome, "refused");
        assert.equal(doc.error.code, "USAGE_INVALID");
      }
      const text = doc ? doc.error.message : daemon.err();
      assert.ok(text.includes("COTAL_IDP_TIMEOUT_MS must be a positive number of milliseconds"), "startup must name the malformed setting");
      assert.ok(!text.includes("provider's answer") && !text.includes("session may have been saved"));
      assert.ok(!existsSync(join(dir, "rt", "cotal")), "invalid configuration must not create endpoint state");
    } else assert.ok(ready, "valid timeout must allow startup");
    console.log(`PASS ${name}: requests=${requests.length}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill("SIGTERM");
    await finish(daemon);
    writeFileSync(join(dir, "requests.json"), JSON.stringify(requests));
  }
}

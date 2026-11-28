/** Shipped readiness distinguishes local spaces, refuses unusable IdP proofs and permits two bounded slow reads. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { SignJWT, generateKeyPair } from "jose";
import { saveIdpSession } from "@cotal-ai/auth";
import { findMesh, recordMesh, userAuthStateDir } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, freePort, killAndAwaitExit, recordSmokeSandbox, skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";

if (process.platform !== "linux") skipSuite("daemon-readiness smoke: Linux only");
const parent = mkdtempSync(join(tmpdir(), "cdr-proof-"));
const home = join(parent, "h"), runtime = join(parent, "r"), config = join(parent, "c"), native = join(parent, "n"), mesh = join(parent, "m");
for (const dir of [home, runtime, config, native, mesh]) mkdirSync(dir, { mode: 0o700 });
const cliEntry = resolve("bin/dist/cotal.js");
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
const env = { PATH: `${native}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
  XDG_DATA_HOME: join(parent, "d"), XDG_CACHE_HOME: join(parent, "cache"), COTAL_HOME: home, TMPDIR: parent,
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1", USER: "smoke", LOGNAME: "smoke" };
const paths = daemonPaths(env, home);
mkdirSync(join(config, "systemd/user"), { recursive: true, mode: 0o700 });
writeFileSync(join(native, "systemctl"), `#!/bin/sh\n[ "$*" = '--user show-environment' ] || exit 89\nprintf '%s\\n' 'XDG_CONFIG_HOME=${config}'\n`, { mode: 0o700 });
for (const name of ["launchctl", "schtasks"]) writeFileSync(join(native, name), "#!/bin/sh\nexit 89\n", { mode: 0o700 });
const unitPath = join(config, "systemd/user/cotal-daemon.service");
const unitReceipt = join(home, "daemon/service-unit.json");
const unit = `[Unit]\nDescription=Cotal machine daemon\n\n[Service]\nType=simple\nExecStart="${process.execPath}" "${cliEntry}" daemon serve\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
writeFileSync(unitPath, unit, { mode: 0o600 });
mkdirSync(join(home, "daemon"), { mode: 0o700 });
writeFileSync(unitReceipt, JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath,
  unitSha256: createHash("sha256").update(unit).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
const key = await generateKeyPair("EdDSA");
let mode = "valid", tokenDelay = 0, authorityDelay = 0, tokens = 0, gets = 0, posts = 0, devices = 0;
let origin = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const authority = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/token") {
    tokens++;
    await sleep(tokenDelay);
    if (res.destroyed) return;
    if (mode === "nonsense") { res.end(JSON.stringify({ token: "not-a-jwt" })); return; }
    const now = Math.floor(Date.now() / 1000);
    const claims = new SignJWT({}).setProtectedHeader({ alg: "EdDSA" }).setIssuer(origin).setAudience(origin).setSubject("fixture-owner").setIssuedAt(now);
    if (mode !== "no-expiry") claims.setExpirationTime(mode === "expired" ? now - 3600 : mode === "near-expiry" ? now + 20 : now + 120);
    if (mode === "not-yet-valid") claims.setNotBefore(now + 3600);
    let token = await claims.sign(key.privateKey);
    if (mode === "signature-x" || mode === "signature-abcde") token = `${token.slice(0, token.lastIndexOf(".") + 1)}${mode.slice("signature-".length)}`;
    res.end(JSON.stringify({ token }));
    return;
  }
  if (req.url?.includes("/device/")) { devices++; res.writeHead(503); res.end("{}"); return; }
  if (req.url === "/service-endpoint-authority") {
    if (req.method !== "GET") { posts++; res.writeHead(503); res.end("{}"); return; }
    gets++;
    await sleep(authorityDelay);
    if (!res.destroyed) res.end(JSON.stringify({ v: 1, kind: "service-endpoint-authority-info", space: "proof", accountPublicKey: `A${"B".repeat(55)}` }));
    return;
  }
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((r) => authority.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${(authority.address() as { port: number }).port}`;
const idp = `${origin}/api/auth`;
recordMesh({ space: "proof", server: "nats://127.0.0.1:4222", root: mesh, mode: "user", origin: "manual", ts: new Date().toISOString(),
  userAuth: { provider: "cotal", idp: { url: idp, issuer: origin, audience: origin }, endpoints: { url: origin }, remote: true,
    sentinelCredsPath: join(userAuthStateDir(mesh, "proof", { readOnly: true }), "sentinel.creds") } });
const seed = (name: string) => saveIdpSession(home, idp, { token: `fixture-${name}`, expiresAt: 1, sub: "fixture-owner" });
const counts = () => ({ tokens, gets, posts, devices });
const identities = () => readdirSync(join(home, "daemon"), { recursive: true }).map(String).filter((p) => p.endsWith("service-identity.json")).length;
const cli = async (cwd: string, ...args: string[]) => {
  const started = Date.now();
  const child = spawn(process.execPath, [cliEntry, ...args, "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (b) => { out += String(b); }); child.stderr.on("data", (b) => { err += String(b); });
  const code = await new Promise<number | null>((r, reject) => { child.once("close", r); child.once("error", reject); });
  assert.ok(out.trim(), `${args.join(" ")} produced no output (exit ${code}): ${err}`);
  return { code, elapsedMs: Date.now() - started, doc: JSON.parse(out) as Record<string, any>, err };
};
const run = (...args: string[]) => cli(parent, "daemon", ...args);
const daemon = spawn(process.execPath, [cliEntry, "daemon", "serve"], { cwd: parent, env, stdio: ["ignore", "ignore", "ignore"] });
try {
  for (let i = 0; i < 100 && !existsSync(paths.socket) && daemon.exitCode === null; i++) await sleep(100);
  assert.ok(existsSync(paths.socket), "shipped foreground daemon must bind");
  const openSpace = "local-open", openProject = join(parent, openSpace);
  mkdirSync(join(openProject, ".cotal"), { recursive: true, mode: 0o700 });
  const openStack = spawn(process.execPath, [cliEntry, "up", "--foreground", "--open", "--server", `nats://127.0.0.1:${await freePort()}`, "--space", openSpace],
    { cwd: openProject, env, stdio: ["ignore", "pipe", "pipe"] });
  let openOutput = "";
  openStack.stdout.on("data", (chunk) => { openOutput += String(chunk); });
  openStack.stderr.on("data", (chunk) => { openOutput += String(chunk); });
  try {
    for (let i = 0; i < 100 && !findMesh(openSpace) && openStack.exitCode === null && openStack.signalCode === null; i++) await sleep(100);
    assert.equal(findMesh(openSpace)?.mode, "open", openOutput);
    let manager = await cli(openProject, "ps", "--space", openSpace);
    for (let i = 0; i < 10 && manager.code !== 0 && openStack.exitCode === null; i++) {
      await sleep(100);
      manager = await cli(openProject, "ps", "--space", openSpace);
    }
    assert.equal(manager.code, 0, JSON.stringify(manager));
    const reply = await run("service-connect", "--space", openSpace);
    assert.equal(reply.code, 2, JSON.stringify(reply));
    assert.equal(reply.doc.error?.code, "UNSUPPORTED", JSON.stringify(reply));
    assert.match(reply.doc.error?.message, /this space does not use user sign-in/);
    assert.equal(reply.doc.error?.remedy, "run `cotal up` in the folder that hosts the local space. Its stack runs the Manager");
    const scoped = await run("status", "--space", openSpace);
    assert.equal(scoped.code, 2, JSON.stringify(scoped));
    assert.deepEqual(scoped.doc.target, { space: openSpace });
    assert.equal(scoped.doc.error?.cause?.code, "NOT_REQUESTED");
    assert.ok(scoped.doc.error?.message.includes(`The background service does not run local spaces, so it does not host a Manager for ${openSpace} (${openProject}).`));
    assert.equal(scoped.doc.error?.remedy, `Run \`cotal status --space ${openSpace}\` to inspect its local stack in ${openProject}.`);
    console.log("PASS running open space directs service-connect to cotal up instead of registration");
  } finally {
    await killAndAwaitExit(openStack, "SIGTERM");
    openStack.stdout.destroy();
    openStack.stderr.destroy();
  }
  const localSpace = "local-static", project = join(parent, localSpace);
  mkdirSync(project, { mode: 0o700 });
  const sandbox = recordSmokeSandbox({ root: project, cotalHome: home, xdgConfigHome: config });
  const runProject = async (...args: string[]) => {
    const result = await cli(project, ...args);
    assert.equal(result.code, 0, JSON.stringify(result));
    return result.doc.result;
  };
  const assertLocalRefusal = async (state: string) => {
    for (const [mode, ...flags] of [["setup"], ["setup", "--idp", idp], ["connect-check"]] as const) {
      const reply = await run(mode, "--space", localSpace, ...flags);
      assert.equal(reply.code, 2, JSON.stringify(reply));
      assert.equal(reply.doc.error?.code, "UNSUPPORTED");
      assert.equal(reply.doc.error?.cause?.code, "NOT_USER_AUTH");
      assert.equal(reply.doc.error?.remedy, "run `cotal up` in the folder that hosts the local space. Its stack runs the Manager");
    }
    console.log(`PASS ${state} local space directs setup and connect-check to cotal up`);
  };
  const down = ["down", "--with-agents", "--yes"];
  const stopProject = () => {
    assertSmokeSandboxDown(sandbox, [...down, "--json"], { cwd: project, env });
    return cli(project, ...down);
  };
  try {
    const before = counts();
    await runProject("space", "create", localSpace, "--root", project);
    await assertLocalRefusal("prepared");
    await runProject("up", "--detach", "--server", `nats://127.0.0.1:${await freePort()}`);
    await assertLocalRefusal("running");
    const stopped = await stopProject();
    assert.equal(stopped.code, 0, JSON.stringify(stopped));
    assert.equal((await runProject("space", "show", localSpace)).state, "stopped");
    await assertLocalRefusal("stopped");
    // The daemon was started in the foreground. Remove the synthetic install receipt for this case.
    renameSync(unitReceipt, `${unitReceipt}.saved`);
    try {
      await assertLocalRefusal("stopped, with no installed unit");
      assert.equal(existsSync(unitReceipt), false, "local setup must not install a service");
    } finally {
      renameSync(`${unitReceipt}.saved`, unitReceipt);
    }
    for (const mode of ["setup", "connect-check"]) {
      const reply = await run(mode, "--space", "unknown-space");
      assert.equal(reply.code, 2, JSON.stringify(reply));
      assert.equal(reply.doc.error?.code, "TARGET_NOT_FOUND");
    }
    assert.deepEqual(counts(), before, "local and unknown spaces never contact the sign-in provider");
    console.log("PASS unknown spaces still return TARGET_NOT_FOUND");
  } finally {
    await stopProject();
  }
  for (const value of ["nonsense", "expired", "no-expiry", "not-yet-valid", "signature-x", "signature-abcde"]) {
    mode = value;
    for (const args of [["connect-check", "--space", "proof"], ["setup", "--no-manager", "--space", "proof", "--idp", idp, "--wait", "0"]]) {
      // Isolate the command's cold request even when the stock cache holds a future-dated proof.
      seed(`${value}-${args[0]}`);
      const before = counts(), result = await run(...args);
      assert.equal(result.code, 2);
      assert.equal(result.doc.error?.code, value === "expired" ? "LIFECYCLE_BLOCKED" : "DEPENDENCY_UNAVAILABLE");
      assert.equal(result.doc.error?.cause?.code, value === "expired" ? "CREDENTIAL_EXPIRED" : "REFUSED");
      assert.equal(result.doc.error?.message, value === "expired"
        ? "the sign-in provider returned a credential that is expired according to this machine's clock; check this machine's and the authority's clocks, then connect again; nothing is connected"
        : "the space's sign-in provider gave an answer the daemon cannot use");
      assert.equal(result.err.includes("already signed in"), false);
      assert.deepEqual(counts(), { ...before, tokens: before.tokens + 1 });
      assert.equal(identities(), 0);
      assert.equal(readdirSync(join(home, "daemon"), { recursive: true }).map(String).some((p) => p.endsWith("register-request.json")), false);
      console.log(`PASS ${value} ${args[0]} refuses before authority, registration, device login or identity creation`);
    }
  }
  // Fresh proofs inside the reuse margin are usable now, but must not be retained for reuse.
  mode = "near-expiry"; seed(mode);
  const beforeNear = tokens;
  for (let i = 0; i < 2; i++) assert.equal((await run("connect-check", "--space", "proof")).code, 0);
  assert.equal(tokens, beforeNear + 2);
  assert.equal(identities(), 1);
  console.log("PASS fresh near-expiry proof is usable but not cached");
  mode = "valid"; seed(mode); tokenDelay = 20_000; authorityDelay = 20_000;
  const beforeSlow = counts(), slow = await run("connect-check", "--space", "proof");
  assert.equal(slow.code, 0);
  assert.equal(slow.doc.result?.outcome, "ready-to-register");
  assert.ok(slow.elapsedMs >= 40_000 && slow.elapsedMs < 65_000);
  assert.deepEqual(counts(), { ...beforeSlow, tokens: beforeSlow.tokens + 1, gets: beforeSlow.gets + 1 });
  console.log(`PASS 20s provider plus 20s authority returns readiness, exit ${slow.code}, elapsed ${slow.elapsedMs}ms`);
} finally {
  await killAndAwaitExit(daemon, "SIGTERM");
  authority.closeAllConnections();
  await new Promise<void>((r) => authority.close(() => r()));
  assert.equal(existsSync(paths.socket), false);
}
console.log("DAEMON READINESS SMOKE OK (shipped daemon and fixture stopped)");

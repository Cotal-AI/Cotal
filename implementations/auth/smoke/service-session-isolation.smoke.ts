/** Real direct-unit discovery and production session propagation, without services or network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CommandFailure, serviceLoginRecovery, serviceLoginStores, spaceKey } from "@cotal-ai/workspace";
import { loadIdpSession, saveIdpSession, type IdpSession } from "../src/login.js";
import { clearSharedServiceSessions, refreshServiceSessions } from "../src/service-sessions.js";

assert.equal(process.platform, "linux", "this smoke exercises Linux direct-unit discovery");
const root = mkdtempSync(join(tmpdir(), "service-session-isolation-"));
const originalEnv = { ...process.env };
const home = join(root, "home"), operator = join(home, ".cotal");
const units = join(home, ".config/systemd/user");
const idp = "https://identity.example.test/api/auth", otherIdp = "https://other.example.test/api/auth";
const approved: IdpSession = { token: "opaque-approved-smoke-secret", sub: "account-a", expiresAt: Date.now() + 60_000, name: "alice", label: "Alice Approved" };
const prior: IdpSession = { token: "opaque-prior-smoke-secret", sub: "account-a", expiresAt: Date.now() + 30_000, name: "old", label: "Old Label" };
const independent = { ...approved, token: "opaque-independent-smoke-secret" };
const replacement = { ...approved, token: "opaque-replacement-smoke-secret" };
const tokens = [approved.token, prior.token, independent.token, replacement.token];
function privateDir(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); }
function serviceName(name: string) { return `cotal-manager@${spaceKey(name)}.service`; }
function unit(name: string, directory: string) {
  const service = serviceName(name);
  const envPath = join(units, `${service}.env`);
  const values: Record<string, string> = { MESH: name, ROOT: home, WORKING_DIRECTORY: home, ENVIRONMENT_FILE: envPath, ENTRY: `${process.execPath} --import tsx ${resolve("bin/cotal.ts")}`, PATH: process.env.PATH!, SPACE: name, SERVER: "nats://127.0.0.1:4222", STATE_DIR: directory };
  const render = (file: string) => readFileSync(resolve("bin/smoke/fixtures", file), "utf8").replace(/@([A-Z_]+)@/g, (_, key: string) => { assert.ok(key in values); return values[key]!; });
  writeFileSync(envPath, render("pre-cut-manager-unit.env"), { mode: 0o600 });
  writeFileSync(join(units, service), render("pre-cut-manager-unit.service"), { mode: 0o600 });
  return service;
}
function store(name: string) { const directory = join(home, name); privateDir(directory); unit(name, directory); return directory; }
function bytes(directory: string) { return readFileSync(join(directory, "idp-sessions.json"), "utf8"); }
function publicOnly(value: unknown) {
  const printed = JSON.stringify(value);
  assert.ok(tokens.every((token) => !printed.includes(token)), "public names/errors do not reveal session tokens");
}
function refuses(run: () => unknown) {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error, "unsafe store must refuse");
  publicOnly({ ...error, message: error.message });
  return error;
}
try {
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, "xdg-isolated");
  privateDir(units); privateDir(operator); privateDir(process.env.XDG_CONFIG_HOME);
  const same = store("custom-matching"), anotherSub = store("custom-other-sub");
  const anotherProvider = store("custom-other-provider"), absent = store("custom-absent");
  const empty = store("custom-empty"), legacy = store("custom-no-subject");
  saveIdpSession(operator, idp, approved);
  saveIdpSession(same, idp, prior);
  saveIdpSession(same, otherIdp, independent);
  saveIdpSession(anotherSub, idp, { ...prior, sub: "account-b" });
  saveIdpSession(anotherProvider, otherIdp, prior);
  saveIdpSession(absent, otherIdp, independent);
  saveIdpSession(legacy, idp, { token: prior.token, expiresAt: prior.expiresAt });
  const untouched = new Map([anotherSub, anotherProvider, absent, legacy].map((directory) => [directory, bytes(directory)]));
  const discovered = serviceLoginStores();
  assert.equal(discovered.length, 6, "actual HOME legacy product units are discovered despite isolated XDG");
  assert.ok(discovered.some((s) => s.service === serviceName("custom-matching") && s.directory === same));
  const partial = refuses(() => refreshServiceSessions(operator, `${idp}/`, approved));
  assert.ok(partial instanceof CommandFailure);
  assert.equal(partial.code, "OPERATION_PARTIAL");
  assert.equal(partial.outcome, "partial");
  assert.deepEqual(partial.changed, [{ kind: "manager-service-sign-in", service: serviceName("custom-matching"), action: "refreshed" }], "matching account update is preserved in partial result");
  assert.ok(partial.message.includes(serviceName("custom-other-sub")));
  assert.ok(partial.message.includes(serviceName("custom-no-subject")));
  publicOnly(partial.detail());
  assert.deepEqual(loadIdpSession(same, idp), approved, "same provider and subject receive the opaque token, expiry and display names unchanged");
  assert.deepEqual(loadIdpSession(same, otherIdp), independent, "other provider within refreshed cache is retained");
  assert.equal(statSync(join(same, "idp-sessions.json")).mode & 0o777, 0o600);
  for (const [directory, before] of untouched) assert.equal(bytes(directory), before, "unrelated/absent account cache is byte-for-byte untouched");
  assert.equal(existsSync(join(empty, "idp-sessions.json")), false, "no new credentials for empty service");
  assert.deepEqual(loadIdpSession(operator, idp), approved, "operator source is untouched");
  console.log("PASS real discovery: same account refresh and names, provider/subject/absent isolation, 0600 and public names");

  const separate = store("custom-independent");
  saveIdpSession(separate, idp, independent);
  const cleared = clearSharedServiceSessions(operator, idp, approved);
  assert.deepEqual(cleared, [serviceName("custom-matching")]);
  publicOnly(cleared);
  assert.equal(loadIdpSession(same, idp), undefined, "local cleanup forgets exact shared token");
  assert.deepEqual(loadIdpSession(same, otherIdp), independent);
  assert.deepEqual(loadIdpSession(separate, idp), independent, "independent token survives local cleanup");
  assert.deepEqual(loadIdpSession(operator, idp), approved, "helper does not clear caller's source cache");
  for (const [directory, before] of untouched) assert.equal(bytes(directory), before);

  // A separate real writer replaces the shared token while holding the production lock.
  // Cleanup starts while that writer still owns the lock and must re-read after it releases.
  saveIdpSession(same, idp, approved);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { saveIdpSession, withIdpSessionLock } from ${JSON.stringify(pathToFileURL(resolve("implementations/auth/src/login.ts")).href)};
    withIdpSessionLock(${JSON.stringify(same)}, () => {
      saveIdpSession(${JSON.stringify(same)}, ${JSON.stringify(idp)}, ${JSON.stringify(replacement)});
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    });
  `], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
  let ready = "", errors = "";
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  try {
    await Promise.race([
      new Promise<void>((done) => child.stdout.on("data", (chunk: Buffer) => { ready += chunk.toString(); if (ready.includes("locked\n")) done(); })),
      exited.then(() => { throw new Error("replacement writer exited before lock readiness"); }),
    ]);
    assert.deepEqual(clearSharedServiceSessions(operator, idp, approved), []);
    assert.equal(await exited, 0, "real concurrent writer completed");
    publicOnly(errors);
    assert.deepEqual(loadIdpSession(same, idp), replacement, "replacement committed under the real lock survives stale local logout");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }
  console.log("PASS local-equivalent exact-token cleanup, independent session and concurrent locked replacement preserved");

  const victim = join(home, "victim"); privateDir(victim); saveIdpSession(victim, idp, prior);
  const victimBefore = bytes(victim);
  const unsafe = store("custom-unsafe-cache");
  symlinkSync(join(victim, "idp-sessions.json"), join(unsafe, "idp-sessions.json"));
  refuses(() => refreshServiceSessions(operator, idp, approved));
  refuses(() => clearSharedServiceSessions(operator, idp, prior));
  assert.equal(bytes(victim), victimBefore, "symlink cache cannot write victim");
  rmSync(join(unsafe, "idp-sessions.json"));
  saveIdpSession(unsafe, idp, prior);
  chmodSync(join(unsafe, "idp-sessions.json"), 0o666);
  const unsafeBefore = bytes(unsafe);
  refuses(() => refreshServiceSessions(operator, idp, approved));
  refuses(() => clearSharedServiceSessions(operator, idp, prior));
  assert.equal(bytes(unsafe), unsafeBefore, "unprotected cache cannot be overwritten");
  assert.equal(bytes(victim), victimBefore);
  rmSync(join(units, serviceName("custom-unsafe-cache")));
  const alias = join(home, "symlink-store"); symlinkSync(victim, alias);
  unit("custom-symlink-store", alias);
  refuses(() => refreshServiceSessions(operator, idp, approved));
  refuses(() => clearSharedServiceSessions(operator, idp, prior));
  assert.equal(bytes(victim), victimBefore, "symlink directory discovery refuses without victim writes");
  rmSync(join(units, serviceName("custom-symlink-store")));
  console.log("PASS unsafe symlink file/store and unprotected cache refuse without victim writes or token errors");

  const custom = join(home, "hand-made-store"); privateDir(custom); saveIdpSession(custom, idp, prior);
  writeFileSync(join(units, "hand-made.service"), `[Service]\nExecStart=${process.execPath} ${resolve("bin/cotal.ts")} supervise\nEnvironment=COTAL_HOME="${custom}"\n`, { mode: 0o600 });
  const customBefore = createHash("sha256").update(bytes(custom)).digest("hex");
  const customPartial = refuses(() => refreshServiceSessions(operator, idp, approved));
  assert.ok(customPartial instanceof CommandFailure);
  assert.equal(customPartial.code, "OPERATION_PARTIAL");
  assert.ok(!customPartial.message.includes("hand-made.service"), "unmanaged custom unit is not a propagation failure");
  assert.equal(createHash("sha256").update(bytes(custom)).digest("hex"), customBefore, "hand-made custom service must not receive automatic refresh");
  clearSharedServiceSessions(operator, idp, prior);
  assert.equal(createHash("sha256").update(bytes(custom)).digest("hex"), customBefore, "hand-made custom service must not receive automatic cleanup");
  const recovery = serviceLoginRecovery(idp, custom);
  assert.ok(recovery.includes(custom) && recovery.includes("COTAL_HOME=") && recovery.includes(`cotal login --idp ${idp}`), "custom recovery names explicit store and login command");
  publicOnly(recovery);
  console.log("PASS hand-made custom unit excluded from auto writes with explicit-store login recovery");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
}

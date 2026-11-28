/** Real daemon endpoint against account-computer HTTP routes, in a private machine home. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { saveIdpSession, requestAccountMachine } from "@cotal-ai/auth";
import { remoteManagerClient } from "@cotal-ai/manager";
import { daemonPathsFor } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";
import { queryDaemon } from "../daemon/client.js";
import { accountComputerId } from "../daemon/account-identity.js";

const root = mkdtempSync(join(tmpdir(), "dacct-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") && !["COTAL_TELEMETRY", "COTAL_SKIP_CONNECTOR_SEED"].includes(key)) delete process.env[key];
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.COTAL_HOME = join(root, "cotal");
const identityRoot = join(root, "identity-check");
const identitySpace = "read-only-manager";
assert.equal(remoteManagerClient.loadRemoteManagerInstanceId(identityRoot, identitySpace), undefined);
assert.equal(existsSync(identityRoot), false, "reading a missing identity does not create one");
const identity = remoteManagerClient.loadOrCreateRemoteManagerIdentity(identityRoot, identitySpace);
const identityFile = join(identityRoot, ".cotal", `remote-manager.${Buffer.from(identitySpace).toString("hex")}.json`);
const identityBytes = readFileSync(identityFile);
assert.equal(remoteManagerClient.loadRemoteManagerInstanceId(identityRoot, identitySpace), identity.instanceId);
assert.deepEqual(readFileSync(identityFile), identityBytes, "cleanup selection never changes the retained identity");
renameSync(identityFile, `${identityFile}.original`);
symlinkSync(`${identityFile}.original`, identityFile);
assert.throws(() => remoteManagerClient.loadRemoteManagerInstanceId(identityRoot, identitySpace), /not a regular file/);
unlinkSync(identityFile);
writeFileSync(identityFile, '{"v":1,"private":"fixture-private-value"}');
assert.throws(() => remoteManagerClient.loadRemoteManagerInstanceId(identityRoot, identitySpace), error => error instanceof Error && !error.message.includes("fixture-private-value"));
renameSync(`${identityFile}.original`, identityFile);
console.log("ok recorded Manager selection is read-only and refuses corrupt or linked records");
const machineHome = process.env.COTAL_HOME;
const runtime = join(root, "rt"); mkdirSync(runtime, { mode: 0o700 });
let registration: Record<string, unknown> | undefined;
let sent: unknown;
let malformed = false;
let mode = 200, puts = 0, gets = 0, tokens = 0;
let refusal: Record<string, unknown> | undefined;
let retryAfter: string | undefined;
let tokenBody: Record<string, unknown> = { token: "fixture-jwt" };
let revision = 1;
let etag = '"one"';
let conditional: string | undefined;
let persistedBeforePut = false;
let holdGet = false;
const fixture = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  assert.equal(req.headers.authorization, "Bearer fixture-session");
  const machine = req.url?.match(/^\/api\/cli\/machines\/([0-9a-f-]+)(\/spaces)?$/);
  if (req.url === "/api/auth/token") { tokens++; res.writeHead(tokenBody.token ? 200 : 401); res.end(JSON.stringify(tokenBody)); return; }
  if (!machine) { res.writeHead(404); res.end("{}"); return; }
  if (req.method === "PUT") {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => { assert.ok(Buffer.byteLength(body) <= 16384); registration = JSON.parse(body) as Record<string, unknown>; if (registration.vitals) sent = daemon.status().vitals; });
    puts++;
    persistedBeforePut = readdirSync(join(machineHome, "daemon", "accounts"), { recursive: true }).some(path => String(path).endsWith("computer.json"));
    if (mode !== 200 && mode !== 304) { if (retryAfter) res.setHeader("retry-after", retryAfter); res.writeHead(mode); res.end(JSON.stringify(refusal ?? {})); return; }
    res.end(JSON.stringify({ v: 1, machine: { id: machine[1], lastSeenAt: new Date().toISOString(), revision } })); return;
  }
  gets++; conditional = req.headers["if-none-match"] as string | undefined;
  if (holdGet) return;
  if (mode !== 200) { if (retryAfter) res.setHeader("retry-after", retryAfter); res.writeHead(mode); res.end(mode === 304 ? undefined : JSON.stringify(refusal ?? {})); return; }
  res.setHeader("etag", etag);
  res.end(JSON.stringify({ v: 1, machineId: machine[1], revision, ...(malformed ? {} : { bindingRevisions: {} }), account: { idpUrl, issuer, sub: "owner" }, spaces: [] }));
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const issuer = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const idpUrl = `${issuer}/api/auth`;
saveIdpSession(machineHome, idpUrl, { token: "fixture-session", sub: "owner", expiresAt: Date.now() / 1000 + 3600 });
const paths = daemonPathsFor(machineHome, { XDG_RUNTIME_DIR: runtime });
let daemon = await serveDaemon({ paths, version: "0.157.2", sessionDir: machineHome });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, label: string, timeoutMs = 12_000) {
  const end = Date.now() + timeoutMs;
  while (!test() && Date.now() < end) await sleep(50);
  assert.ok(test(), label);
  console.log(`ok ${label}`);
}
try {
  await until(() => gets > 0 && daemon.status().account?.desiredRevision === 1, "registered and applied complete desired set");
  assert.ok(persistedBeforePut);
  assert.equal(registration?.vitals, undefined, "initial registration does not wait for sampling");
  await until(() => !!daemon.status().vitals, "background sample becomes available");
  await promisify(execFile)(process.execPath, ["--import", "tsx", "bin/cotal.ts", "daemon", "name", "sample-ready", "--daemon-home", machineHome], { env: { ...process.env, COTAL_HOME: join(root, "cli-cotal"), XDG_RUNTIME_DIR: runtime } });
  await until(() => !!registration?.vitals, "next registration carries cached sample");
  assert.ok(registration);
  assert.deepEqual(registration.vitals, sent, "status exposes the sent sample");
  const { stdout: humanStatus } = await promisify(execFile)(process.execPath, ["--import", "tsx", "bin/cotal.ts", "daemon", "status", "--daemon-home", machineHome], { env: { ...process.env, COTAL_HOME: join(root, "cli-cotal"), XDG_RUNTIME_DIR: runtime } });
  assert.match(humanStatus, /\d+\.\d GiB free \/ \d+\.\d GiB total \(\d+\.\d% used\)/);
  assert.match(humanStatus, /System uptime:\s+\d+ days \d+ hours/);
  console.log("ok real CLI status renders GiB, used percentage and days/hours");
  const vitals = daemon.status().vitals!;
  assert.ok(Number.isFinite(Date.parse(vitals.sampledAt)));
  assert.ok(vitals.cpu.logicalCount > 0 && Number.isSafeInteger(vitals.cpu.logicalCount));
  assert.ok(vitals.cpu.utilisationPercent >= 0 && vitals.cpu.utilisationPercent <= 100);
  assert.ok(vitals.cpu.intervalMs > 0);
  assert.ok(Number.isSafeInteger(vitals.uptimeSeconds) && vitals.uptimeSeconds >= 0);
  for (const value of [vitals.memory.totalBytes, vitals.memory.availableBytes, ...vitals.filesystems.flatMap(fs => [fs.totalBytes, fs.freeBytes])]) assert.ok(Number.isSafeInteger(value) && value >= 0);
  assert.ok(vitals.memory.availableBytes <= vitals.memory.totalBytes);
  assert.ok(vitals.filesystems.length > 0 && vitals.filesystems.length <= 128);
  for (const fs of vitals.filesystems) { assert.ok(fs.freeBytes <= fs.totalBytes); assert.ok(Buffer.byteLength(fs.mount) <= 1024); }
  assert.deepEqual(Object.keys(vitals).sort(), ["cpu", "filesystems", "memory", "sampledAt", "uptimeSeconds"]);
  const identity = daemon.status().account!.machineId!;
  const managers = Array.from({ length: 100 }, (_, i) => ({ spaceId: `space-${i}`, instanceId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
  await requestAccountMachine({ dir: machineHome, idpUrl, machineId: identity, method: "PUT", metadata: { name: "capacity", platform: "linux", daemonVersion: "test", managers, vitals } });
  await until(() => Array.isArray(registration?.managers) && registration.managers.length === 100, "100 Managers plus vitals register");
  const beforeOversize = puts;
  await assert.rejects(() => requestAccountMachine({ dir: machineHome, idpUrl, machineId: identity, method: "PUT", metadata: { name: "x".repeat(16384), platform: "linux", daemonVersion: "test", managers: [], vitals } }), /exceeds 16384 bytes/);
  assert.equal(puts, beforeOversize, "oversized registration refuses before network");
  assert.equal(accountComputerId(machineHome, { issuer, sub: "owner" }), identity);
  assert.notEqual(accountComputerId(machineHome, { issuer, sub: "other" }), identity);
  const records = readdirSync(join(machineHome, "daemon", "accounts"));
  assert.ok(records.every(key => (statSync(join(machineHome, "daemon", "accounts", key, "computer.json")).mode & 0o777) === 0o600));
  const reply = await queryDaemon({ paths }); assert.ok(reply.ok && reply.result.account?.hostSupport === "supported");
  malformed = true; revision = 2;
  await until(() => daemon.status().account?.message === "invalid computer binding revisions", "malformed binding map is reported without applying revision");
  assert.equal(daemon.status().account!.desiredRevision, 1);
  malformed = false;
  mode = 304; const before = gets;
  await until(() => gets > before, "conditional 304 poll");
  assert.equal(conditional, etag); assert.equal(daemon.status().account!.desiredRevision, 1);
  mode = 503; const errors = gets;
  await until(() => gets > errors && daemon.status().account?.cloud?.state === "retrying" && daemon.status().account?.mode === "account", "503 keeps the account mode and retries");
  assert.equal(daemon.status().account!.desiredRevision, 1);
  assert.equal(daemon.status().account!.message, undefined);
  assert.equal(daemon.status().account!.cloud?.reason, "refused");
  assert.equal(daemon.status().account!.cloud?.notice, undefined);
  const quiet = gets;
  await sleep(70_000);
  assert.ok(gets > quiet, "the refusal keeps being asked during the quiet minute");
  const outage = "Cotal Cloud refused this computer. Cotal asks again by itself.";
  assert.equal(daemon.status().account?.cloud?.notice, outage);
  assert.equal(daemon.status().account?.message, outage);
  let mark = gets;
  const settled = Date.now() + 20_000;
  for (;;) { await sleep(400); if (gets === mark || Date.now() > settled) break; mark = gets; }
  assert.equal(gets, mark, "the retry settles before the status read");
  const waiting = gets;
  const { stdout: heldStatus } = await promisify(execFile)(process.execPath, ["--import", "tsx", "bin/cotal.ts", "daemon", "status", "--daemon-home", machineHome], { env: { ...process.env, COTAL_HOME: join(root, "cli-cotal"), XDG_RUNTIME_DIR: runtime } });
  await sleep(1_000);
  assert.equal(gets, waiting, "a status read reports the held state and does not ask the host");
  assert.match(heldStatus, /Cotal Cloud refused this computer\. Cotal asks again by itself\./);
  console.log("ok a quiet minute names the outage and a status read waits");
  mode = 304; const recovered = gets;
  await until(() => gets > recovered && daemon.status().account?.cloud === undefined && daemon.status().account?.message === undefined, "a later unchanged poll clears the retry", 360_000);
  mode = 401; const denied = gets; const deniedTokens = tokens;
  await until(() => gets > denied && tokens > deniedTokens && daemon.status().account?.cloud?.state === "retrying" && daemon.status().account?.mode === "account", "one bare 401 keeps the account and checks the session");
  assert.equal(daemon.status().account!.cloud?.reason, "refused");
  const second = gets;
  await until(() => gets > second && daemon.status().account?.mode === "sign-in-required", "a second bare 401 asks for a sign-in", 15_000);
  assert.equal(daemon.status().account!.message, "Sign in again.");
  const stoppedBare = gets; await sleep(5_500); assert.equal(gets, stoppedBare, "a bare refusal stops after two");
  await daemon.close(); mode = 200; refusal = undefined; const fresh = gets;
  daemon = await serveDaemon({ paths, version: "0.157.2", sessionDir: machineHome });
  await until(() => gets > fresh, "a fresh sign-in asks the host again", 20_000);
  mode = 403; const forbidden = gets;
  await until(() => gets > forbidden && daemon.status().account?.mode === "account" && daemon.status().account?.cloud?.state === "retrying", "one 403 keeps the account");
  tokenBody = {}; mode = 403; const rejected = gets;
  await until(() => gets > rejected && daemon.status().account?.mode === "sign-in-required" && daemon.status().account?.message === "Sign in again.", "a rejected session asks for a sign-in and stops");
  const stoppedRejected = gets; await sleep(5_500); assert.equal(gets, stoppedRejected);
  await daemon.close(); mode = 200; tokenBody = { token: "fixture-jwt" }; const returned = gets;
  daemon = await serveDaemon({ paths, version: "0.157.2", sessionDir: machineHome });
  await until(() => gets > returned, "registration is asked again after the rejected session", 20_000);
  mode = 429; retryAfter = "9"; const limited = gets; const limitedAt = Date.now();
  await until(() => gets > limited && daemon.status().account?.cloud?.reason === "rate-limited", "a rate limit keeps the account");
  let held = gets; const heldUntil = Date.now() + 3_000;
  for (;;) { await sleep(300); if (gets === held || Date.now() > heldUntil) break; held = gets; }
  assert.equal(gets, held, "the rate-limited poll settles");
  const afterLimit = gets;
  await sleep(4_000);
  assert.equal(gets, afterLimit, "the rate limit waits for the host's retry-after");
  await until(() => gets > afterLimit, "the rate limit is asked again after the host's wait", 8_000);
  assert.ok(Date.now() - limitedAt >= 8_000, "the observed wait covers the host's nine seconds");
  retryAfter = undefined;
  mode = 200; revision = 3; const healing = gets;
  await until(() => gets > healing && daemon.status().account?.cloud === undefined && daemon.status().account?.desiredRevision === 3, "a later 200 clears the retry", 20_000);
  refusal = { code: "computer-removed" }; mode = 401; const removed = gets;
  let removalSeen = false;
  try {
    await until(() => gets > removed && daemon.status().account?.mode === "sign-in-required" && daemon.status().account?.reason === "computer-removed", "a removed computer asks for a sign-in", 20_000);
    removalSeen = true;
  } catch { console.log("removal not observed"); }
  if (removalSeen) {
    assert.equal(daemon.status().account!.message, "This computer was removed from your account. Sign in to add it back.");
    const halted = gets; await sleep(5500); assert.equal(gets, halted);
  }
  await daemon.close(); mode = 404;
  daemon = await serveDaemon({ paths, version: "0.157.2", sessionDir: machineHome });
  await until(() => daemon.status().account?.mode === "per-space", "404 explicitly reports unsupported per-space mode");
  assert.equal(daemon.status().account!.machineId, identity);
  const unsupported = puts; await sleep(5500); assert.equal(puts, unsupported);
  await daemon.close(); mode = 200; holdGet = true;
  const pending = gets;
  daemon = await serveDaemon({ paths, version: "0.157.2", sessionDir: machineHome });
  await until(() => gets > pending, "initial account request can remain pending after local readiness");
  const ready = await queryDaemon({ paths }); assert.ok(ready.ok);
  const closing = daemon.close();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closing, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("shutdown waited for pending account reply")), 5000); })]);
  } finally { if (deadline) clearTimeout(deadline); }
  assert.equal(existsSync(paths.socket), false, "shutdown cancels initial account poll before releasing endpoint");
  console.log("ok shutdown cancels pending initial account check");
  const signedOutHome = join(root, "signed-out");
  mkdirSync(signedOutHome, { mode: 0o700 });
  const signedOutPaths = daemonPathsFor(signedOutHome, { XDG_RUNTIME_DIR: runtime });
  daemon = await serveDaemon({ paths: signedOutPaths, version: "0.157.2", sessionDir: signedOutHome });
  await until(() => !!daemon.status().vitals, "signed-out daemon has an initial sample");
  const firstSample = daemon.status().vitals!.sampledAt;
  await until(() => daemon.status().vitals?.sampledAt !== firstSample, "signed-out daemon refreshes computer vitals");
  const refreshed = await queryDaemon({ paths: signedOutPaths });
  assert.ok(refreshed.ok && refreshed.result.account?.mode === "signed-out");
  assert.notEqual(refreshed.result.vitals?.sampledAt, firstSample);
  console.log(`account computers smoke passed; retained private fixture ${root}`);
} finally { await daemon.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }

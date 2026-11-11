/** Real daemon endpoint against account-computer HTTP routes, in a private machine home. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { saveIdpSession } from "@cotal-ai/auth";
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
let malformed = false;
let mode = 200, puts = 0, gets = 0;
let revision = 1;
let etag = '"one"';
let conditional: string | undefined;
let persistedBeforePut = false;
let holdGet = false;
const fixture = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  assert.equal(req.headers.authorization, "Bearer fixture-session");
  const machine = req.url?.match(/^\/api\/cli\/machines\/([0-9a-f-]+)(\/spaces)?$/);
  if (!machine) { res.writeHead(404); res.end("{}"); return; }
  if (req.method === "PUT") {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => { registration = JSON.parse(body) as Record<string, unknown>; });
    puts++;
    persistedBeforePut = readdirSync(join(machineHome, "daemon", "accounts"), { recursive: true }).some(path => String(path).endsWith("computer.json"));
    if (mode === 404) { res.writeHead(404); res.end("{}"); return; }
    res.end(JSON.stringify({ v: 1, machine: { id: machine[1], lastSeenAt: new Date().toISOString(), revision } })); return;
  }
  gets++; conditional = req.headers["if-none-match"] as string | undefined;
  if (holdGet) return;
  if (mode !== 200) { res.writeHead(mode); res.end(mode === 304 ? undefined : "{}"); return; }
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
async function until(test: () => boolean, label: string) {
  const end = Date.now() + 12_000;
  while (!test() && Date.now() < end) await sleep(50);
  assert.ok(test(), label);
  console.log(`ok ${label}`);
}
try {
  await until(() => gets > 0 && daemon.status().account?.desiredRevision === 1, "registered and applied complete desired set");
  assert.ok(persistedBeforePut);
  assert.ok(registration?.vitals, "registration carries a measured sample");
  assert.deepEqual(registration.vitals, daemon.status().vitals, "status exposes the sent sample");
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
  await until(() => gets > errors, "503 leaves desired revision unchanged");
  assert.equal(daemon.status().account!.desiredRevision, 1);
  assert.equal(daemon.status().account!.message, "account computer request failed; existing connections are unchanged");
  mode = 304; const recovered = gets;
  await until(() => gets > recovered && daemon.status().account?.message === undefined, "an unchanged poll after a failed one clears the failure message");
  mode = 401; const denied = gets;
  await until(() => gets > denied && daemon.status().account?.mode === "sign-in-required", "401 surfaces sign in again");
  const halted = gets; await sleep(5500); assert.equal(gets, halted);
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
  console.log(`account computers smoke passed; retained private fixture ${root}`);
} finally { await daemon.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }

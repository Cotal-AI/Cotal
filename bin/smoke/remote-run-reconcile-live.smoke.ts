/** Restart the shipped participant Manager over a delayed TCP link with the stock operator JWT. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createRunSpec, MANAGER_LEASE_TTL_MS, mintConnectionEvictorCreds, mintCreds, mintLifecycleUid, mintMembershipObserverCreds,
  newIdentity, openRecordsBucket, recordsBucket, setupSpaceStreams, writeRunStatus, type RunStatusView,
} from "@cotal-ai/core";
import {
  deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, saveIdpSession, startAuthService,
} from "@cotal-ai/auth";
import { startDeliveryService } from "@cotal-ai/delivery";
import {
  connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, recordMesh, userAuthStateDir,
} from "@cotal-ai/workspace";
import { emitSentinel, killAndAwaitExit, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { openAuthorityClient } from "../../implementations/auth/src/authority-client.js";
import { startHostedAuthFixture } from "../../implementations/auth/smoke/_hosted-auth-fixture.js";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("COTAL_") || key.startsWith("NATS_")) delete process.env[key];
}
const root = mkdtempSync(join(tmpdir(), "remote-run-reconcile-"));
const keep = process.env.SMOKE_KEEP_REMOTE_RUN_RECONCILE === "1";
const releaseRoot = keep ? () => {} : teardownPathOnSignal(root);
const home = join(root, "home"), config = join(root, "config"), runtime = join(root, "runtime"), participant = join(root, "participant");
for (const path of [home, config, runtime, join(participant, ".cotal")]) mkdirSync(path, { recursive: true, mode: 0o700 });
const homeEnv = { HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), LOCALAPPDATA: join(root, "local") };
process.env.COTAL_HOME = home;
Object.assign(process.env, homeEnv);
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: tmpdir(), ...homeEnv,
  COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
const cli = resolve("bin/dist/cotal.js");

const HISTORY = 550;
let oneWayMs = 0;
let expirations = 0;
const sockets = new Set<Socket>();

/** Delay each chunk by the same propagation time without serializing chunks within a response. */
function forward(from: Socket, to: Socket, inspect?: (text: string) => void): void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void) => {
    if (oneWayMs === 0) { fn(); return; }
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, oneWayMs);
    timers.add(timer);
  };
  from.on("data", (data: Buffer) => {
    inspect?.(data.toString("latin1"));
    later(() => { if (!to.destroyed) to.write(data); });
  });
  from.on("end", () => later(() => to.end()));
  to.on("close", () => { for (const timer of timers) clearTimeout(timer); timers.clear(); });
}

function relayTo(port: number) {
  return createServer({ allowHalfOpen: true }, (client) => {
    const broker = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    for (const socket of [client, broker]) {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => { sockets.delete(socket); client.destroy(); broker.destroy(); });
    }
    let tail = "";
    forward(client, broker);
    forward(broker, client, (chunk) => {
      const lines = (tail + chunk).split("\r\n");
      tail = lines.pop()!.slice(-128);
      expirations += lines.filter((line) => line.startsWith("-ERR") && line.includes("User Authentication Expired")).length;
    });
  });
}

function supervise(space: string) {
  const child = spawn(process.execPath, [cli, "supervise", "--space", space], { cwd: participant, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function managerUp(manager: ReturnType<typeof supervise>): Promise<string> {
  const deadline = Date.now() + 100_000;
  while (!manager.output().includes("manager up") && manager.child.exitCode === null && manager.child.signalCode === null && Date.now() < deadline) await wait(100);
  assert.match(manager.output(), /manager up/);
  const instance = /activating registered instance ([a-z0-9]+)/.exec(manager.output())?.[1];
  assert.ok(instance, "the shipped supervisor must have registered as a participant");
  return instance;
}

async function crash(manager: ReturnType<typeof supervise>): Promise<void> {
  await killAndAwaitExit(manager.child, "SIGKILL");
  // Keep the restart away from the race between lease creation and expiration of the dead holder's row.
  await wait(MANAGER_LEASE_TTL_MS + oneWayMs);
}

async function run<T>(space: string, instance: string, ...args: string[]): Promise<T> {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, "run", ...args, "--space", space, "--on", instance, "--json"], { cwd: participant, env, timeout: 35_000 });
  return (JSON.parse(stdout) as { result: T }).result;
}

async function setUpAuthority(fx: Awaited<ReturnType<typeof startHostedAuthFixture>>, origin: string) {
  const a = fx.accounts[0]!;
  const { space, auth, store, stateDir, accountPublicKey } = a;
  const idpUrl = `${origin}/api/auth`;
  unlinkSync(join(stateDir, "idp.json"));
  ensurePinnedIdp(stateDir, idpUrl);
  const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(store, space))!, origin, "run-owner");
  grantActor(stateDir, { owner, actor: "cli", scope: ["supervise", "run"], allowSubscribe: [">"], allowPublish: [">"] });
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const composition = { injected: true as const };
  await store.put(deliveryCredsKey(space, composition), await mintCreds(auth, newIdentity(), "delivery"));
  await store.put(membershipRwCredsKey(space, composition), await mintCreds(auth, newIdentity(), "membership-rw"));
  await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auth, newIdentity()));
  await store.put(connectionEvictorCredsKey(space, composition), await mintConnectionEvictorCreds(auth, newIdentity()));
  const inputs = { space, servers: fx.servers, store, storeIdentity: store.identity, stateDir, context: { accountPublicKey, lifecycleUid: mintLifecycleUid() } };
  const service = await startAuthService({ ...inputs, publicFace: { port: 0, trustedProxy: false } });
  try {
    const delivery = await startDeliveryService({ ...inputs, context: { accountPublicKey, lifecycleUid: mintLifecycleUid() } });
    return { service, delivery, idpUrl };
  } catch (error) { await service.close(); throw error; }
}

async function seedTerminalRuns(fx: Awaited<ReturnType<typeof startHostedAuthFixture>>) {
  const { space, auth } = fx.accounts[0]!;
  const records = recordsBucket(space);
  const writer = await openAuthorityClient({ server: fx.servers, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! },
    label: "smoke-terminal-history", grants: (id) => ({ publish: ["$JS.API.INFO", `$KV.${records}.run.manager.*.*`], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  try {
    const kv = await openRecordsBucket(writer.nc, space);
    const at = Date.now();
    for (let i = 0; i < HISTORY; i++) {
      const id = `run-${i.toString(16).padStart(32, "0")}`;
      const revision = await createRunSpec(kv, "manager", id, { createdAt: at, pins: { seed: id, startedAt: at, yieldEvery: 1, stepBudget: 1, effectCeiling: 1, languageVersion: "1" } });
      await writeRunStatus(kv, "manager", id, { observedSpecRevision: revision, state: "completed", holder: "smoke-history", epoch: 1, fencingToken: 1, journalHigh: 0, at });
    }
  } finally { await writer.close(); }
}

async function checkRestart(space: string, instance: string, runId: string, epoch: number, manager: ReturnType<typeof supervise>, label: string) {
  const started = Date.now();
  assert.equal(await managerUp(manager), instance);
  const elapsed = Date.now() - started;
  const boot = manager.output().split("\n").filter((line) => line.includes("workflow-run boot reconcile"));
  console.log(`${label}: ${elapsed} ms to manager up, ${expirations} broker JWT expirations, reconcile: ${boot.join(" | ")}`);
  assert.equal(expirations, 0, `${label}: the broker expired an operator connection`);
  assert.deepEqual(boot.map((line) => line.split("workflow-run boot reconcile: ")[1]), ["took back 1 run(s) recorded running"]);
  const { view } = await run<{ view: RunStatusView }>(space, instance, "show", runId);
  assert.equal(view.status?.state, "running");
  assert.equal(view.status.epoch, epoch);
  assert.equal(view.journal.filter((row) => row.kind === "activation").length, epoch);
  console.log(`${label}: inherited checkpoint is running at epoch ${epoch}`);
}

const fx = await startHostedAuthFixture("remote-reconcile", 1, { keepFiles: keep });
const space = fx.accounts[0]!.space;
const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "run-reconcile", alg: "EdDSA" };
const session = "fixture-sign-in";
let origin = "";
const idp = createHttpServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/jwks") { res.end(JSON.stringify({ keys: [jwk] })); return; }
  if (req.url === "/api/auth/token" && req.headers.authorization === `Bearer ${session}`) {
    const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject("run-owner").setIssuedAt().setExpirationTime("10m").sign(key.privateKey);
    res.end(JSON.stringify({ token })); return;
  }
  res.writeHead(404).end("{}");
});
const relay = relayTo(Number(new URL(fx.servers).port));
let authority: Awaited<ReturnType<typeof setUpAuthority>> | undefined;
let manager: ReturnType<typeof supervise> | undefined;
try {
  await new Promise<void>((yes, no) => { idp.once("error", no).listen(0, "127.0.0.1", yes); });
  origin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  await new Promise<void>((yes, no) => { relay.once("error", no).listen(0, "127.0.0.1", yes); });
  authority = await setUpAuthority(fx, origin);
  const { idpUrl, service } = authority;
  saveIdpSession(home, idpUrl, { token: session, expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "run-owner" });
  const state = userAuthStateDir(participant, space);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const sentinel = join(state, "sentinel.creds");
  writeFileSync(sentinel, fx.accounts[0]!.sentinelCreds, { mode: 0o600 });
  recordMesh({ space, server: `nats://127.0.0.1:${(relay.address() as AddressInfo).port}`, root: participant, mode: "user", origin: "manual",
    policy: { events: "required" }, ts: new Date().toISOString(), userAuth: { provider: "cotal", remote: true, idp: { url: idpUrl, issuer: origin, audience: origin }, endpoints: { url: service.publicUrl! }, sentinelCredsPath: sentinel } });
  const file = join(root, "parked.cotal.js");
  writeFileSync(file, 'await checkpoint("keep", "Continue?");\n');
  manager = supervise(space);
  const instance = await managerUp(manager);
  const { result: { runId } } = await run<{ result: { runId: string } }>(space, instance, "start", "--file", file);
  const { view } = await run<{ view: RunStatusView }>(space, instance, "show", runId);
  assert.equal(view.status?.state, "running");
  assert.equal(view.status.epoch, 1);
  await crash(manager);

  // Same broker, signerless participant and 160 ms RTT in both cells. History is the only load
  // added before the second restart; the parked run itself was admitted by shipped `cotal run`.
  oneWayMs = 80;
  manager = supervise(space);
  await checkRestart(space, instance, runId, 2, manager, "positive control");
  await crash(manager);
  await seedTerminalRuns(fx);
  manager = supervise(space);
  await checkRestart(space, instance, runId, 3, manager, `${HISTORY} completed runs`);
  await run(space, instance, "answer", runId, "/checkpoint:keep#0", "--value", '"go"');
  const completedBy = Date.now() + 15_000;
  for (;;) {
    const { view: done } = await run<{ view: RunStatusView }>(space, instance, "show", runId);
    if (done.status?.state === "completed") {
      assert.equal(done.status.epoch, 3);
      console.log("the checkpoint answer completed the run at epoch 3");
      break;
    }
    assert.ok(Date.now() < completedBy, "the taken-back run did not complete after its answer");
    await wait(200);
  }
  emitSentinel({ passed: 2, failed: 0 });
} finally {
  if (manager) await killAndAwaitExit(manager.child, "SIGTERM");
  for (const s of sockets) s.destroy();
  if (relay.listening) await new Promise<void>((done) => relay.close(() => done()));
  try { await authority?.service.close(); }
  finally {
    try { await authority?.delivery.close(); }
    finally {
      if (idp.listening) await new Promise<void>((done) => { idp.close(() => done()); idp.closeAllConnections(); });
      await fx.close();
      if (!keep) rmSync(root, { recursive: true, force: true });
      releaseRoot();
    }
  }
}

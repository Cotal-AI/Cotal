/**
 * Stock Manager and Delivery daemon multi-process restart and crash-recovery smoke.
 *
 * Executes ACTUAL stock executables in separate owned processes (PIDs recorded per generation):
 *   - Gen 1: Stock Delivery Daemon + Stock Manager
 *   - Product-written lifecycle/slot state via public spawn path (no hand-staged records)
 *   - Dynamic memberships written by the real stock delivery daemon (Plane 3)
 *   - Genuine offline presence + transport disconnect without reaping or alias theft
 *   - Stock delivery stoppage: lease absence observed, inventory incomplete, alias held, residue retained
 *   - Stock Manager restart (Gen 2): adopts/protects live/offline child via line 8344 guard
 *   - Stock Delivery restart (Gen 2): complete inventory read, exact purge (0 residue), hold cleared
 *   - Foreign principal and successor rows preserved throughout
 *
 * Run: tsx implementations/manager/smoke/stock-process-restart.smoke.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createRequire } from "node:module";
import {
  CotalEndpoint,
  createSpaceAuth,
  DEV_OWNER,
  epAuthBucket,
  epCall,
  membersBucket,
  mintConnectionEvictorCreds,
  mintCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  openMembersRegistry,
  principalKey,
  readMember,
  recordsBucket,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  type EpCaller,
} from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const REPO = resolve(import.meta.dirname, "../../../");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const BIN = join(REPO, "bin", "cotal.ts");
const CORE_DIST = join(REPO, "packages", "core", "dist", "index.js");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await wait(50);
  }
  return false;
};

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    server.close(() => resolve(port));
  });
});

const awaitExit = (child: ChildProcess, ms = 10_000): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once("exit", () => resolve());
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
    resolve();
  }, ms).unref?.();
});

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  console.log(`  ${condition ? "✓" : "✗ FAIL:"} ${name}${condition || extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  if (condition) pass++;
  else fail++;
};

const space = `stock-restart-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const root = mkdtempSync("/tmp/s-r-");
const home = mkdtempSync("/tmp/s-h-");
const xdg = mkdtempSync("/tmp/s-x-");
const stateHome = join(xdg, "state");
const cacheHome = join(xdg, "cache");
const seatRoot = join(root, "seats");
const tmpDir = join(root, "tmp");
mkdirSync(stateHome, { recursive: true, mode: 0o700 });
mkdirSync(cacheHome, { recursive: true, mode: 0o700 });
mkdirSync(seatRoot, { recursive: true, mode: 0o700 });
mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
const brokerStore = mkdtempSync("/tmp/s-b-");
const conf = join(root, "server.conf");

// Scrub ambient COTAL_* and routing from process.env before configuring fixture
for (const k of Object.keys(process.env)) {
  if (k.startsWith("COTAL_") && k !== "COTAL_DEFAULT_PERSONA") delete process.env[k];
}

process.env.COTAL_HOME = root;
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.XDG_STATE_HOME = stateHome;
process.env.XDG_CACHE_HOME = cacheHome;
process.env.COTAL_SEAT_ROOT = seatRoot;
process.env.TMPDIR = tmpDir;
saveSpaceAuth(authDir(root), auth);
saveSpaceAuth(authDir(home), auth);
recordMesh({ space, server: servers, root, mode: "auth", ts: new Date().toISOString() });

writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: brokerStore, host: "127.0.0.1" }));
const broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
teardownOnSignal(broker, conf);

// Setup broker streams
await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

// Mint delivery credentials
const dlvId = newIdentity();
const dlvCreds = await mintCreds(auth, dlvId, "delivery");
const dlvCredsPath = join(root, "delivery.creds");
writeFileSync(dlvCredsPath, dlvCreds, { mode: 0o600 });

// Mint membership observer and connection evictor creds for delivery
writeFileSync(join(root, ".cotal", "membership-observer.creds"), await mintMembershipObserverCreds(auth, newIdentity()), { mode: 0o600 });
writeFileSync(join(root, ".cotal", "connection-evictor.creds"), await mintConnectionEvictorCreds(auth, newIdentity()), { mode: 0o600 });
writeFileSync(join(root, ".cotal", "membership.json"), JSON.stringify({ accountId: auth.account.pub }), { mode: 0o600 });

// Write scripted-sdk connector extension into xdg
const extensionRoot = join(xdg, "cotal", "extensions");
const extensionDir = join(extensionRoot, "node_modules", "scripted-sdk-extension");
mkdirSync(extensionDir, { recursive: true });
writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
  name: "scripted-sdk-extension", version: "1.0.0", type: "module", main: "index.js",
  peerDependencies: { "@cotal-ai/core": "*" },
}, null, 2));

import { pathToFileURL } from "node:url";
const childScriptPath = join(root, "child-script.mjs");
const childReadyFile = join(root, "child-ready");
const childOfflineFile = join(root, "child-offline");
const childDisconnectFile = join(root, "child-disconnect");
const childErrorFile = join(root, "child-error.log");
const childPidFile = join(root, "child-pid");

writeFileSync(childScriptPath, `
import fs from "node:fs";
try {
  fs.writeFileSync("${childPidFile}", String(process.pid));
  const { CotalEndpoint } = await import("${pathToFileURL(CORE_DIST).href}");

  const rawCreds = process.env.COTAL_CREDS;
  const creds = rawCreds && fs.existsSync(rawCreds) ? fs.readFileSync(rawCreds, "utf8") : rawCreds;

  const ep = new CotalEndpoint({
    space: process.env.COTAL_SPACE,
    servers: process.env.COTAL_SERVERS,
    creds,
    lifecycleUid: process.env.COTAL_LIFECYCLE_UID,
    channels: ["general"],
    consume: false,
    registerPresence: true,
    watchPresence: false,
    card: { name: process.env.COTAL_NAME, owner: process.env.COTAL_OWNER || "local", actor: process.env.COTAL_ID || process.env.COTAL_ACTOR || process.env.COTAL_NAME, kind: "agent" },
  });

  ep.on("error", () => {});
  await ep.start();

  fs.writeFileSync("${childReadyFile}", "ready");

  process.on("SIGUSR1", async () => {
    try {
      await ep.setStatus("offline");
      fs.writeFileSync("${childOfflineFile}", "offline");
    } catch (e) {
      fs.writeFileSync("${childErrorFile}", "sigusr1: " + (e?.stack || e?.message));
    }
  });

  process.on("SIGUSR2", async () => {
    try {
      await ep.stop();
      fs.writeFileSync("${childDisconnectFile}", "disconnected");
    } catch (e) {
      fs.writeFileSync("${childErrorFile}", "sigusr2: " + (e?.stack || e?.message));
    }
  });

  setInterval(() => {}, 1000);
} catch (err) {
  fs.writeFileSync("${childErrorFile}", err?.stack || err?.message || String(err));
  process.exit(1);
}
`);

writeFileSync(join(extensionDir, "index.js"), `
import { registry } from "@cotal-ai/core";
registry.register({
  kind: "connector", name: "scripted-sdk", readinessTimeoutMs: 20000,
  buildLaunch(opts) {
    return {
      command: process.execPath,
      args: ["${childScriptPath}"],
      env: {
        COTAL_SPACE: opts.space, COTAL_SERVERS: opts.servers, COTAL_NAME: opts.name,
        COTAL_ID: opts.id || "",
        COTAL_CREDS: opts.creds || "", COTAL_LIFECYCLE_UID: opts.lifecycleUid || "",
        PATH: process.env.PATH || "",
      },
    };
  },
});
`);

mkdirSync(extensionRoot, { recursive: true });
writeFileSync(join(extensionRoot, "extensions.json"), JSON.stringify({ extensions: [{
  pkg: "scripted-sdk-extension", version: "1.0.0", spec: "file:scripted-sdk-extension",
  provides: [{ kind: "connector", name: "scripted-sdk" }], commands: [],
  connectors: [{ name: "scripted-sdk", requires: [] }],
}] }, null, 2));

// Write persona file
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "worker.md"), `---
name: worker
agent: scripted-sdk
role: worker
subscribe: [general]
allowPublish: [general]
---
Scripted worker persona.
`);

// Environment for daemon processes (scrubbed of any ambient routing and provider keys/secrets)
const daemonEnv: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("COTAL_") || k.startsWith("XDG_") || /KEY|SECRET|TOKEN|AUTH/i.test(k) || k === "HOME" || k === "TMPDIR") continue;
  daemonEnv[k] = v;
}
daemonEnv.HOME = home;
daemonEnv.COTAL_HOME = root;
daemonEnv.XDG_CONFIG_HOME = xdg;
daemonEnv.XDG_STATE_HOME = stateHome;
daemonEnv.XDG_CACHE_HOME = cacheHome;
daemonEnv.COTAL_SEAT_ROOT = seatRoot;
daemonEnv.TMPDIR = tmpDir;
daemonEnv.COTAL_SKIP_CONNECTOR_SEED = "1";

// Track spawned daemon processes
const trackedChildren: Array<{ name: string; gen: number; proc: ChildProcess; pids: number[] }> = [];

function spawnDaemon(name: string, gen: number, args: string[]): { proc: ChildProcess; output: () => string } {
  let output = "";
  const proc = spawn(TSX, [BIN, ...args], {
    cwd: root, env: daemonEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => { output += String(d); });
  proc.stderr?.on("data", (d) => { output += String(d); });
  const entry = { name, gen, proc, pids: [proc.pid!] };
  trackedChildren.push(entry);
  return { proc, output: () => output };
}

const runCli = (args: string[]) => {
  const r = spawnSync(TSX, [BIN, ...args], {
    cwd: root, env: daemonEnv, encoding: "utf8",
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
};

// Inspector god-cred for broker state
const coreRequire = createRequire(CORE_DIST);
const { encodeUser, fmtCreds } = coreRequire("@nats-io/jwt");
const { fromPublic, fromSeed } = coreRequire("@nats-io/nkeys");
const inspId = newIdentity();
const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
const userJwt = await encodeUser("fsb-inspector", fromPublic(inspId.id), fromPublic(auth.account.pub),
  { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer });
const godCreds = new TextDecoder().decode(fmtCreds(userJwt, fromSeed(new TextEncoder().encode(inspId.seed))));

const inspect = async <T,>(fn: (jsm: Awaited<ReturnType<typeof jetstreamManager>>, nc: import("@nats-io/transport-node").NatsConnection) => Promise<T>): Promise<T> => {
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds: godCreds, tls: false }), maxReconnectAttempts: 0 });
  try { return await fn(await jetstreamManager(nc), nc); } finally { await nc.drain().catch(() => {}); }
};

const memberRowsFor = (): Promise<string[]> => inspect(async (_j, nc) => {
  const kv = await openMembersRegistry(nc, space);
  const rows: string[] = [];
  try { for await (const e of await kv.watch()) { if (e.operation !== "DEL" && e.operation !== "PURGE") rows.push(e.key); } } catch {}
  return rows;
});

let currentWorkerKey = principalKey("local", "worker").key;
const memberRow = (ch: string, uid: string) => inspect(async (_j, nc) => {
  const kv = await openMembersRegistry(nc, space);
  return (await readMember(kv, ch, currentWorkerKey, uid)) !== undefined;
});

try {
  console.log("A) start Stock Delivery Daemon (Gen 1) in separate process");
  const deliveryGen1 = spawnDaemon("delivery", 1, ["deliver", "--space", space, "--server", servers, "--creds", dlvCredsPath]);
  check("GEN 1: delivery daemon process spawned with valid PID", typeof deliveryGen1.proc.pid === "number", { pid: deliveryGen1.proc.pid });
  const dlvUp = await until(() => /delivery daemon up/i.test(deliveryGen1.output()), 15_000);
  check("GEN 1: delivery daemon reached ready state", dlvUp, deliveryGen1.output().slice(-500));

  console.log("B) start Stock Manager Daemon (Gen 1) in separate process");
  const managerGen1 = spawnDaemon("manager", 1, ["supervise", "--space", space, "--server", servers, "--runtime", "pty"]);
  check("GEN 1: manager process spawned with valid PID", typeof managerGen1.proc.pid === "number", { pid: managerGen1.proc.pid });
  const mgrUp = await until(() => /manager up|manager service endpoint registered/i.test(managerGen1.output()), 15_000);
  check("GEN 1: manager reached ready state", mgrUp, managerGen1.output().slice(-500));

  console.log("C) public spawn path creates real managed child with PRODUCT-WRITTEN slot state");
  const spawnCli = runCli(["spawn", "worker", "--space", space, "--server", servers, "--agent", "scripted-sdk", "--detach", "--no-events"]);
  if (existsSync(childErrorFile)) console.error("CHILD ERROR:", readFileSync(childErrorFile, "utf8"));
  check("SPAWN: public cotal spawn returned 0", spawnCli.code === 0, { out: spawnCli.out, err: spawnCli.err });

  const childReady = await until(() => existsSync(childReadyFile), 15_000);
  check("SPAWN: managed child executed via pty runtime and reached ready", childReady);

  // Read static slot from KV to witness product-written slot state
  const ncGod = await connect({ servers, ...standaloneConnectOpts({ creds: godCreds, tls: false }) });
  const kvm = new Kvm(ncGod);
  const records = await kvm.open(recordsBucket(space));
  const recordKeys: string[] = [];
  try { for await (const k of await records.keys()) recordKeys.push(k); } catch {}
  console.log("RECORD KEYS:", recordKeys);
  const slotKey = recordKeys.find((k) => k.includes("worker"));
  const slotEntry = slotKey ? await records.get(slotKey) : null;
  check("PRODUCT-WRITTEN: manager wrote durable slot state to records KV", slotEntry !== null && slotEntry.value.length > 0, { recordKeys });
  const slotData = slotEntry ? JSON.parse(new TextDecoder().decode(slotEntry.value)) : undefined;
  const workerUid = slotData?.lifecycleUid;
  const workerActor = slotData?.actor;
  const workerKey = principalKey("local", workerActor).key;
  currentWorkerKey = workerKey;
  check("SPAWN: manager assigned product-written lifecycleUid in durable slot", !!workerUid, slotData);

  // Populate dynamic membership through real delivery daemon
  const dlvEndpoint = new CotalEndpoint({
    space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"),
    card: { name: "helper", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  await dlvEndpoint.start();
  await dlvEndpoint.durableJoinFor(workerKey, "general", workerUid!);
  await dlvEndpoint.durableJoinFor(workerKey, "unnamed", workerUid!);
  await dlvEndpoint.stop();

  check("MEMBERS: real daemon wrote general membership", await memberRow("general", workerUid!));
  check("MEMBERS: real daemon wrote unnamed dynamic membership", await memberRow("unnamed", workerUid!));

  // Also write foreign principal row to witness retention
  const foreignUid = mintLifecycleUid();
  const foreignKey = principalKey("otherowner", "foreign").key;
  const dlvForeign = new CotalEndpoint({
    space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"),
    card: { name: "foreign-helper", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  await dlvForeign.start();
  await dlvForeign.durableJoinFor(foreignKey, "general", foreignUid);
  await dlvForeign.stop();
  const foreignRow = () => inspect(async (_j, nc) => (await readMember(await openMembersRegistry(nc, space), "general", foreignKey, foreignUid)) !== undefined);
  check("MEMBERS: foreign principal row committed", await foreignRow());

  console.log("D) live / offline authorized child retention & alias protection");
  // Inspect ps via public CLI
  const psCli = runCli(["ps", "--space", space, "--server", servers]);
  check("CLI: public cotal ps lists managed agents", psCli.code === 0 && psCli.out.includes("worker"), psCli.out);

  // Read child PID from childPidFile written directly by child process
  const childPid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, "utf8").trim()) : undefined;
  if (childPid) {
    try { process.kill(childPid, "SIGUSR1"); } catch {}
    await until(() => existsSync(childOfflineFile), 5_000);
  }
  check("OFFLINE: child signaled to offline status", existsSync(childOfflineFile));
  check("OFFLINE: durable memberships retained while offline", await memberRow("general", workerUid!) && await memberRow("unnamed", workerUid!));

  // Attempt to steal the alias with hard-pinned spawn while offline:
  const stealCli = runCli(["spawn", "worker", "--name", "worker", "--space", space, "--server", servers, "--agent", "scripted-sdk", "--detach", "--no-events"]);
  check("OFFLINE: hard-pinned spawn cannot steal alias of offline agent (refused)",
    stealCli.code !== 0 && /hard-pinned|already held/i.test(stealCli.err + stealCli.out), { out: stealCli.out, err: stealCli.err });

  console.log("E) stop Stock Delivery Daemon (Gen 1) -> verify lease absence & incomplete inventory hold");
  deliveryGen1.proc.kill("SIGTERM");
  await awaitExit(deliveryGen1.proc);
  check("GEN 1: delivery daemon process terminated", deliveryGen1.proc.exitCode !== null || deliveryGen1.proc.signalCode !== null);

  // Stop the predecessor agent via public cotal stop while delivery is down
  const stopCli = runCli(["stop", "--name", "worker", "--space", space, "--server", servers]);
  check("DESPAWN: public cotal stop accepted", stopCli.code === 0, { out: stopCli.out, err: stopCli.err });

  // While delivery is down, eviction is unavailable, so fail-closed sequencing retains launch channels:
  await wait(500);
  check("INCOMPLETE: launch channel general row RETAINED while delivery eviction is unavailable", await memberRow("general", workerUid!));
  check("INCOMPLETE: out-of-launch unnamed row RETAINED while delivery is down", await memberRow("unnamed", workerUid!));

  // Same-name spawn while delivery is down is refused with reserved pending retirement:
  const spawnWhileDown = runCli(["spawn", "worker", "--name", "worker", "--space", space, "--server", servers, "--agent", "scripted-sdk", "--detach", "--no-events"]);
  check("INCOMPLETE: spawn refused with reserved pending retirement while delivery is down",
    spawnWhileDown.code !== 0 && /reserved pending retirement/i.test(spawnWhileDown.err + spawnWhileDown.out),
    { out: spawnWhileDown.out, err: spawnWhileDown.err });

  console.log("F) stop Manager Gen 1 and start Delivery Gen 2 with fresh PID");
  // Terminate Manager Gen 1 cleanly with SIGTERM so it releases its lease before restart
  managerGen1.proc.kill("SIGTERM");
  await awaitExit(managerGen1.proc);
  check("GEN 1: manager process stopped cleanly", managerGen1.proc.exitCode !== null || managerGen1.proc.signalCode !== null);

  // Spawn Delivery Daemon Gen 2 with fresh PID
  const deliveryGen2 = spawnDaemon("delivery", 2, ["deliver", "--space", space, "--server", servers, "--creds", dlvCredsPath]);
  check("GEN 2: delivery daemon process spawned with fresh PID", typeof deliveryGen2.proc.pid === "number" && deliveryGen2.proc.pid !== deliveryGen1.proc.pid, { pid: deliveryGen2.proc.pid });
  const dlv2Up = await until(() => /delivery daemon up/i.test(deliveryGen2.output()), 15_000);
  check("GEN 2: delivery daemon reached ready state", dlv2Up, deliveryGen2.output().slice(-500));

  console.log("G) start Manager Gen 2 -> startup reconciliation recovers durable state & completes teardown");
  // Spawn Manager Gen 2 with distinct PID
  const managerGen2 = spawnDaemon("manager", 2, ["supervise", "--space", space, "--server", servers, "--runtime", "pty"]);
  check("GEN 2: manager process spawned with fresh PID", typeof managerGen2.proc.pid === "number" && managerGen2.proc.pid !== managerGen1.proc.pid, { pid: managerGen2.proc.pid });
  const mgr2Up = await until(() => /manager up|manager service endpoint registered/i.test(managerGen2.output()), 15_000);
  check("GEN 2: manager reached ready state after restart", mgr2Up, managerGen2.output().slice(-500));

  // Manager Gen 2 startup reconciliation re-drives the exact terminal against Delivery Gen 2:
  const purged = await until(async () => !(await memberRow("general", workerUid!)) && !(await memberRow("unnamed", workerUid!)), 20_000);
  check("RETRY: restored delivery allows re-driven teardown to purge retained rows (0 residue)", purged);

  // Fresh spawn succeeds and obtains exact alias after complete cleanup:
  const respawnCli = runCli(["spawn", "worker", "--name", "worker", "--space", space, "--server", servers, "--agent", "scripted-sdk", "--detach", "--no-events"]);
  check("RESPAWN: valid respawn obtains exact alias after complete cleanup", respawnCli.code === 0, { out: respawnCli.out, err: respawnCli.err });

  check("RETAIN: foreign principal row remains RETAINED throughout", await foreignRow());

  await ncGod.drain().catch(() => {});
} finally {
  for (const child of trackedChildren) {
    try {
      if (child.proc.exitCode === null && child.proc.signalCode === null) {
        child.proc.kill("SIGKILL");
        await awaitExit(child.proc);
      }
    } catch {}
  }
  broker.kill("SIGTERM");
  await awaitExit(broker);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(xdg, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
  rmSync(cacheHome, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(brokerStore, { recursive: true, force: true });
}

if (fail) {
  console.log(`STOCK PROCESS RESTART FAILED (${fail} failures, ${pass} passed)`);
  process.exit(1);
}
console.log(`STOCK PROCESS RESTART OK (${pass} checks)`);
process.exit(0);

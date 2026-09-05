/*
 * Startup static-lifecycle convergence (#774).
 *
 * A real authenticated nats-server, an in-process Manager, durable lifecycle rows, and the existing
 * eviction-verdict boundary prove that one transient middle-row terminal failure is reported, held,
 * and re-driven by the same process without duplicating the lifecycle or retirement operation.
 *
 * Run: pnpm smoke:manager-reconcile-redrive
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  DEV_OWNER,
  createSpaceAuth,
  epAuthBucket,
  epCall,
  gateFreeze,
  gateObserve,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  principalKey,
  probeConnect,
  recordsBucket,
  registry,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  type Connector,
  type EpCaller,
  type EvictionResult,
  type LaunchOpts,
  type LaunchSpec,
  type StaticManagedSlotRow,
} from "@cotal-ai/core";
import { authDir, saveManagerInstanceIdentity, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_CONTRACTS, MANAGER_ENDPOINT, type ManagerStatus } from "../src/manager-service-contract.js";
import {
  activateStaticLifecycle,
  appendStaticCredentialRow,
  casStaticSlot,
  readStaticSlot,
  recordSlotCredential,
  staticLifecycleTransport,
} from "../src/static-lifecycle.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await wait(20);
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
const awaitExit = (child: ChildProcess, ms = 5_000): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once("exit", () => resolve());
  setTimeout(resolve, ms).unref?.();
});

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  console.log(`  ${condition ? "✓" : "✗ FAIL:"} ${name}${condition || extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  if (condition) pass++;
  else fail++;
};

const space = `reconcile-redrive-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), "cotal-reconcile-redrive-ws-"));
const brokerStore = mkdtempSync(join(tmpdir(), "cotal-reconcile-redrive-js-"));
const conf = join(root, "server.conf");
const managerInstanceId = mintLifecycleUid();
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(root), auth);
saveManagerInstanceIdentity(root, space, { instanceId: managerInstanceId, serveIdentity: newIdentity() });
writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: brokerStore, host: "127.0.0.1" }));
const broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });

let manager: Manager | undefined;
let shutdownManager: Manager | undefined;
let observer: Awaited<ReturnType<typeof connect>> | undefined;
let callerNc: Awaited<ReturnType<typeof connect>> | undefined;
const logs: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]): void => {
  logs.push(args.map(String).join(" "));
  realError(...args);
};

const identities = new Map<string, { actor: string; uid: string; principal: string }>();
const attempts = new Map<string, number>();
let firstEvictionEntered = false;
let releaseFirst!: () => void;
const firstEvictionRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
const seatStub = join(import.meta.dirname, "e2e-stub.mjs");
const envJoin = (opts: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: opts.space, COTAL_SERVERS: String(opts.servers ?? servers), COTAL_CREDS: String(opts.creds ?? ""),
  COTAL_ID: String(opts.id ?? ""), COTAL_LIFECYCLE_UID: String(opts.lifecycleUid ?? ""), COTAL_NAME: opts.name,
  PATH: process.env.PATH ?? "",
});
const connector: Connector = {
  kind: "connector",
  name: "reconcile-redrive-stub",
  requires: ["node"],
  buildLaunch: (opts): LaunchSpec => ({ command: process.execPath, args: [seatStub], env: envJoin(opts) }),
};
registry.register(connector);

async function writeOrphan(
  alias: string,
  foreignRetirementOp = false,
  ownerInstanceId = managerInstanceId,
  workspaceRoot = root,
): Promise<void> {
  const identity = newIdentity();
  const uid = mintLifecycleUid();
  const principal = principalKey(DEV_OWNER, identity.id).key;
  identities.set(alias, { actor: identity.id, uid, principal });
  mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${alias}.md`), `---\nname: ${alias}\nrole: worker\n---\nbody\n`);
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor: identity.id, lifecycleUid: uid, alias } });
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const transport = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    await activateStaticLifecycle(transport, { owner: DEV_OWNER, alias, actor: identity.id, lifecycleUid: uid, managerInstance: "orphaned-process", ownerInstanceId });
    const credentialId = `cred-${alias}`;
    await recordSlotCredential(transport, DEV_OWNER, alias, uid, credentialId);
    await appendStaticCredentialRow(transport, { lifecycleUid: uid, credentialId, holderPrincipal: principal, exp: Math.floor(Date.now() / 1000) + 3600 });
    const slot = await readStaticSlot(transport, DEV_OWNER, alias);
    await casStaticSlot(transport, { ...slot!.row, phase: "active" }, slot!.revision);
    if (foreignRetirementOp) {
      const gate = await gateObserve(transport, uid);
      await gateFreeze(transport, { lifecycleUid: uid, revision: gate!.revision, op: { kind: "retirement", opId: "f".repeat(26) } });
    }
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

async function slot(alias: string): Promise<StaticManagedSlotRow | undefined> {
  const records = await new Kvm(observer!).open(recordsBucket(space));
  return (await readStaticSlot(staticLifecycleTransport(records, records), DEV_OWNER, alias))?.row;
}

async function status(caller: EpCaller): Promise<ManagerStatus | undefined> {
  try {
    const result = await epCall(callerNc!, space, { mode: "one" }, { endpoint: MANAGER_ENDPOINT, command: "status", contract: MANAGER_CONTRACTS.status, caller }, { deadlineMs: 1_000, currentEpoch: async () => 0 });
    return result.reply.ok ? result.reply.data as ManagerStatus : undefined;
  } catch {
    return undefined;
  }
}

try {
  let serving = false;
  for (let i = 0; i < 80; i++) {
    const probe = await probeConnect(servers, { timeoutMs: 300 });
    if (probe.ok || probe.reason === "auth-required") { serving = true; break; }
    await wait(50);
  }
  check("the real authenticated broker is serving", serving);
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  for (const alias of ["orphan-first", "orphan-middle", "orphan-last"]) await writeOrphan(alias);

  observer = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }), maxReconnectAttempts: 0 });
  const callerIdentity = newIdentity();
  const caller: EpCaller = { owner: DEV_OWNER, actor: callerIdentity.id, uid: mintLifecycleUid() };
  callerNc = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, callerIdentity, "agent", { lifecycleUid: caller.uid, endpointCapabilities: [{ endpoint: MANAGER_ENDPOINT, command: "status" }] }), tls: false }), maxReconnectAttempts: 0 });

  manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root });
  const internals = manager as unknown as {
    staticLifecycleEvict?: (principal: string) => Promise<EvictionResult>;
    staticReconcileRetryDelaysMs: readonly number[];
    staticReconcileItems: Map<string, { timer?: ReturnType<typeof setTimeout>; nextRetryAt?: string; attempts: number; disposition: string }>;
    managerStatusData(): ManagerStatus;
    reconcileStaticLifecycles(): Promise<void>;
    retryStaticReconcile(key: string): Promise<void>;
  };
  internals.staticReconcileRetryDelaysMs = [1_000, 80, 80];
  internals.staticLifecycleEvict = async (principal): Promise<EvictionResult> => {
    const alias = [...identities].find(([, row]) => row.principal === principal)?.[0] ?? principal;
    const count = (attempts.get(alias) ?? 0) + 1;
    attempts.set(alias, count);
    if (alias === "orphan-first" && count === 1) {
      firstEvictionEntered = true;
      await firstEvictionRelease;
    }
    const failMiddleOnce = alias === "orphan-middle" && count === 1;
    const failPersistent = alias === "orphan-persistent";
    const verifiedGone = !(failMiddleOnce || failPersistent);
    return { principal, kicked: verifiedGone ? 1 : 0, remaining: verifiedGone ? 0 : 1, scanComplete: true, verifiedGone };
  };

  const starting = manager.start();
  check("startup reconciliation reached the first real terminal", await until(() => firstEvictionEntered, 20_000));
  const servingStatus = await until(async () => ["running", "retrying"].includes((await status(caller))?.staticReconciliation.state ?? ""), 20_000);
  check("the manager endpoint serves while reconciliation is active", servingStatus, await status(caller));
  check("a later planned row is still active while the first terminal is paused", (await slot("orphan-last"))?.phase === "active", await slot("orphan-last"));
  releaseFirst();
  await starting;

  const firstSweepDone = await until(() => logs.some((line) => /! static reconcile completed: 3 attempted, 2 succeeded, 1 failed; failed=orphan-middle:terminalizing:retry-scheduled/.test(line)), 20_000);
  check("the first sweep is non-success and names the failed alias, phase, and disposition", firstSweepDone, logs.filter((line) => line.includes("static reconcile completed")));
  check("the first sweep has no N/N success-shaped progress line", !logs.some((line) => /static reconcile \d+\/\d+/.test(line)), logs.filter((line) => line.includes("static reconcile")));
  check("the later row reconciles despite the middle failure", (await slot("orphan-last"))?.phase === "retired", await slot("orphan-last"));
  check("the failed alias stays durable terminalizing during the retry window", (await slot("orphan-middle"))?.phase === "terminalizing", await slot("orphan-middle"));
  const failedStatus = await status(caller);
  const middleFailure = failedStatus?.staticReconciliation.failures.find((row) => row.alias === "orphan-middle");
  check("served status prints retry-scheduled and the failed alias with a next retry time", failedStatus?.staticReconciliation.state === "retry-wait" && middleFailure?.disposition === "retry-scheduled" && typeof middleFailure.nextRetryAt === "string", failedStatus?.staticReconciliation);

  const blockedSpawn = await manager.startAgent({ name: "orphan-middle", agent: connector.name });
  check("the durable terminalizing row refuses same-alias spawn during the failure window", blockedSpawn.ok === false && /terminalizing/i.test(blockedSpawn.error ?? ""), blockedSpawn);

  const recovered = await until(async () => (await slot("orphan-middle"))?.phase === "retired", 5_000);
  check("the same manager process re-drives the failed alias to retired", recovered && attempts.get("orphan-middle") === 2, { phase: (await slot("orphan-middle"))?.phase, attempts: attempts.get("orphan-middle") });
  const recoveredStatus = await status(caller);
  const recoveredRow = recoveredStatus?.staticReconciliation.failures.find((row) => row.alias === "orphan-middle");
  check("served status prints the recovered disposition until the next sweep", recoveredStatus?.staticReconciliation.state === "recovered" && recoveredRow?.disposition === "recovered", recoveredStatus?.staticReconciliation);

  const old = identities.get("orphan-middle")!;
  const lifecycleCreds = await mintCreds(auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor: old.actor, lifecycleUid: old.uid, alias: "orphan-middle" } });
  const lifecycleNc = await connect({ servers, ...standaloneConnectOpts({ creds: lifecycleCreds, tls: false }), maxReconnectAttempts: 0 });
  const lifecycleKvm = new Kvm(lifecycleNc);
  const oldGate = await gateObserve(staticLifecycleTransport(await lifecycleKvm.open(recordsBucket(space)), await lifecycleKvm.open(epAuthBucket(space))), old.uid);
  await lifecycleNc.drain().catch(() => lifecycleNc.close());
  const expectedOp = createHash("sha256").update(`retire:${old.uid}`).digest("hex").slice(0, 26);
  check("the re-drive reused one deterministic terminal operation", oldGate?.row.state === "retired" && oldGate.row.op?.opId === expectedOp, oldGate?.row);

  const respawn = await manager.startAgent({ name: "orphan-middle", agent: connector.name });
  const respawnUid = respawn.ok ? (respawn.data as { lifecycleUid: string }).lifecycleUid : undefined;
  check("same-alias spawn succeeds only after retirement and mints one successor lifecycle", respawn.ok === true && respawnUid !== old.uid, respawn);
  check("the predecessor lifecycle was not duplicated or replaced during re-drive", attempts.get("orphan-first") === 1 && attempts.get("orphan-middle") === 2 && attempts.get("orphan-last") === 1, Object.fromEntries(attempts));

  // Persistent control. A fresh sweep clears the recovered transition, but keeps a failed coordinate's
  // existing per-process budget. Two extra triggers join its scheduled retry rather than resetting it.
  await writeOrphan("orphan-persistent");
  // The transient acceptance above already used the real timer. Keep this independent bounded and
  // duplicate-trigger control manual so a loaded host cannot fire a compressed timer mid-assertion.
  internals.staticReconcileRetryDelaysMs = [60_000, 60_000, 60_000];
  await internals.reconcileStaticLifecycles();
  const persistentIdentity = identities.get("orphan-persistent")!;
  const persistentKey = JSON.stringify([DEV_OWNER, "orphan-persistent", persistentIdentity.uid]);
  const persistentItem = internals.staticReconcileItems.get(persistentKey)!;
  if (persistentItem.timer) clearTimeout(persistentItem.timer);
  persistentItem.timer = undefined;
  persistentItem.nextRetryAt = undefined;
  await Promise.all([internals.retryStaticReconcile(persistentKey), internals.retryStaticReconcile(persistentKey)]);
  check("two retry triggers join one durable re-read and exact-terminal flight", attempts.get("orphan-persistent") === 2 && persistentItem.attempts === 2, { attempts: attempts.get("orphan-persistent"), item: persistentItem });
  for (let expected = 3; expected <= 4; expected++) {
    if (persistentItem.timer) clearTimeout(persistentItem.timer);
    persistentItem.timer = undefined;
    persistentItem.nextRetryAt = undefined;
    await internals.retryStaticReconcile(persistentKey);
    check(`persistent failure completed bounded attempt ${expected}/4`, attempts.get("orphan-persistent") === expected && persistentItem.attempts === expected, { attempts: attempts.get("orphan-persistent"), item: persistentItem });
  }
  const exhausted = internals.managerStatusData().staticReconciliation.failures.some((row) => row.alias === "orphan-persistent" && row.disposition === "retry-exhausted");
  const exhaustedStatus = internals.managerStatusData().staticReconciliation;
  const exhaustedRow = exhaustedStatus.failures.find((row) => row.alias === "orphan-persistent");
  check("persistent failure is bounded at four attempts despite duplicate retry triggers", exhausted && attempts.get("orphan-persistent") === 4, { attempts: attempts.get("orphan-persistent"), exhaustedStatus });
  check("status prints retry-exhausted with no next retry and the restart disposition", exhaustedStatus.state === "failed" && exhaustedRow?.disposition === "retry-exhausted" && exhaustedRow.nextRetryAt === undefined && /restart this manager for a fresh per-process retry budget/.test(exhaustedRow.remedy ?? ""), exhaustedStatus);
  check("the prior recovered transition clears on the next sweep", !exhaustedStatus.failures.some((row) => row.alias === "orphan-middle"), exhaustedStatus);
  const attemptsAtExhaustion = attempts.get("orphan-persistent");
  await wait(250);
  check("an exhausted item does not busy-loop", attempts.get("orphan-persistent") === attemptsAtExhaustion, Object.fromEntries(attempts));
  await internals.reconcileStaticLifecycles();
  check("a later sweep in the same process does not reset an exhausted retry budget", attempts.get("orphan-persistent") === attemptsAtExhaustion, Object.fromEntries(attempts));
  check("the exhausted durable alias remains terminalizing for a fresh manager process to re-plan", (await slot("orphan-persistent"))?.phase === "terminalizing", await slot("orphan-persistent"));

  await writeOrphan("orphan-foreign", true);
  await internals.reconcileStaticLifecycles();
  const foreignRow = internals.managerStatusData().staticReconciliation.failures.find((row) => row.alias === "orphan-foreign");
  check("a foreign frozen retirement is refused literally and never reaches eviction", foreignRow?.disposition === "refused-foreign" && attempts.get("orphan-foreign") === undefined, { foreignRow, attempts: Object.fromEntries(attempts) });

  // Shutdown control. A second logical manager can coexist in this space, which isolates its owned
  // rows from the main redrive scenario above. Gate its first exact terminal, request stop, then
  // release it. stop() must drain that accepted terminal, the serial sweep must not start the later
  // row after the shutdown fence, and start() must not publish a service after stop has returned.
  const shutdownRoot = join(root, "shutdown-manager");
  const shutdownInstanceId = mintLifecycleUid();
  mkdirSync(join(shutdownRoot, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(shutdownRoot), auth);
  saveManagerInstanceIdentity(shutdownRoot, space, { instanceId: shutdownInstanceId, serveIdentity: newIdentity() });
  await writeOrphan("shutdown-first", false, shutdownInstanceId, shutdownRoot);
  await writeOrphan("shutdown-last", false, shutdownInstanceId, shutdownRoot);
  let shutdownFirstEntered = false;
  let releaseShutdownFirst!: () => void;
  const shutdownFirstRelease = new Promise<void>((resolve) => { releaseShutdownFirst = resolve; });
  shutdownManager = new Manager({ space, servers, runtime: "pty", workspaceRoot: shutdownRoot });
  const shutdownInternals = shutdownManager as unknown as {
    staticLifecycleEvict?: (principal: string) => Promise<EvictionResult>;
    serviceServe?: unknown;
    reconcileStaticLifecycles(): Promise<void>;
  };
  shutdownInternals.staticLifecycleEvict = async (principal): Promise<EvictionResult> => {
    const alias = [...identities].find(([, row]) => row.principal === principal)?.[0] ?? principal;
    attempts.set(alias, (attempts.get(alias) ?? 0) + 1);
    if (alias === "shutdown-first") {
      shutdownFirstEntered = true;
      await shutdownFirstRelease;
    }
    return { principal, kicked: 1, remaining: 0, scanComplete: true, verifiedGone: true };
  };
  const shutdownStarting = shutdownManager.start();
  check("shutdown control reached its first accepted exact terminal", await until(() => shutdownFirstEntered, 20_000));
  let shutdownSettled = false;
  const shutdownStopping = shutdownManager.stop().then(() => { shutdownSettled = true; });
  await wait(150);
  check("stop waits for an accepted startup reconciliation terminal", shutdownSettled === false);
  releaseShutdownFirst();
  await Promise.allSettled([shutdownStarting, shutdownStopping]);
  check("the shutdown fence prevents the serial sweep from starting a later terminal", attempts.get("shutdown-first") === 1 && attempts.get("shutdown-last") === undefined, Object.fromEntries(attempts));
  check("startup cannot publish the manager service after stop completes", shutdownInternals.serviceServe === undefined, { registered: shutdownInternals.serviceServe !== undefined });
  await shutdownInternals.reconcileStaticLifecycles();
  check("shutdown refuses a new static reconciliation sweep", attempts.get("shutdown-last") === undefined, Object.fromEntries(attempts));
  shutdownManager = undefined;
} finally {
  console.error = realError;
  await shutdownManager?.stop().catch(() => {});
  await manager?.stop().catch(() => {});
  await callerNc?.drain().catch(() => callerNc?.close());
  await observer?.drain().catch(() => observer?.close());
  broker.kill("SIGTERM");
  await awaitExit(broker);
  rmSync(root, { recursive: true, force: true });
  rmSync(brokerStore, { recursive: true, force: true });
}

if (fail) {
  console.log(`MANAGER RECONCILE REDRIVE FAILED (${fail} failures, ${pass} passed)`);
  process.exit(1);
}
console.log(`MANAGER RECONCILE REDRIVE OK (${pass} checks)`);

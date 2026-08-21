/**
 * STARTUP RECONCILE availability smoke (#755) — a real JWT broker, real durable orphan slot
 * rows, and a real Manager process. It proves the manager's typed control service is registered
 * while its static-orphan terminal sweep is still running, rather than holding the instance lease
 * while the whole space has no control plane.
 *
 * The fixture writes several ACTIVE orphan rows before start. The manager therefore cannot finish
 * reconciliation before the first terminal transition lands. We await that first transition, then
 * invoke `status` over the real ep.one rail. A green status reply while later slots remain ACTIVE
 * proves serve-first concurrency. In the old serial start() order, that invocation has no service
 * registration yet, so the assertion fails.
 *
 * The sweep still owns a per-alias gate: a new spawn for an alias whose row is being reconciled is
 * refused until that exact terminal has cleared; it cannot race the terminal and reuse its name.
 *
 * Run: pnpm smoke:manager-reconcile-startup   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth,
  mintCreds,
  newIdentity,
  mintLifecycleUid,
  setupSpaceStreams,
  standaloneConnectOpts,
  DEV_OWNER,
  recordsBucket,
  epAuthBucket,
  epCall,
  registry,
  type Connector,
  type EpCaller,
  type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { activateStaticLifecycle, casStaticSlot, readStaticSlot, staticLifecycleTransport } from "../src/static-lifecycle.js";
import { bootBroker } from "./_boot-broker.js";

const ORPHANS = 8;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => Promise<boolean>, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await wait(25);
  }
  return false;
};

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};

const space = `reconcile-start-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-reconcile-start-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "orphan-0.md"), "---\nname: orphan-0\nrole: worker\n---\nbody\n");
// The connector is deliberately valid. If the alias guard is removed, the request gets past
// admission and must fail for a later lifecycle reason rather than being confused with a missing
// connector refusal.
const reconcileStub: Connector = {
  kind: "connector",
  name: "reconcile-stub",
  requires: ["node"],
  buildLaunch: (): LaunchSpec => { throw new Error("reconcile-stub: alias guard did not refuse"); },
};
registry.register(reconcileStub);

const callerIdentity = newIdentity();
const caller: EpCaller = { owner: DEV_OWNER, actor: callerIdentity.id, uid: mintLifecycleUid() };
let manager: Manager | undefined;
let callerNc: Awaited<ReturnType<typeof connect>> | undefined;
let observerNc: Awaited<ReturnType<typeof connect>> | undefined;

/** An ACTIVE durable static row with no manager-owned process: the exact orphan shape after a crash. */
async function writeOrphan(alias: string): Promise<void> {
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", {
    lifecycleExecutor: { owner: DEV_OWNER, actor: identity.id, lifecycleUid, alias },
  });
  const nc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const transport = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    await activateStaticLifecycle(transport, { owner: DEV_OWNER, alias, actor: identity.id, lifecycleUid, managerInstance: "repro-755" });
    const current = await readStaticSlot(transport, DEV_OWNER, alias);
    if (!current) throw new Error(`missing just-created slot ${alias}`);
    await casStaticSlot(transport, { ...current.row, phase: "active" }, current.revision);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

async function phase(alias: string): Promise<string | undefined> {
  const records = await new Kvm(observerNc!).open(recordsBucket(space));
  return (await readStaticSlot(staticLifecycleTransport(records, records), DEV_OWNER, alias))?.row.phase;
}

try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  for (let n = 0; n < ORPHANS; n++) await writeOrphan(`orphan-${n}`);

  observerNc = await connect({
    servers: broker.servers,
    ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }),
    maxReconnectAttempts: 0,
  });
  callerNc = await connect({
    servers: broker.servers,
    ...standaloneConnectOpts({
      creds: await mintCreds(auth, callerIdentity, "agent", {
        lifecycleUid: caller.uid,
        endpointCapabilities: [
          { endpoint: MANAGER_ENDPOINT, command: "status" },
          { endpoint: MANAGER_ENDPOINT, command: "spawn" },
        ],
      }),
      tls: false,
    }),
    maxReconnectAttempts: 0,
  });

  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  const starting = manager.start();

  const firstTerminalStarted = await until(async () => (await phase("orphan-0")) !== "active", 20_000);
  check("a real orphan terminal began (the fixture reached startup reconciliation)", firstTerminalStarted, { phase: await phase("orphan-0") });

  // Registration itself has several broker round trips. Wait until the real ep rail answers, but
  // require that a later planned orphan is still active at that moment: a serial startup cannot
  // satisfy both conditions.
  let status: Awaited<ReturnType<typeof epCall>> | undefined;
  let statusError: string | undefined;
  const statusWhileReconciling = await until(async () => {
    try {
      status = await epCall(
        callerNc!,
        space,
        { mode: "one" },
        { endpoint: MANAGER_ENDPOINT, command: "status", contract: MANAGER_CONTRACTS.status, caller },
        { deadlineMs: 1_000, currentEpoch: async () => 0 },
      );
      return status.reply.ok === true && (await phase(`orphan-${ORPHANS - 1}`)) === "active";
    } catch (error) {
      statusError = (error as Error).message;
      return false;
    }
  }, 20_000);
  check(
    "status serves while later orphan rows remain ACTIVE (manager is not globally unavailable during reconcile)",
    statusWhileReconciling,
    { reply: status?.reply, statusError, lastPhase: await phase(`orphan-${ORPHANS - 1}`) },
  );

  let spawn: Awaited<ReturnType<typeof epCall>> | undefined;
  let spawnError: string | undefined;
  try {
    spawn = await epCall(
      callerNc,
      space,
      { mode: "one" },
      { endpoint: MANAGER_ENDPOINT, command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: `orphan-${ORPHANS - 1}`, agent: "reconcile-stub" } },
      { deadlineMs: 5_000, currentEpoch: async () => 0 },
    );
  } catch (error) {
    spawnError = (error as Error).message;
  }
  check(
    "spawn for an alias still reconciling is refused by its reconcile gate before lifecycle provisioning",
    spawn?.reply.ok === false && /still reconciling/i.test(String(spawn.reply.error?.message ?? "")),
    { reply: spawn?.reply, spawnError },
  );

  await starting;
  const sweepSettled = await until(async () => (await phase(`orphan-${ORPHANS - 1}`)) === "retired", 20_000);
  check("startup sweep completes after the manager has served", sweepSettled, { phase: await phase(`orphan-${ORPHANS - 1}`) });
} finally {
  await callerNc?.drain().catch(() => callerNc?.close());
  await observerNc?.drain().catch(() => observerNc?.close());
  await manager?.stop().catch(() => {});
  await broker.stop().catch(() => {});
}

console.log(`\n${fail === 0 ? "MANAGER RECONCILE STARTUP SMOKE OK ✅" : "MANAGER RECONCILE STARTUP SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

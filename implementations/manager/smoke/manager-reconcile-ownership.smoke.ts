/**
 * RECONCILE-OWNERSHIP smoke (control-surface P2 item 3, slice 3b-2: demote the reconcile sole-authority).
 *
 * The boot sweep (`reconcileStaticLifecycles`) used to assume EVERY durable slot row was THIS manager's to
 * adjudicate — a single-manager assumption. Once the lease is demoted (3b-1) and two managers coexist in one
 * space, that sweep would sweep-terminalize a SIBLING manager's live-agent rows (the historical all-agents-kill
 * hazard, now cross-instance). The 3b-2 demotion: slot rows carry the owning LOGICAL instance id
 * (`ownerInstanceId`, stable across restart), and a manager reconciles ONLY its own rows. A legacy row (pre-3b-2,
 * no owner) predates multi-manager, so it is the single-manager past and any manager reconciles it. An orphaned
 * SIBLING row is reclaimed only by an explicit operator CAS takeover (ruling 1), never auto-adopted here.
 *
 * RED-FIRST: against the sole-authority reconcile, "the sibling's active row survives" FAILS by design (the
 * sweep terminalizes it). GREEN once the ownership filter skips rows this instance does not own.
 *
 * Run: pnpm smoke:manager-reconcile-ownership   (needs nats-server + node on PATH; boots its own broker)
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { Manager } from "../src/manager.js";
import {
  createSpaceAuth,
  mintCreds,
  newIdentity,
  principalKey,
  setupSpaceStreams,
  standaloneConnectOpts,
  DEV_OWNER,
  mintLifecycleUid,
  recordsBucket,
  epAuthBucket,
  type AgentHandle,
  type LaunchSpec,
  type Presence,
  type StaticManagedSlotRow,
} from "@cotal-ai/core";
import { staticLifecycleTransport, readStaticSlot, activateStaticLifecycle, casStaticSlot } from "../src/static-lifecycle.js";
import { bootBroker } from "./_boot-broker.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const until = async (cond: () => Promise<boolean>, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) { if (await cond()) return true; if (Date.now() > deadline) return false; await new Promise((r) => setTimeout(r, 200)); }
};

const SELF = mintLifecycleUid();    // this reconciling manager's logical instance id
const SIBLING = mintLifecycleUid();  // a DIFFERENT live manager instance (its rows are off-limits)

const space = `reconcile-own-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const SERVERS = broker.servers;
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-reconcile-own-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });

// A reconcile-only Manager: mock the runtime + endpoint (reconcile stands up its OWN provisioner
// connection and reads the records KV directly), set auth + the persisted logical instance id.
const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth;
(mgr as unknown as { managerInstanceId: string }).managerInstanceId = SELF;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
(mgr as unknown as { ep: Record<string, unknown> }).ep = { ref: () => ({ id: "smoke-mgr" }), on: () => {}, off: () => {}, waitForPresenceSnapshot: () => Promise.resolve(), getRoster: (): Presence[] => [] };

const M = mgr as unknown as {
  agents: Map<string, unknown>;
  retiredPrincipals: Set<string>;
  reconcileStaticLifecycles: () => Promise<void>;
};

/** Write an ACTIVE slot row owned by `ownerInstanceId` (undefined = a legacy pre-3b-2 row), backed by
 *  NO live managed agent — exactly the shape reconcile would sweep-terminalize if it owned it. */
const writeActiveSlot = async (alias: string, ownerInstanceId: string | undefined): Promise<{ actor: string; uid: string }> => {
  const id = newIdentity();
  const uid = mintLifecycleUid();
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor: id.id, lifecycleUid: uid, alias } });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    await activateStaticLifecycle(t, { owner: DEV_OWNER, alias, actor: id.id, lifecycleUid: uid, managerInstance: "smoke", ownerInstanceId: ownerInstanceId as unknown as string });
    const slot = await readStaticSlot(t, DEV_OWNER, alias);
    await casStaticSlot(t, { ...slot!.row, phase: "active" }, slot!.revision);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
  return { actor: id.id, uid };
};

const readSlotPhase = async (alias: string): Promise<string | undefined> => {
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    return (await readStaticSlot(t, DEV_OWNER, alias))?.row.phase;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
};

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const own = await writeActiveSlot("own-agent", SELF);
  const sibling = await writeActiveSlot("sibling-agent", SIBLING);
  await writeActiveSlot("legacy-agent", undefined);

  check("all three slots are ACTIVE before reconcile",
    (await readSlotPhase("own-agent")) === "active" && (await readSlotPhase("sibling-agent")) === "active" && (await readSlotPhase("legacy-agent")) === "active");

  await M.reconcileStaticLifecycles();

  // THE DEMOTION: a sibling manager's active row is NOT this instance's to adjudicate — it survives.
  check("the SIBLING instance's active row SURVIVES reconcile (not swept-terminalized) — the demotion",
    (await readSlotPhase("sibling-agent")) === "active", { phase: await readSlotPhase("sibling-agent") });
  check("the sibling's principal is NOT added to this manager's retirement/refusal index",
    !M.retiredPrincipals.has(principalKey(DEV_OWNER, sibling.actor).key));

  // OWN + LEGACY rows (no live agent backing them) ARE this instance's to reconcile → terminalized.
  check("this instance's OWN dead-but-active row is reconciled (terminalized)",
    await until(async () => (await readSlotPhase("own-agent")) === "retired", 30_000), { phase: await readSlotPhase("own-agent") });
  check("a LEGACY row (pre-3b-2, no owner) is reconciled as the single-manager past",
    await until(async () => (await readSlotPhase("legacy-agent")) === "retired", 30_000), { phase: await readSlotPhase("legacy-agent") });
  check("the OWN row's principal IS in the refusal index after its terminal",
    M.retiredPrincipals.has(principalKey(DEV_OWNER, own.actor).key));
} finally {
  await mgr.stop().catch(() => {});
  await broker.stop().catch(() => {});
}

console.log(`\n${fail === 0 ? "RECONCILE-OWNERSHIP SMOKE OK ✅" : "RECONCILE-OWNERSHIP SMOKE FAILED (RED-FIRST until reconcile filters to own rows)"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

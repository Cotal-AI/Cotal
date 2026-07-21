/**
 * STATIC §13.1 LIFECYCLE smoke (control-surface P2 slice 1, Unit B) — proves BY EXECUTION, over a
 * real JWT broker with real provisioning and real key-pinned `lifecycle-executor` credentials
 * (fake runtime: nothing launches), the static executor's durable behavior:
 *
 *  1. ACTIVATION (F3/F4): a static spawn persists the durable outer intent (slot row, phase
 *     `provisioning`) and drives the SHARED activation saga — after spawn the slot is `active`
 *     at the incarnation's uid, the head `lifecycle.local.<nkey>` is active (PRINCIPAL-keyed:
 *     the wire authority coordinate is the nkey, never the alias — F5-bind), the uid is
 *     reserved, the gate is open @gen1, and the credential is LEDGERED (`cred.<uid>.<credId>`,
 *     state active) with a BOUNDED exp (F5(b)) before it was materialized.
 *  2. F5(a) membership gate: a live managed principal passes; a terminalizing, retiring, or
 *     retired incarnation's principal is refused; an unknown principal is not claimed.
 *  3. F5(b) renewal: the manager push-remints the SAME identity with a fresh bounded exp — a
 *     second ledger row appears, the file re-signs for the same nkey — and renewal REFUSES once
 *     the lifecycle is terminalizing.
 *  4. TERMINAL (F1, the (b2) order): despawn drives freeze -> head retiring -> B1 revoke (ALL
 *     ledger rows, incl. renewals) -> cleanup -> gate retired (op-pinned) -> head retired ->
 *     slot retired -> alias free; the retiring hold gates same-name reuse meanwhile.
 *  5. Same-name respawn after the terminal: a FRESH uid, the slot CASed over the retired row,
 *     the predecessor's gate/head stay terminally retired (never reused).
 *  6. F3 rollback: a spawn that throws AFTER activation (buildLaunch) drives the exact-op static
 *     terminal — no active orphan survives.
 *  7. RECONCILE (boot sweep): an active slot with no live process is terminalized by
 *     reconcileStaticLifecycles (no active orphan across manager restarts).
 *  8. F2: a static spawn carrying endpointCapabilities is REFUSED at spawn-accept.
 *
 * Run: pnpm smoke:static-lifecycle   (needs nats-server + node on PATH; boots its own broker)
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { Manager } from "../src/manager.js";
import {
  createSpaceAuth,
  registry,
  mintCreds,
  newIdentity,
  principalKey,
  setupSpaceStreams,
  standaloneConnectOpts,
  DEV_OWNER,
  mintLifecycleUid,
  recordsBucket,
  epAuthBucket,
  credRowKey,
  parseLedgerRow,
  headCandidate,
  gateObserve,
  inspectCredHealth,
  idFromCreds,
  STANDING_RENEWABLE_TTL_SEC,
  type Connector,
  type LaunchSpec,
  type AgentHandle,
  type Presence,
  type CredentialLedgerRow,
  type LifecycleMapping,
  type EpGateRow,
  type StaticManagedSlotRow,
} from "@cotal-ai/core";
import { workspaceSecretStore } from "@cotal-ai/workspace";
import {
  staticLifecycleTransport,
  readStaticSlot,
  activateStaticLifecycle,
  casStaticSlot,
} from "../src/static-lifecycle.js";
import { bootBroker } from "./_boot-broker.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra) ?? ""}`}`);
  if (!cond) failures++;
}
const enc = new TextEncoder();
const retireOpId = (uid: string): string => createHash("sha256").update(`retire:${uid}`).digest("hex").slice(0, 26);
async function until(cond: () => Promise<boolean> | boolean, ms: number, what: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) {
      console.log(`… timed out waiting for ${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const space = `static-lifecycle-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-static-lifecycle-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
for (const alias of ["worker", "crashy", "epcap"])
  writeFileSync(
    join(workspaceRoot, ".cotal", "agents", `${alias}.md`),
    `---\nname: ${alias}\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`,
  );

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: () => Promise.resolve(),
  getRoster: (): Presence[] =>
    [...(mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map(
      (a): Presence => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name, role: "worker", kind: "agent", description: "", tags: [] }, status: "idle", lifecycleUid: a.lifecycleUid, ts: 0 }),
    ),
};

let crashLaunch = false;
const con: Connector = {
  kind: "connector",
  name: "smoke-sl",
  requires: ["node"],
  buildLaunch: () => {
    if (crashLaunch) throw new Error("smoke: injected buildLaunch crash");
    return { command: "true", args: [], env: {} };
  },
};
registry.register(con);

const M = mgr as unknown as {
  agents: Map<string, { id: string; name: string; lifecycleUid: string; terminalizing?: boolean; secretPaths?: { creds?: string }; seed?: string }>;
  retiring: Map<string, { lifecycleUid: string }>;
  retiredPrincipals: Set<string>;
  freeSlot: (a: unknown, floor: boolean) => void;
  deprovision: (a: { id: string; name: string; lifecycleUid: string; secretPaths?: { creds?: string } }) => Promise<void>;
  lifecycleMembershipRefusal: (caller: string) => string | undefined;
  renewManagedStaticCred: (a: unknown) => Promise<void>;
  reconcileStaticLifecycles: () => Promise<void>;
};

/** Durable-state reader: slot rows ride a provisioner cred (keyed direct-get on `mgrslot.>`);
 *  head/gate/cred rows ride a per-lifecycle `lifecycle-executor` cred (the same key-pinned
 *  profile the manager uses — the reads themselves prove the pin covers the executor's needs). */
async function readState(alias: string, actor: string, uid: string): Promise<{
  slot?: StaticManagedSlotRow;
  head?: LifecycleMapping;
  gate?: EpGateRow;
  credRows: CredentialLedgerRow[];
}> {
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", {
    lifecycleExecutor: { owner: DEV_OWNER, actor, lifecycleUid: uid, alias },
  });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    const slot = await readStaticSlot(t, DEV_OWNER, alias);
    const head = await headCandidate(t, DEV_OWNER, actor);
    const gate = await gateObserve(t, uid);
    const credRows: CredentialLedgerRow[] = [];
    for (const id of slot?.row.credentialIds ?? []) {
      const e = await t.getAuth(credRowKey(uid, id));
      if (e !== undefined) credRows.push(parseLedgerRow(e.value, credRowKey(uid, id)));
    }
    return { slot: slot?.row, head: head?.mapping, gate: gate?.row, credRows };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

async function readSlotOnly(alias: string): Promise<StaticManagedSlotRow | undefined> {
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(recordsBucket(space)));
    return (await readStaticSlot(t, DEV_OWNER, alias))?.row;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ── 1. Activation: durable identity + bounded ledgered credential ─────────
  const spawnA = await mgr.startAgent({ name: "worker", agent: "smoke-sl" });
  check("spawn A succeeds", spawnA.ok === true, spawnA);
  const uidA = spawnA.ok ? (spawnA.data as { lifecycleUid: string }).lifecycleUid : "";
  const managedA = M.agents.get("worker")!;
  const idA = managedA.id;
  const principalA = principalKey(DEV_OWNER, idA).key;
  const s1 = await readState("worker", idA, uidA);
  check("slot is ACTIVE at A's uid with the nkey as actor (F4: authority = incarnation, alias = routing)", s1.slot?.phase === "active" && s1.slot?.lifecycleUid === uidA && s1.slot?.actor === idA && s1.slot?.alias === "worker", s1.slot);
  check("head lifecycle.local.<nkey> is ACTIVE at A's uid, epoch 1 (principal-keyed head)", s1.head?.state === "active" && s1.head?.lifecycleUid === uidA && s1.head?.processEpoch === 1, s1.head);
  check("issuance gate is OPEN @gen1 (activation reopened LAST)", s1.gate?.state === "open" && s1.gate?.generation === 1, s1.gate);
  check("ONE ledger row, ACTIVE, holder = A's wire principal (ledgered before materialization)", s1.credRows.length === 1 && s1.credRows[0].state === "active" && s1.credRows[0].holderPrincipal === principalA, s1.credRows);
  const credsPathA = managedA.secretPaths?.creds;
  const storedA = credsPathA ? await workspaceSecretStore(workspaceRoot).get(`auth/creds/${credsPathA.split("/").slice(-1)[0]}`) : undefined;
  const fileHealth = credsPathA && existsSync(credsPathA) ? inspectCredHealth((await import("node:fs")).readFileSync(credsPathA, "utf8")) : { state: "unreadable" as const };
  void storedA;
  check("A's credential is BOUNDED (exp set, within the managed TTL) — F5(b)", fileHealth.state === "healthy" && (fileHealth.exp ?? 0) <= Math.floor(Date.now() / 1000) + STANDING_RENEWABLE_TTL_SEC + 60, fileHealth);
  check("ledger row exp equals the JWT exp", s1.credRows[0]?.exp === fileHealth.exp, { row: s1.credRows[0]?.exp, jwt: fileHealth.exp });

  // ── 2. F5(a) membership gate ───────────────────────────────────────────────
  check("live managed principal PASSES the membership gate", M.lifecycleMembershipRefusal(principalA) === undefined);
  check("an unknown principal is NOT claimed by the gate (operator instruments keep tier authority)", M.lifecycleMembershipRefusal(principalKey(DEV_OWNER, "UNKNOWNNKEY").key) === undefined);
  managedA.terminalizing = true;
  check("a TERMINALIZING principal is refused (the latch)", typeof M.lifecycleMembershipRefusal(principalA) === "string");
  managedA.terminalizing = false;

  // ── 3. F5(b) renewal ───────────────────────────────────────────────────────
  const beforeRenew = credsPathA ? (await import("node:fs")).readFileSync(credsPathA, "utf8") : "";
  // JWT iat/exp are second-granular: a renewal in the SAME second as the mint is byte-identical
  // (same jti) and idempotently no-ops. Step past the second boundary so the renewal is real.
  await new Promise((r) => setTimeout(r, 1100));
  await M.renewManagedStaticCred(managedA);
  const s3 = await readState("worker", idA, uidA);
  check("renewal appended a SECOND active ledger row (same uid family)", s3.credRows.length === 2 && s3.credRows.every((r) => r.state === "active"), s3.credRows.map((r) => r.state));
  const afterRenew = credsPathA ? (await import("node:fs")).readFileSync(credsPathA, "utf8") : "";
  check("renewal re-signed the file for the SAME nkey identity", afterRenew !== beforeRenew && idFromCreds(afterRenew) === idA, { same: afterRenew === beforeRenew });
  managedA.terminalizing = true;
  let renewRefused = false;
  try {
    await M.renewManagedStaticCred(managedA);
  } catch {
    renewRefused = true;
  }
  check("renewal REFUSES once terminalizing (no mint after the terminal begins)", renewRefused);
  managedA.terminalizing = false;

  // ── 4. Terminal (F1) ───────────────────────────────────────────────────────
  M.freeSlot(managedA, false);
  check("the name is HELD pending the static retirement (freeSlot -> retiring hold)", M.retiring.has("worker"));
  await M.deprovision({ id: idA, name: "worker", lifecycleUid: uidA, secretPaths: managedA.secretPaths });
  const settled = await until(async () => !M.retiring.has("worker"), 30_000, "the static terminal to clear the hold");
  check("the terminal completed and FREED the alias (hold cleared)", settled);
  const s4 = await readState("worker", idA, uidA);
  check("gate is terminally RETIRED under the retirement op (op-pinned recovery coordinate)", s4.gate?.state === "retired" && s4.gate?.op?.opId === retireOpId(uidA), s4.gate);
  check("head is RETIRED (terminal tail: gate first, head LAST)", s4.head?.state === "retired" && s4.head?.lifecycleUid === uidA, s4.head);
  check("ALL ledger rows (root + renewal) are REVOKED — B1 covers renewals", s4.credRows.length === 2 && s4.credRows.every((r) => r.state === "revoked"), s4.credRows.map((r) => r.state));
  check("slot is RETIRED", s4.slot?.phase === "retired", s4.slot);
  check("A's creds file is gone (cleanup ran inside the barrier)", credsPathA !== undefined && !existsSync(credsPathA));
  check("the RETIRED principal is now refused at the control surface (F5(a))", typeof M.lifecycleMembershipRefusal(principalA) === "string");

  // ── 5. Same-name respawn over the retired slot ─────────────────────────────
  const spawnB = await mgr.startAgent({ name: "worker", agent: "smoke-sl" });
  check("same-name respawn AFTER the terminal succeeds", spawnB.ok === true, spawnB);
  const uidB = spawnB.ok ? (spawnB.data as { lifecycleUid: string }).lifecycleUid : "";
  const idB = M.agents.get("worker")!.id;
  check("successor holds a FRESH uid + FRESH incarnation principal", uidB !== uidA && idB !== idA, { uidA, uidB });
  const s5 = await readState("worker", idB, uidB);
  check("slot CASed over the retired row: ACTIVE at B's uid/actor", s5.slot?.phase === "active" && s5.slot?.lifecycleUid === uidB && s5.slot?.actor === idB, s5.slot);
  const s5a = await readState("worker", idA, uidA);
  check("predecessor's head/gate stay terminally retired (uid never reused)", s5a.head?.state === "retired" && s5a.gate?.state === "retired");

  // ── 6. F3 rollback: a crash AFTER activation drives the exact-op terminal ──
  crashLaunch = true;
  const spawnC = await mgr.startAgent({ name: "crashy", agent: "smoke-sl" });
  crashLaunch = false;
  check("a spawn that throws at buildLaunch fails WITH the injected crash (not an earlier refusal)", spawnC.ok === false && /injected buildLaunch crash/.test(spawnC.ok ? "" : spawnC.error), spawnC);
  const cSettled = await until(async () => (await readSlotOnly("crashy"))?.phase === "retired", 30_000, "the crashed spawn's rollback terminal");
  check("the crashed spawn's slot reached RETIRED (no active orphan — F3)", cSettled);
  const cSlot = await readSlotOnly("crashy");
  if (cSlot) {
    const sc = await readState("crashy", cSlot.actor, cSlot.lifecycleUid);
    check("the crashed spawn's head is RETIRED and its gate terminally retired", sc.head?.state === "retired" && sc.gate?.state === "retired", { head: sc.head?.state, gate: sc.gate?.state });
  }

  // ── 7. Reconcile: an active slot with no live process terminalizes ─────────
  const orphanId = newIdentity();
  const orphanUid = mintLifecycleUid();
  {
    const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", {
      lifecycleExecutor: { owner: DEV_OWNER, actor: orphanId.id, lifecycleUid: orphanUid, alias: "orphan" },
    });
    const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
      await activateStaticLifecycle(t, { owner: DEV_OWNER, alias: "orphan", actor: orphanId.id, lifecycleUid: orphanUid, managerInstance: "smoke" });
      const slot = await readStaticSlot(t, DEV_OWNER, "orphan");
      await casStaticSlot(t, { ...slot!.row, phase: "active" }, slot!.revision);
    } finally {
      await nc.drain().catch(() => nc.close());
    }
  }
  await M.reconcileStaticLifecycles();
  const oSettled = await until(async () => (await readSlotOnly("orphan"))?.phase === "retired", 30_000, "the orphan's reconcile terminal");
  check("reconcile terminalized the dead-but-active slot (no active orphan across restarts)", oSettled);
  check("the orphan's principal is refused at the control surface after reconcile", typeof M.lifecycleMembershipRefusal(principalKey(DEV_OWNER, orphanId.id).key) === "string");
  check("the LIVE agent (worker B) survived the reconcile untouched", M.agents.get("worker")?.lifecycleUid === uidB && (await readSlotOnly("worker"))?.phase === "active");

  // ── 7b. F3 RESUME-PATH orphan (distsys/security4 CONDITIONAL @ 9e13648) ─────
  // A durable ACTIVE slot NOT backed by a live managed agent, present while a resume is pending.
  // The BOOT sweep must DEFER it (it might be adopted); the POST-ADOPTION sweep must terminalize
  // it (it was not) and seed retiredPrincipals so F5(a) refuses its copied JWT.
  const resOrphanId = newIdentity();
  const resOrphanUid = mintLifecycleUid();
  {
    const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", {
      lifecycleExecutor: { owner: DEV_OWNER, actor: resOrphanId.id, lifecycleUid: resOrphanUid, alias: "resorphan" },
    });
    const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
      await activateStaticLifecycle(t, { owner: DEV_OWNER, alias: "resorphan", actor: resOrphanId.id, lifecycleUid: resOrphanUid, managerInstance: "smoke" });
      const slot = await readStaticSlot(t, DEV_OWNER, "resorphan");
      await casStaticSlot(t, { ...slot!.row, phase: "active" }, slot!.revision);
    } finally {
      await nc.drain().catch(() => nc.close());
    }
  }
  (mgr as unknown as { resumeRequired: boolean }).resumeRequired = true;
  await M.reconcileStaticLifecycles(); // BOOT sweep (resume pending): must DEFER the active orphan
  check("BOOT sweep DEFERS a resume-pending active orphan (does not terminalize it)", (await readSlotOnly("resorphan"))?.phase === "active");
  check("a deferred orphan's principal is NOT yet in the refusal index (still awaiting adoption)", M.lifecycleMembershipRefusal(principalKey(DEV_OWNER, resOrphanId.id).key) === undefined);
  await (mgr as unknown as { reconcileStaticLifecycles: (p: boolean) => Promise<void> }).reconcileStaticLifecycles(true); // POST-ADOPTION sweep: not in this.agents -> terminalize
  (mgr as unknown as { resumeRequired: boolean }).resumeRequired = false;
  const rSettled = await until(async () => (await readSlotOnly("resorphan"))?.phase === "retired", 30_000, "the resume-path orphan's post-adoption terminal");
  check("POST-ADOPTION sweep terminalized the unadopted active orphan (F3 resume-path fix)", rSettled);
  check("the resume-path orphan's principal now REFUSES at the control surface (F5(a) closed on resume)", typeof M.lifecycleMembershipRefusal(principalKey(DEV_OWNER, resOrphanId.id).key) === "string");
  check("worker B STILL survived both resume-path sweeps (live membership adopted)", M.agents.get("worker")?.lifecycleUid === uidB && (await readSlotOnly("worker"))?.phase === "active");

  // ── 8. F2: endpointCapabilities refusal ────────────────────────────────────
  const spawnEp = await mgr.startAgent({ name: "epcap", agent: "smoke-sl", ...({ endpointCapabilities: [{ endpoint: "x", verb: "call" }] } as Record<string, unknown>) });
  check("a static spawn carrying endpointCapabilities is REFUSED (F2, fail-closed in code)", spawnEp.ok === false && /endpointCapabilities/.test(spawnEp.ok ? "" : spawnEp.error), spawnEp);
} finally {
  await (mgr as unknown as { stop?: () => Promise<void> }).stop?.().catch(() => {});
  await stopBroker();
}

if (failures > 0) {
  console.log(`STATIC-LIFECYCLE SMOKE FAILED (${failures} failures)`);
  process.exit(1);
}
console.log("STATIC-LIFECYCLE SMOKE OK ✅");

/**
 * delivery timer-writer smoke. The delivery daemon hosts the space's checkpoint TIMER WRITER
 * (SPEC 13.2): the standing pump that turns workflow `.schedule` requests into the authoritative
 * `.armed` broker schedules. Without it no workflow pause on a live mesh ever expires — the mesh
 * suites pump `armCheckpointTimer` by hand, so before this suite nothing proved the PRODUCTION
 * hosting path. This boots a real auth broker, mints a REAL checkpoint through the scoped
 * credentials a live mesh uses (records writes on a goal-writer cred, the `.schedule` publish on
 * an issuance-fenced serve cred), spawns the real daemon (`cotal deliver`) on the delivery cred,
 * and asserts with NO manual pump:
 *
 *   1. the daemon's writer consumes the `.schedule` that was published BEFORE it started
 *      (durability of the request plane) and publishes `.armed` with the writer's own
 *      `Nats-Schedule-Target` = the sibling `.fire` subject;
 *   2. the BROKER then publishes the `.fire` itself at the deadline (`Nats-Scheduler` = the
 *      `.armed` subject) — the end-to-end proof that a pause on this space expires;
 *   3. a poison `.schedule` carrying a client scheduling header is TERMINATED, not redelivered
 *      forever and never armed (the writer's ack/term split, ADR-51);
 *   4. the daemon still shuts down promptly on SIGTERM with the writer running.
 *
 * Run: pnpm smoke:delivery-timer-writer   (needs `nats-server` with message schedules; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  isReachable, createSpaceAuth, mintCreds, mintMembershipObserverCreds, serverConfig, newIdentity,
  setupSpaceStreams, mintLifecycleUid, standaloneConnectOpts, openRecordsBucket, mintCheckpoint, readCheckpointStatus,
  eptSubject, eptStreamName, eptReqStreamName, timerWriterDurable,
  compileContract, contractDigest, registerServiceInstance, authorizeServeGrant,
  type ServiceNameAuthority, type EpIssuanceGate, type EpIssuanceBarrier, type EpGateState,
  type EpServeLedgerRow,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { spaceMaterialDir } from "@cotal-ai/workspace";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const space = `dlv-timerw-${randomUUID().slice(0, 8)}`;
const EP = "manager";
const IID = mintLifecycleUid();
const EPOCH = 1;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// ---- the §13.1 registration + issuance seam the serve cred is minted behind. The broker's job in
// this suite is enforcing the minted ROWS; the registry/gate storage is the provisioner's trusted
// seam, modeled in memory exactly as the core serve-auth suite does (endpoint-serve-auth.smoke.ts).
const contract = compileContract({ root: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false } });
const D = contract.closureDigest;
const DOC = {
  urn: "ai.cotal.manager", revision: 1, attributes: [], events: [],
  commands: [{ name: "status", class: "ephemeral", targeted: false, capability: "manager.call", inputDigest: D, outputDigest: D }],
};
const DOC_ROOT = contractDigest(DOC);
const DC = contractDigest({ v: 1, root: DOC_ROOT, members: [] });
const artifacts = new Map<string, unknown>([[DC, { v: 1, root: DOC_ROOT, members: [] }], [DOC_ROOT, DOC]]);
const readClusterArtifact = (d: string) => artifacts.get(d);

function memKv(): KV {
  const store = new Map<string, { value: Uint8Array; revision: number; operation: "PUT" }>();
  let seq = 0;
  return {
    get: async (k: string) => store.get(k),
    put: async (k: string, v: Uint8Array, o?: { previousSeq?: number }) => {
      if (o?.previousSeq === 0 && store.has(k)) throw new Error(`wrong last sequence: ${k} exists`);
      store.set(k, { value: v, revision: ++seq, operation: "PUT" });
      return seq;
    },
    update: async (k: string, v: Uint8Array, expected: number) => {
      if (store.get(k)?.revision !== expected) throw new Error("wrong last sequence");
      store.set(k, { value: v, revision: ++seq, operation: "PUT" });
      return seq;
    },
  } as unknown as KV;
}

/** A faithful in-memory §13.1 gate: revision-pinned CAS for the mint's commit and the barrier's
 *  freeze/reopen, create-only ledger stage. Same model as the core serve-auth suite, trimmed. */
function makeGate(init: { generation: number; processEpoch: number; registrationRevision: number }) {
  const gate = {
    space, endpoint: EP, lifecycleUid: IID, principal: "u_op.mgr",
    state: "open" as "open" | "frozen" | "retired",
    generation: init.generation, processEpoch: init.processEpoch,
    registrationRevision: init.registrationRevision, nameAuthorityRevision: 0, revision: 1,
  };
  const rows = new Map<string, EpServeLedgerRow>();
  const observe = (): EpGateState | null => ({ ...gate });
  const revoke = (row: EpServeLedgerRow) => { const e = rows.get(row.credentialId); if (e) e.state = "revoked"; };
  const seam: EpIssuanceGate = {
    observe,
    stage: (row) => {
      const existing = rows.get(row.credentialId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(row)) throw new Error(`ledger row conflict: ${row.credentialId}`);
        return;
      }
      rows.set(row.credentialId, { ...row });
    },
    commit: (expectedRevision) => {
      if (gate.state !== "open" || gate.revision !== expectedRevision) return false;
      gate.revision++;
      return true;
    },
    revoke,
  };
  const barrier: EpIssuanceBarrier = {
    observe,
    freeze: (expectedRevision) => {
      if (gate.state !== "open" || gate.revision !== expectedRevision) return null;
      gate.state = "frozen"; gate.revision++;
      return gate.revision;
    },
    enumerate: () => [...rows.values()],
    revoke,
    evict: () => true,
    reopen: (token, succ) => {
      if (gate.state !== "frozen" || gate.revision !== token) return false;
      gate.state = "open";
      gate.generation = succ.generation;
      gate.processEpoch = succ.processEpoch;
      gate.registrationRevision = succ.registrationRevision;
      gate.nameAuthorityRevision = succ.nameAuthorityRevision;
      gate.revision++;
      return true;
    },
  };
  return { seam, barrier };
}

let daemon: ReturnType<typeof spawn> | undefined;
let daemonExited = false;
let daemonOut = "";
const conns: NatsConnection[] = [];
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ---- mint the two client creds a live mesh splits the checkpoint mint across ----
  const authority: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_op", revision: 0 }) };
  const regKv = memKv();
  const regGate = makeGate({ generation: 0, processEpoch: EPOCH, registrationRevision: 0 });
  const reg = await registerServiceInstance(regKv, {
    space, spec: { endpoint: EP, owner: "u_op", clusterDigests: [DC], protocol: { v: 1 } },
    instanceId: IID, registrant: { owner: "u_op" }, authority, barrier: regGate.barrier, readClusterArtifact,
  });
  const serveGrant = await authorizeServeGrant(regKv, {
    space, endpoint: EP, instanceId: IID, epoch: EPOCH,
    holder: { owner: "u_op" }, authority, readProcessEpoch: () => EPOCH, readClusterArtifact,
  });
  const mintGate = makeGate({ generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision });
  const serveCreds = await mintCreds(auth, newIdentity(), "endpoint-serve", {
    principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: mintGate.seam,
  });
  const gwCreds = await mintCreds(auth, newIdentity(), "goal-writer", { goalWriter: { endpoint: EP } });
  const credsPath = join(dir, "delivery.creds");
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });

  // ---- mint a REAL checkpoint with a live deadline, split across the two scoped connections:
  // records writes on the goal-writer, the `.schedule` publish on the serve cred — BEFORE the
  // daemon exists, so the arm below also proves the request plane is durable.
  const gwNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: gwCreds, tls: false }), maxReconnectAttempts: 0 });
  const serveNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: serveCreds, tls: false }), maxReconnectAttempts: 0 });
  conns.push(gwNc, serveNc);
  const kv = await openRecordsBucket(gwNc, space);
  const TOKEN = "cp_timerw_live_1";
  const holder = { id: "u_op.mgr", lifecycleUid: mintLifecycleUid() };
  const mintedAt = Date.now();
  const deadline = mintedAt + 20_000;
  await mintCheckpoint(kv, jetstream(serveNc), space, {
    ref: { endpoint: EP, token: TOKEN }, instanceId: IID, epoch: EPOCH, holder, deadline, now: mintedAt,
  });
  const st = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN });
  check("a real checkpoint is minted waiting at generation 1 through the scoped creds", st?.value.state === "waiting" && st.value.deadlineGeneration === 1);

  // The `.schedule` request is durably parked on EPT_REQ with NOTHING serving it yet.
  const obsNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }), maxReconnectAttempts: 0 });
  conns.push(obsNc);
  const jsm = await jetstreamManager(obsNc);
  check("the .schedule request is parked durably on EPT_REQ before any daemon exists",
    (await jsm.streams.info(eptReqStreamName(space))).state.messages === 1);

  // ---- spawn the REAL daemon on the delivery cred; no manual pump anywhere in this suite ----
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  // Isolate the child's operator surfaces (the component-health pattern): scratch
  // XDG_CONFIG_HOME/COTAL_HOME keep it off the operator's real seed store and mesh registry, and a
  // scratch workspace root WITH a `.cotal` pins findCotalRoot's cwd walk — without it the walk
  // climbs out of the repo and adopts a developer's live workspace, and the daemon's tenancy guard
  // then (correctly) refuses the foreign account.
  env.XDG_CONFIG_HOME = join(dir, "xdg");
  env.COTAL_HOME = join(dir, "cotal-home");
  // This harness runs the daemon DIRECTLY (not via `up`, which sets this for the daemon it
  // launches): its first-real-command seed would run seven npm installs against the scratch store
  // and, on a cold npm cache, exhaust the arm poll below before the writer is even up. The daemon
  // needs no connectors, so opt out the way `up` does.
  env.COTAL_SKIP_CONNECTOR_SEED = "1";
  const wsRoot = join(dir, "ws");
  mkdirSync(join(wsRoot, ".cotal"), { recursive: true });
  // The daemon's startup admission requires the $SYS observer cred in the workspace's own space
  // material dir (`cotal up` provisions it on a live mesh) — mint it the way `up` does.
  mkdirSync(spaceMaterialDir(wsRoot, space), { recursive: true });
  writeFileSync(join(spaceMaterialDir(wsRoot, space), "membership-observer.creds"), await mintMembershipObserverCreds(auth, newIdentity()), { mode: 0o600 });
  daemon = spawn(join(repoRoot, "node_modules", ".bin", "tsx"), [join(repoRoot, "bin", "cotal.ts"), "deliver", "--space", space, "--server", SERVERS, "--creds", credsPath], {
    cwd: wsRoot, stdio: ["ignore", "pipe", "pipe"], env,
  });
  daemon.stdout!.on("data", (d: Buffer) => { daemonOut += d.toString(); });
  daemon.stderr!.on("data", (d: Buffer) => { daemonOut += d.toString(); });
  daemon.on("exit", () => { daemonExited = true; });

  // 1. The daemon's writer arms the parked request: `.armed` lands on EPT, published by the
  //    writer with the schedule target derived from the request subject.
  const armedSubject = eptSubject(space, EP, IID, EPOCH, TOKEN, "armed");
  const fireSubject = eptSubject(space, EP, IID, EPOCH, TOKEN, "fire");
  let armed: Awaited<ReturnType<typeof jsm.streams.getMessage>> | null = null;
  for (let i = 0; i < 120 && armed === null; i++) {
    await wait(500);
    armed = await jsm.streams.getMessage(eptStreamName(space), { last_by_subj: armedSubject }).catch(() => null);
  }
  check("the daemon's timer writer armed the parked .schedule (no manual pump ran)", armed !== null);
  check("the .armed carries the writer's Nats-Schedule-Target = the sibling .fire subject",
    armed?.header?.get("Nats-Schedule-Target") === fireSubject, armed?.header?.get("Nats-Schedule-Target"));
  check("the daemon logged the writer up", daemonOut.includes("timer writer up"));

  // 2. The BROKER publishes the `.fire` itself at the deadline — the pause on this space expires.
  let fire: Awaited<ReturnType<typeof jsm.streams.getMessage>> | null = null;
  const fireBudget = deadline - Date.now() + 20_000;
  for (let i = 0; i * 500 < fireBudget && fire === null; i++) {
    await wait(500);
    fire = await jsm.streams.getMessage(eptStreamName(space), { last_by_subj: fireSubject }).catch(() => null);
  }
  check("the broker published the .fire itself at the deadline (end-to-end expiry, no hand pump)", fire !== null);
  check("the .fire carries the broker-authored Nats-Scheduler = the .armed subject",
    fire?.header?.get("Nats-Scheduler") === armedSubject, fire?.header?.get("Nats-Scheduler"));

  // 3a. ADR-51 at the WIRE: the request stream is schedules-disabled, so a `.schedule` smuggling a
  //     client scheduling header is refused by the BROKER itself — it cannot even land.
  {
    const h = headers();
    h.set("Nats-Schedule", "@at 2099-01-01T00:00:00.000Z");
    const refused = await jetstream(serveNc).publish(
      eptSubject(space, EP, IID, EPOCH, "cp_timerw_hdr_1", "schedule"),
      new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp_timerw_hdr_1", generation: 1, deadline: Date.now() + 60_000 })),
      { headers: h },
    ).then(() => undefined, (e: Error) => e.message);
    check("a .schedule carrying a client scheduling header is refused by the broker itself (schedules-disabled request stream)",
      refused !== undefined && /schedules/i.test(refused), refused);
  }

  // 3b. Poison the WRITER: a landed `.schedule` whose body timerId disagrees with its subject is
  //     TERMINATED — processed once (not redelivered forever) and never armed.
  {
    const POISON = "cp_timerw_poison_1";
    await jetstream(serveNc).publish(
      eptSubject(space, EP, IID, EPOCH, POISON, "schedule"),
      new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "someone_else", generation: 1, deadline: Date.now() + 60_000 })),
    );
    let drained = false;
    for (let i = 0; i < 40 && !drained; i++) {
      await wait(500);
      const ci = await jsm.consumers.info(eptReqStreamName(space), timerWriterDurable(space)).catch(() => null);
      drained = ci !== null && ci.num_pending === 0 && ci.num_ack_pending === 0;
    }
    check("the poison request is terminated: the writer's durable drains it and holds nothing pending", drained);
    const poisonArmed = await jsm.streams.getMessage(eptStreamName(space), { last_by_subj: eptSubject(space, EP, IID, EPOCH, POISON, "armed") }).catch(() => null);
    check("the poison request armed NOTHING", poisonArmed === null);
    check("the writer logged the permanent refusal", daemonOut.includes("refused a .schedule request permanently"));
  }

  // 4. The daemon still exits promptly on SIGTERM with the writer running (shutdown wiring).
  daemon.kill("SIGTERM");
  let exited = false;
  for (let i = 0; i < 32; i++) { if (daemonExited) { exited = true; break; } await wait(250); }
  check("the daemon exits promptly on SIGTERM with the timer writer up", exited);

  console.log(`\nDELIVERY-TIMER-WRITER SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) {
    console.error("---- daemon output ----\n" + daemonOut);
    process.exitCode = 1;
  }
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  console.error("---- daemon output ----\n" + daemonOut);
  process.exitCode = 1;
} finally {
  for (const nc of conns) { try { await nc.close(); } catch { /* gone */ } }
  try { if (daemon && !daemonExited) daemon.kill("SIGKILL"); } catch { /* gone */ }
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

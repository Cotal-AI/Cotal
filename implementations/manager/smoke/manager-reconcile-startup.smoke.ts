/**
 * STARTUP RECONCILE availability smoke (#755) — a real JWT broker, real durable orphan slot
 * rows, and a real Manager process. It proves the manager's typed control service is registered
 * while its static-orphan terminal sweep is still running, rather than holding the instance lease
 * while the whole space has no control plane.
 *
 * The fixture writes several ACTIVE orphan rows before start. The manager therefore cannot finish
 * reconciliation before the first terminal transition lands. We await that first transition, then
 * invoke `status` over the real ep.one rail. A green status reply while later slots remain ACTIVE
 * proves overlap and availability before sweep completion. In the old serial start() order, that
 * invocation has no service registration yet, so the assertion fails.
 *
 * The sweep still owns a per-alias gate: a new spawn for an alias whose row is being reconciled is
 * refused until that exact terminal attempt returns; it cannot race the terminal and reuse its name.
 *
 * Run: pnpm smoke:manager-reconcile-startup   (needs nats-server + node on PATH)
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstream } from "@nats-io/jetstream";
import {
  createSpaceAuth,
  CotalEndpoint,
  CONTROL_DELIVERY_ADMIN,
  evictDeniedPrincipalWithCreds,
  mintConnectionEvictorCreds,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  mintCheckpoint,
  mintLifecycleUid,
  setupSpaceStreams,
  standaloneConnectOpts,
  DEV_OWNER,
  recordsBucket,
  actionContext,
  bindGoal,
  createGoal,
  recordGoalIndex,
  type GoalRef,
  epAuthBucket,
  epCall,
  registry,
  type Connector,
  type ControlReply,
  type EpCaller,
  type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveManagerInstanceIdentity, saveSpaceAuth } from "@cotal-ai/workspace";
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
const managerInstanceId = mintLifecycleUid();
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
const managerServeIdentity = newIdentity();
saveManagerInstanceIdentity(workspaceRoot, space, { instanceId: managerInstanceId, serveIdentity: managerServeIdentity });
for (let n = 0; n < ORPHANS; n++)
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `orphan-${n}.md`), `---\nname: orphan-${n}\nrole: worker\n---\nbody\n`);
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
let delivery: CotalEndpoint | undefined;

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
    await activateStaticLifecycle(transport, { owner: DEV_OWNER, alias, actor: identity.id, lifecycleUid, managerInstance: managerInstanceId, ownerInstanceId: managerInstanceId });
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
  const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
  const deliveryIdentity = newIdentity();
  delivery = new CotalEndpoint({
    space,
    servers: broker.servers,
    creds: await mintCreds(auth, deliveryIdentity, "delivery"),
    card: { id: deliveryIdentity.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
  });
  delivery.on("error", () => {});
  await delivery.start();
  delivery.serveControl(CONTROL_DELIVERY_ADMIN, async (req): Promise<ControlReply> => {
    if (req.op !== "evictPrincipal") return { ok: false, error: `unsupported delivery-admin op "${req.op}"` };
    const principal = String((req.args as { principal?: unknown })?.principal ?? "");
    return {
      ok: true,
      data: await evictDeniedPrincipalWithCreds({
        servers: broker.servers,
        observerCreds,
        evictorCreds,
        accountId: auth.account.pub,
        principal,
      }),
    };
  }, { boundReply: true });
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

  // Drive the *same* entry point as the served spawn handler, but await its inner lifecycle path:
  // `spawn` is an ACTION and returns its acceptance before that path finishes, so a wire reply alone
  // cannot distinguish an alias gate from a later failure. The real service/control proof is above;
  // this waits for the actual alias admission verdict and proves the no-race guard it relies on.
  const directSpawn = await manager.startAgent({ name: `orphan-${ORPHANS - 1}`, agent: "reconcile-stub" });
  check(
    "spawn for an alias still reconciling is refused by its reconcile gate before lifecycle provisioning",
    directSpawn.ok === false && /still reconciling/i.test(directSpawn.error ?? ""),
    directSpawn,
  );

  // THE SEAT'S TURN RELAY HAS THE SAME BOOT WINDOW, and its empty answer is worse than a refusal:
  // a seat reads `{turns: []}` as "you hold nothing" and a `not-found` yield as "drop it", while it
  // reads a refusal as "keep what you hold". Between registration and `reconcileGoalIndex` the
  // pending-turn index holds nothing a predecessor accepted, so both doors have to refuse.
  {
    const booting = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
    const doors = booting as unknown as {
      turnPendingFor: (c: { owner: string; actor: string; uid: string }) => unknown;
      serveTurnYield: (c: { owner: string; actor: string; uid: string }, raw: Record<string, unknown>) => Promise<{ goalId: string; state: string }>;
    };
    const seat = { owner: "local", actor: "seat", uid: "u1" };
    const pull = ((): { code?: string; message?: string } | "served" => {
      try { doors.turnPendingFor(seat); return "served"; } catch (e) { return e as { code?: string; message?: string }; }
    })();
    check("a seat pulling turns before the goal index is rebuilt is REFUSED, never told it holds none",
      pull !== "served" && (pull as { code?: string }).code === "unavailable"
        && /still reconciling/i.test((pull as { message?: string }).message ?? ""), pull);
    const yielded = await doors.serveTurnYield(seat, { goalId: "g", status: "done" })
      .then(() => "served" as const, (e: unknown) => e as { code?: string; message?: string });
    check("and a yield in the same window is refused rather than answered not-found",
      yielded !== "served" && (yielded as { code?: string }).code === "unavailable"
        && /still reconciling/i.test((yielded as { message?: string }).message ?? ""), yielded);

    // ONCE THE INDEX IS REBUILT, an ELAPSED turn is still not servable. Only the oldest unsettled
    // turn per seat is handed over, so an expired one at the head dammed every later turn for that
    // seat: its own run has already thrown from its pause and its hold is expirable, so the seat
    // would be sent work whose yield is refused, and the live turn behind it would never surface.
    const seeded = booting as unknown as {
      goalReconcileDone: boolean;
      pendingTurns: Map<string, Record<string, unknown>>;
    };
    seeded.goalReconcileDone = true;
    const turnRow = (goalId: string, acceptedAt: number, deadlineAt: number) => ({
      ref: { endpoint: "m", caller: { owner: seat.owner, actor: seat.actor, uid: seat.uid }, goalId },
      goalId, seat: { name: "s", ...seat }, payload: goalId, acceptedAt, deadlineAt,
      holdToken: goalId.padEnd(20, "0"), holdEpoch: 0,
    });
    const t0 = Date.now();
    seeded.pendingTurns.set("stale", turnRow("stale", t0 - 60_000, t0 - 1_000));
    seeded.pendingTurns.set("live", turnRow("live", t0 - 30_000, t0 + 60_000));
    const served = doors.turnPendingFor(seat) as { turns: { goalId: string }[] };
    check("an ELAPSED turn is not served and does not dam the seat's queue: the live one behind it surfaces",
      served.turns.length === 1 && served.turns[0]?.goalId === "live", served);

    // A YIELD WHOSE REPLY WAS LOST. The commit deletes the pending turn, so the retry found
    // nothing and heard `not-found` — which a seat reads as "drop it", reporting failure for work
    // the run already has. The answer the first reply carried is served again instead.
    const retryDoors = seeded as unknown as {
      goalWriter?: unknown;
      turnAcceptances: Map<string, { acceptance: Record<string, unknown>; settled?: { state: string; at: number } }>;
      sweepTurnDeadlines: () => Promise<void>;
    };
    retryDoors.goalWriter = { ctx: {} };
    seeded.pendingTurns.delete("stale");
    seeded.pendingTurns.delete("live");
    retryDoors.turnAcceptances.set("done-already", {
      acceptance: { name: "s", owner: seat.owner, actor: seat.actor, uid: seat.uid, goalId: "done-already", fingerprint: "f", deadlineAt: t0 + 60_000, executor: { lifecycleUid: "x", epoch: 0 } },
      settled: { state: "succeeded", at: Date.now() },
    });
    const retried = await doors.serveTurnYield(seat, { goalId: "done-already", status: "done" })
      .then((r) => r as { goalId: string; state: string }, (e: unknown) => e as { code?: string; message?: string });
    check("a retried yield is served the answer the lost reply carried, never `not-found`",
      (retried as { state?: string }).state === "succeeded", retried);
    const stranger = { owner: "local", actor: "someone-else", uid: "u2" };
    const refusedRetry = await doors.serveTurnYield(stranger, { goalId: "done-already", status: "done" })
      .then(() => "served" as const, (e: unknown) => e as { code?: string });
    check("and only to the addressee it was addressed to",
      refusedRetry !== "served" && (refusedRetry as { code?: string }).code === "permission-denied", refusedRetry);

    // AND THE ANSWER IS NOT KEPT FOREVER. It exists for the window a lost reply is retried in;
    // holding it past that is one entry per turn for the process lifetime, which is what the map
    // used to be. The sweep is what drops it.
    retryDoors.turnAcceptances.set("long-done", {
      acceptance: { name: "s", owner: seat.owner, actor: seat.actor, uid: seat.uid, goalId: "long-done", fingerprint: "f", deadlineAt: t0, executor: { lifecycleUid: "x", epoch: 0 } },
      settled: { state: "succeeded", at: Date.now() - 10 * 60_000 },
    });
    await retryDoors.sweepTurnDeadlines();
    check("the sweep drops a settled answer once its retry window has passed, and keeps a fresh one",
      !retryDoors.turnAcceptances.has("long-done") && retryDoors.turnAcceptances.has("done-already"),
      [...retryDoors.turnAcceptances.keys()]);
    // AND THE SWEEP STOPS ONCE THE LAST ANSWER IS GONE. The settle-time callers of the stop check
    // run when an answer has just been remembered, so they never see the map empty; the prune is
    // the one event after which nothing is owed, and it is the sweep's own to notice.
    const sweepDoors = seeded as unknown as { turnSweepTimer?: unknown; ensureTurnSweep: () => void };
    retryDoors.turnAcceptances.set("done-already", {
      acceptance: retryDoors.turnAcceptances.get("done-already")!.acceptance,
      settled: { state: "succeeded", at: Date.now() - 10 * 60_000 },
    });
    sweepDoors.ensureTurnSweep();
    check("the sweep runs while a settled answer is still within its window", sweepDoors.turnSweepTimer !== undefined);
    await retryDoors.sweepTurnDeadlines();
    check("and stops itself once the prune leaves it nothing to do: no pending turn, no answer to serve",
      sweepDoors.turnSweepTimer === undefined && retryDoors.turnAcceptances.size === 0,
      { timer: sweepDoors.turnSweepTimer !== undefined, answers: retryDoors.turnAcceptances.size });
  }

  await starting;
  const sweepSettled = await until(async () => (await phase(`orphan-${ORPHANS - 1}`)) === "retired", 20_000);
  check("startup sweep completes after the manager has served", sweepSettled, { phase: await phase(`orphan-${ORPHANS - 1}`) });

  // THE BOOT SWEEP ADOPTING A PREDECESSOR'S ACCEPTED TURN. Two things were wrong with it and both
  // are invisible from outside: the agents map is EMPTY during reconcile (seats re-register later,
  // on the resume path), so "not in the map" was read as "dead" and every adopted turn was stamped
  // as addressing a dead seat — its deadline terminal then carried `agentDownAt` and the run raised
  // L4002 where the reference says L4003. And a goal whose spec could not be read had its
  // acceptance time replaced with the BOOT INSTANT, which sorts it behind every turn accepted
  // since: a predecessor's oldest turn served last, by a queue whose whole job is oldest-first.
  {
    const adopting = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
    const doors = adopting as unknown as {
      managerInstanceId: string;
      goalWriter?: unknown;
      pendingTurns: Map<string, { acceptedAt: number; seatDiedAt?: number; seat: { name: string } }>;
      adoptTurnGoal: (e: { ref: GoalRef; iid: string; allocated?: { name: string; actor: string; uid: string }; note?: string }) => Promise<void>;
    };
    // The fixture writes through the LIVE manager's own goal-writer connection: these records are
    // the ones a manager writes, and no other credential in this suite may write them.
    const live = manager as unknown as { goalWriter?: { nc: unknown; ctx: Parameters<typeof bindGoal>[0]; identity: unknown } };
    const gw = live.goalWriter;
    if (gw === undefined) throw new Error("the live manager has no goal-writer connection; the adoption fixture cannot write its goal");
    const actx = gw.ctx;
    doors.goalWriter = gw;
    // An unstarted Manager has no instance id yet (start() mints or restores one). The hold below
    // is minted under an instance id, and the goal-writer cred may schedule only under the LIVE
    // manager's, so the adopting incarnation presents as that instance: the shape a restart has,
    // where the successor reads the predecessor's records under the same persisted id.
    doors.managerInstanceId = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
    // The schedule publish is pinned to the serving instance's EPOCH as well as its id (the
    // goal-writer's egress rows), so the hold is minted under the live manager's serve epoch,
    // exactly what the accept path stamps as `holdEpoch`.
    const serveEpoch = (manager as unknown as { serviceServe?: { grant: { epoch: number } } }).serviceServe?.grant.epoch ?? 0;
    const seatUid = mintLifecycleUid();
    const runner: EpCaller = { owner: "local", actor: "runner", uid: mintLifecycleUid() };
    const goalId = "g".repeat(43);
    const ref: GoalRef = { endpoint: MANAGER_ENDPOINT, caller: runner, goalId };
    const ACCEPTED_AT = Date.now() - 90_000;
    await bindGoal(actx, ref, "fp-adopt");
    await createGoal(actx, ref, {
      fingerprint: "fp-adopt", command: "turn",
      caller: { id: `${runner.owner}.${runner.actor}`, lifecycleUid: runner.uid },
      acceptedEpoch: 0, requestId: goalId, sourceSeq: 0, acceptedAt: ACCEPTED_AT, readinessDeadlineMs: 600_000,
      // The §13.6 target pin the accept path writes: the yield's commit proves the executor's
      // currency against it, and a goal with no pin is refused there as a wiring confusion.
      target: { owner: "local", actor: "seat9", lifecycleUid: seatUid, mappingRevision: 0 },
    });
    const allocated = { name: "adopted-seat", actor: "seat9", uid: seatUid };
    const DEADLINE_AT = Date.now() + 600_000;
    const note = JSON.stringify({ payload: "do the thing", deadlineAt: DEADLINE_AT, holdEpoch: serveEpoch, owner: "local" });
    await recordGoalIndex(actx, ref, doors.managerInstanceId, allocated, note);
    // The turn's HOLD, minted exactly as the accept path mints it: the record over the goal-writer's
    // KV, the `.schedule` request over the SERVE connection (the timer row is the serving instance's
    // own, SPEC 13.9; the goal-writer holds none, and minting over it is broker-denied). The yield
    // claims the hold, so a fixture without it is a turn no seat could ever yield.
    const serveJs = jetstream((manager as unknown as { serviceServe: { nc: Parameters<typeof jetstream>[0] } }).serviceServe.nc);
    await mintCheckpoint(actx.kv, serveJs, space, {
      // The hold token is the manager's own derivation (a module-private function), spelled here the
      // same way so the fixture's hold is the one the yield path claims.
      ref: { endpoint: MANAGER_ENDPOINT, token: createHash("sha256").update(`${goalId}:turn-deadline`, "utf8").digest("base64url").slice(0, 43) },
      instanceId: doors.managerInstanceId, epoch: serveEpoch,
      goal: { caller: runner, goalId },
      holder: { id: MANAGER_ENDPOINT, lifecycleUid: doors.managerInstanceId },
      deadline: DEADLINE_AT, now: ACCEPTED_AT,
    });

    await doors.adoptTurnGoal({ ref, iid: doors.managerInstanceId, allocated, note });
    const adopted = doors.pendingTurns.get(goalId);
    check("the boot sweep adopts a predecessor's accepted turn back into the pending index",
      adopted !== undefined && adopted.seat.name === "adopted-seat", adopted);
    check("stamped with the acceptance time its goal RECORDS, never the instant the manager booted",
      adopted?.acceptedAt === ACCEPTED_AT, { recorded: ACCEPTED_AT, adopted: adopted?.acceptedAt });
    check("and NOT marked as addressing a dead seat: an empty agents map at boot is not evidence of death",
      adopted?.seatDiedAt === undefined, adopted?.seatDiedAt);
    // AND THE ADOPTED TURN'S ANSWER IS REMEMBERED. Adoption rebuilt the pending relay and not the
    // acceptance the retry answer is remembered against, so a yield whose reply was lost after a
    // restart heard `not-found` on the one path adoption exists for. The seat yields once (the
    // reply is "lost"), then retries the same goal and must hear the answer it earned.
    const adoptDoors = adopting as unknown as {
      serveTurnYield: (c: { owner: string; actor: string; uid: string }, raw: Record<string, unknown>) => Promise<{ goalId: string; state: string }>;
      goalReconcileDone: boolean;
    };
    adoptDoors.goalReconcileDone = true;
    // The yield's commit proves the executor's LIVE currency against the agents map (a seat that
    // died between its yield and the commit refuses `expired`); the adopting manager here never
    // started, so its map is empty and the fixture registers the seat the way a resume would.
    (adopting as unknown as { agents: Map<string, { name: string; lifecycleUid: string }> }).agents.set(allocated.name, { name: allocated.name, lifecycleUid: seatUid });
    const adoptedSeat = { owner: "local", actor: allocated.actor, uid: seatUid };
    const asValue = (e: unknown) => ({ code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 200) });
    const first = await adoptDoors.serveTurnYield(adoptedSeat, { goalId, status: "done" }).then((r) => r, asValue);
    const retried = await adoptDoors.serveTurnYield(adoptedSeat, { goalId, status: "done" }).then((r) => r, asValue);
    check("an adopted turn yields, and a retry of that yield is served the answer it earned, never `not-found`",
      (first as { state?: string }).state === "succeeded" && (retried as { state?: string }).state === "succeeded",
      { first, retried });

    // A RELAY RECORD WITH NO HOLD. The hold is minted after the index entry and the goal record,
    // so a crash between them leaves exactly this shape. Adopted, it would be a pending turn
    // nothing can settle: the sweep would try to expire a pause that was never minted, every tick,
    // and its seat could never yield it. Left unsettled instead, said once.
    const holdless = "h".repeat(43);
    const holdlessRef: GoalRef = { endpoint: MANAGER_ENDPOINT, caller: runner, goalId: holdless };
    await bindGoal(actx, holdlessRef, "fp-holdless");
    await createGoal(actx, holdlessRef, {
      fingerprint: "fp-holdless", command: "turn",
      caller: { id: `${runner.owner}.${runner.actor}`, lifecycleUid: runner.uid },
      acceptedEpoch: 0, requestId: holdless, sourceSeq: 0, acceptedAt: ACCEPTED_AT, readinessDeadlineMs: 600_000,
      target: { owner: "local", actor: "seat9", lifecycleUid: seatUid, mappingRevision: 0 },
    });
    await recordGoalIndex(actx, holdlessRef, doors.managerInstanceId, allocated, note);
    await doors.adoptTurnGoal({ ref: holdlessRef, iid: doors.managerInstanceId, allocated, note });
    check("a turn whose hold was never minted is not adopted as pending: nothing could settle it",
      !doors.pendingTurns.has(holdless) && !(adopting as unknown as { turnAcceptances: Map<string, unknown> }).turnAcceptances.has(holdless),
      { pending: doors.pendingTurns.has(holdless) });
    await adopting.stop().catch(() => {});
  }


} finally {
  await callerNc?.drain().catch(() => callerNc?.close());
  await observerNc?.drain().catch(() => observerNc?.close());
  await manager?.stop().catch(() => {});
  await delivery?.stop().catch(() => {});
  await broker.stop().catch(() => {});
}

const EXPECTED_CELLS = 17;
console.log(`\n${fail === 0 ? "MANAGER RECONCILE STARTUP SMOKE OK ✅" : "MANAGER RECONCILE STARTUP SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);

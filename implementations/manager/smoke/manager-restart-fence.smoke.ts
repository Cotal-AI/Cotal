/**
 * MANAGER RESTART + GOAL-TERMINAL SURVIVAL smoke (control-surface P2 item 3, slice 3a) — the P2
 * acceptance line: "manager endpoint restart preserves the logical instance + durable goal handle."
 *
 * RETARGETED. This suite used to assert the opposite of what it asserts now, so the inversion is
 * spelled out rather than left for a reader to infer. It encoded the epoch-scoped terminal subject
 * `…result.<execEpoch>`: the predecessor's terminal was expected to be INVISIBLE to the restarted
 * current-epoch reader, and the successor was expected to write a second terminal that callers
 * would see instead. That mechanism is gone: §13.2 reserved subjects reserves a flat `…result` leaf with no epoch
 * token, and it was not merely non-conformant — it was wrong. The window is "commit the terminal,
 * then die before projecting it", in which the pre-restart fact is the LEGITIMATE outcome of work
 * that really happened, not a corpse's guess. Hiding it lost a real `succeeded` and let a successor
 * contradict it.
 *
 * WHAT IT ASSERTS NOW: a restart neither hides nor overwrites the terminal that was already
 * committed. The pre-restart fact SURVIVES and is exactly what the restarted incarnation reads, and
 * the successor's contradictory second terminal LOSES the create-only CAS and reads back the
 * winner. Attribution is what distinguishes the two commits (SPEC 13.6), not subject scoping.
 *
 * OPEN mesh (evictor-free — pin 2: a bare registration mints no serve family, so a restart needs no
 * delivery daemon). The manager persists its logical instanceId + serve identity under .cotal, so a
 * restart in the SAME workspace root re-registers the SAME instanceId with an ADVANCED processEpoch
 * through the §13.1 gate — which this suite still asserts, because id persistence and epoch advance
 * are 3a's own subject matter.
 *
 * LEASE RELEASE ACROSS A RECONNECT (#3916). The last cells cut a manager's connection for real,
 * through a TCP relay in front of the same broker, just before a clean stop: the release must
 * survive its lease reads timing out, and its two documented limits (a lost conditional delete is
 * not retried, and retries stop after one lease TTL) are held as controls.
 *
 * Run: pnpm smoke:manager-restart-fence   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect as tcpConnect, type Server, type Socket } from "node:net";
import { connect, TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import type { ActionContext, EpAttributedReply, EpCaller, EpEnvelopeError as EpEnvelopeErrorType, ParsedEpRequest, Connector, LaunchSpec } from "@cotal-ai/core";
import type { CotalEndpoint as SourceCotalEndpoint } from "../../../packages/core/src/index.js";
// `CotalEndpoint` comes from SOURCE while everything else above comes from the built package, and
// the split is deliberate. The long-lived-client behaviour graded below lives in
// `invokeService`, and a suite that imports `dist` cannot make a claim about `src`: a mutation of
// the source leaves it green, which is a mutation surviving for the one reason that says nothing
// about the test. Nothing is shared across the two copies — the client's only contact with the
// manager (which reaches core through `dist`) is over NATS, and the goal helpers above operate on
// the manager's own context, so no branded object crosses the boundary.
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

const home = mkdtempSync(join(tmpdir(), "cotal-mrf-home-"));
process.env.COTAL_HOME = home;
const {
  probeConnect, newIdentity, mintLifecycleUid, DEV_OWNER, EpEnvelopeError,
  bindGoal, createGoal, commitGoalResult, readGoalResult, goalRefOf, registry, MANAGER_LEASE_TTL_MS,
  MANAGER_LEASE_ATTEMPT_MS,
} = await import("@cotal-ai/core");
const { CotalEndpoint } = await import("../../../packages/core/src/index.js");
const { recordMesh, loadManagerInstanceIdentity } = await import("@cotal-ai/workspace");
const { Manager } = await import("../src/manager.js");
const { MANAGER_ENDPOINT } = await import("../src/manager-service-contract.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "mgr-restart-fence";
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-mrf-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });

const kids: ChildProcess[] = [];
type MgrPriv = { managerInstanceId: string; serviceServe?: { grant: { epoch: number; instanceId: string } }; goalWriter?: { ctx: ActionContext }; renewLease: () => Promise<void>; renewLeaseAttempt: () => Promise<void>; ep: SourceCotalEndpoint };
// THE FIXTURE'S HARNESS. `spawn` on the class rail needs a manager whose boot inventory holds an
// AVAILABLE connector (#1724): a manager with none declines the class `one` rail for spawn/launch,
// so an unpinned `manager.spawn` has no responder at all — `unavailable no responder` — and the
// stale-bind fence this block grades (refuse-before-run, re-issue, counted recovery) can never fire.
// The stub declares `requires: ["node"]` (satisfied by the very runtime running this suite) and a
// `buildLaunch` that never runs: the cells below spawn a GHOST persona, which the manager refuses at
// the persona lookup before any connector is consulted, so the answer is the manager's own refusal
// at its epoch — exactly what these cells were written to grade. An operator-run manager always has
// a real connector (that is its purpose), so this is the representative shape, not a special one.
registry.register({
  kind: "connector", name: "mrf-stub", requires: ["node"],
  buildLaunch: (): LaunchSpec => ({ command: process.execPath, args: ["-e", ""], env: {} }),
} as Connector);
const bootManager = async (root = workspaceRoot, servers = SERVER): Promise<InstanceType<typeof Manager>> => {
  const m = new Manager({ space: SPACE, servers, runtime: "pty", workspaceRoot: root });
  await m.start();
  return m;
};

// A goal owned by a synthetic caller, executor-pinned to the manager instance (the (i) fence key).
const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
const reqFor = (goalId: string): ParsedEpRequest =>
  ({ plane: "request", route: "one", endpoint: MANAGER_ENDPOINT, command: "spawn", caller, id: goalId } as unknown as ParsedEpRequest);

// A TCP relay in front of the broker. `outage` drops every piped socket and holds new dials until it
// ends, which is what a reconnecting client meets. `loseNextDelete` arms one more outage at the
// conditional delete of `key`, started in place of forwarding it, so the delete never lands.
class Relay {
  private readonly socks = new Set<Socket>();
  private readonly held: Socket[] = [];
  private server?: Server;
  private down = false;
  key = "";
  loseNextDelete = 0;
  deletesLost = 0;
  deletesForwarded = 0;
  async listen(): Promise<string> {
    const server = createServer((c) => { c.on("error", () => {}); if (this.down) { c.pause(); this.held.push(c); } else this.pipe(c); });
    this.server = server;
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    return `nats://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  private pipe(c: Socket): void {
    const u = tcpConnect(PORT, "127.0.0.1");
    u.on("error", () => {});
    this.socks.add(c); this.socks.add(u);
    c.on("data", (d) => {
      const text = d.toString("latin1");
      if (this.key && text.includes(`.${this.key} `) && /^HPUB \$KV\./m.test(text) && /KV-Operation:\s*DEL/i.test(text)) {
        if (this.loseNextDelete) { const ms = this.loseNextDelete; this.loseNextDelete = 0; this.deletesLost++; this.outage(ms); return; }
        this.deletesForwarded++;
      }
      u.write(d);
    });
    u.on("data", (d) => c.write(d));
    c.on("close", () => { u.destroy(); this.socks.delete(c); });
    u.on("close", () => { c.destroy(); this.socks.delete(u); });
    c.resume();
  }
  outage(ms: number): void {
    this.down = true;
    for (const s of this.socks) s.destroy();
    this.socks.clear();
    setTimeout(() => { this.down = false; for (const c of this.held.splice(0)) if (!c.destroyed) this.pipe(c); }, ms);
  }
  close(): void { for (const s of [...this.socks, ...this.held]) s.destroy(); this.server?.close(); }
}

let mgr: InstanceType<typeof Manager> | undefined;
let client: SourceCotalEndpoint | undefined;
let reader: SourceCotalEndpoint | undefined;
const relays: Relay[] = [];
const relayed: Array<InstanceType<typeof Manager>> = [];
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}mrf-js-`))], { stdio: "ignore" });
  teardownOnSignal(broker);
  kids.push(broker);
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break; await wait(120); }
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  // ── incarnation 1 (epoch 0) ──
  mgr = await bootManager();
  const M1 = mgr as unknown as MgrPriv;
  const iid1 = M1.managerInstanceId;
  const epoch1 = M1.serviceServe!.grant.epoch;
  check("incarnation 1 registered its persisted instanceId at epoch 0 (a FIRST registration)",
    M1.serviceServe!.grant.instanceId === iid1 && epoch1 === 0, { iid1, epoch1 });
  check("the logical instanceId is persisted on disk (.cotal manager-instance file)",
    loadManagerInstanceIdentity(workspaceRoot, SPACE)?.instanceId === iid1);

  // A goal ACCEPTED under epoch 0 and terminated by incarnation 1 before it dies. This is the
  // legitimate pre-restart winner: the work really ran and its outcome is already durable.
  const gw1 = M1.goalWriter!.ctx;
  const ref1 = goalRefOf(reqFor("g-pre-restart"), "g-pre-restart");
  await bindGoal(gw1, ref1, "fp-pre-restart");
  await createGoal(gw1, ref1, {
    fingerprint: "fp-pre-restart", command: "spawn", caller: { id: `${caller.owner}.${caller.actor}`, lifecycleUid: caller.uid },
    requestId: "g-pre-restart", sourceSeq: 0, acceptedAt: 1_000_000, readinessDeadlineMs: 30_000,
    acceptedEpoch: epoch1,
  });
  await commitGoalResult(gw1, {
    ref: ref1, now: 1_000_001, cause: "complete", state: "failed",
    data: { by: "pre-restart" }, committer: { instanceId: iid1, epoch: epoch1 },
  });
  check("incarnation 1 sees the terminal it committed under its own accepted epoch",
    (await readGoalResult(gw1, ref1))?.state === "failed");

  // A LONG-LIVED CLIENT resolves the manager BEFORE the restart. `invokeService` caches the resolve,
  // bound to the incarnation that answered the describe: (iid1, epoch 0). This is the shape of every
  // client that outlives a manager restart (a connector's mesh agent, the console), and what it does
  // with that bind afterwards is graded below.
  client = new CotalEndpoint({
    space: SPACE, servers: SERVER, lifecycleUid: mintLifecycleUid(),
    card: { name: "restart-probe", role: "operator", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  client.on("error", () => {});
  await client.start();
  const cache = (client as unknown as { resolvedServices: Map<string, { responder: { instanceId: string; epoch: number } }> }).resolvedServices;
  const pubs = (): number => (client as unknown as { nc: { stats(): { outMsgs: number } } }).nc.stats().outMsgs;
  const warm = await client.invokeService(MANAGER_ENDPOINT, "ps");
  check("a long-lived client is bound to incarnation 1 before the restart",
    warm.reply.ok === true && cache.get(MANAGER_ENDPOINT)?.responder.instanceId === iid1 && cache.get(MANAGER_ENDPOINT)?.responder.epoch === epoch1,
    { reply: warm.reply, bound: cache.get(MANAGER_ENDPOINT)?.responder });
  // A SECOND long-lived client, bound the same honest way, for the read arm below: it obtains its
  // stale bind by outliving the restart, not by having one written into it.
  reader = new CotalEndpoint({
    space: SPACE, servers: SERVER, lifecycleUid: mintLifecycleUid(),
    card: { name: "restart-reader", role: "operator", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  reader.on("error", () => {});
  await reader.start();
  const readerCache = (reader as unknown as { resolvedServices: Map<string, { responder: { instanceId: string; epoch: number } }> }).resolvedServices;
  const readerPubs = (): number => (reader as unknown as { nc: { stats(): { outMsgs: number } } }).nc.stats().outMsgs;
  const readerWarm = await reader.invokeService(MANAGER_ENDPOINT, "ps");
  check("...and so is a second client, kept for the read arm",
    readerWarm.reply.ok === true && readerCache.get(MANAGER_ENDPOINT)?.responder.epoch === epoch1, readerCache.get(MANAGER_ENDPOINT)?.responder);

  // ── restart: incarnation 2 (same root) ──
  // Issue #367: a renew already in flight when a clean stop begins must not leave the liveness
  // lease key behind for the rest of the bucket TTL. The triage timed SIGTERM against the first
  // renew tick; a suite cannot win that race by timing, so this cell manufactures the exact state
  // the race produces: one `renewManagerLease` call performs TWO broker renews and reports the
  // FIRST revision to the manager, so the broker's row ends one revision ahead of the manager's
  // cached knowledge before `stop()` runs. A stop that releases at the cached revision (the
  // mutation the bind-recovery fixture restores) now misses the row deterministically, not by luck.
  const m1ep = M1.ep as unknown as {
    renewManagerLease: (info: unknown, revision: number) => Promise<number>;
    releaseManagerLease: (instanceId: string, revision: number) => Promise<void>;
    stop: () => Promise<void>;
  };
  const realRenew = m1ep.renewManagerLease.bind(m1ep);
  const realRelease = m1ep.releaseManagerLease.bind(m1ep);
  const realEpStop = m1ep.stop.bind(m1ep);
  let doubled = false;
  // (c) A late renew must cross a stop that has already released the key and still find the gone
  // arm fenced: the fixture's other entry deletes that fence and expects THIS cell red. Both fences
  // guard paths a real SIGTERM can take, but a suite cannot win the timing, so this orders the same
  // crossing by promises instead of a race: the late renew's OWN broker call is held until the
  // stop's release has actually completed, then fires at a revision the release invalidated, on a
  // connection held open until it settles. Unstopped code would re-acquire the key; the gone-arm
  // fence (the mutation target) is the only thing that does not.
  let releaseDone = () => {};
  const released = new Promise<void>((res) => { releaseDone = res; });
  // HARDENING (fourth lifecycle): the release below must not run until the tracked renew's
  // cache writes are all done. A release at the cached revision (the mutation entry 4 restores)
  // only misses when the cached revision is BEHIND the row, and every write to `leaseRevision`
  // that precedes the release in program order comes from the tracked renew above: its happy
  // path reports `second - 1` while the row sits at `second`, and its catch path (a refused
  // broker renew reconciling a still-owned row) ADOPTS the row's CURRENT revision, which would
  // hand the mutant a revision that no longer misses. Awaiting the tracked renew's settlement
  // inside the release wrapper pins the order structurally: `stop()` already awaits the tracked
  // renew before it releases, so on the fixed path this gate is already open; and on the mutated
  // path no code can write `leaseRevision` between that settlement and the release, because the
  // late renew for (c) and any interval tick still pending are gated on `released` (the timer is
  // cleared before the wrapper is ever entered). The row is one revision past every revision the
  // manager can believe, on every ordering the host can pick.
  let renewDone = () => {};
  const renewSettled = new Promise<void>((res) => { renewDone = res; });
  m1ep.releaseManagerLease = async (instanceId, revision) => {
    await renewSettled;
    // A finally, not a then: this must open the gate even when a mutation makes the CAS above throw
    // (entry 3 replaces the released call with one at the stale cached revision), or the late renew
    // below would wait forever on a release that never resolves.
    try { await realRelease(instanceId, revision); } finally { releaseDone(); }
  };
  // The doubled wrapper closes over `realRenew`, not over `m1ep.renewManagerLease`, so once
  // `renewLease()` below has invoked it (its broker calls already running against `realRenew`
  // directly), the slot can be swapped to the gated version immediately: the doubled call is
  // unaffected, and the untracked late renew for (c) sees only the gated version, never the doubled
  // one.
  m1ep.renewManagerLease = async (info, revision) => {
    // The finally feeds the release wrapper's gate above: settlement means every cache write this
    // attempt will ever make has landed, not merely that its last broker call returned.
    try {
      const second = await realRenew(info, await realRenew(info, revision));
      doubled = true;
      return second - 1;
    } finally { renewDone(); }
  };
  void M1.renewLease();
  m1ep.renewManagerLease = async (info, revision) => {
    await released;
    return realRenew(info, revision);
  };
  // Fired here, BEFORE stop(): untracked (not through `renewLease()`'s entry fence, and not joined
  // by stop's `leaseRenewTask`), so stop cannot wait it out. Its broker call is gated above and does
  // not actually run until the release below has completed.
  const lateRenewSettled = M1.renewLeaseAttempt();
  // stop() closes the endpoint last (`await this.ep.stop()`); keep it open until the late renew has
  // fully settled, so its verdict (gone, not unknown-from-a-closed-connection) is always reached.
  m1ep.stop = async () => { await lateRenewSettled.catch(() => {}); await realEpStop(); };
  await mgr.stop({ withAgents: true });
  m1ep.renewManagerLease = realRenew;
  m1ep.releaseManagerLease = realRelease;
  m1ep.stop = realEpStop;
  check("...(a) prelude: the double renew really landed, row one revision past the cache", doubled, { doubled });
  const leaseAfterStop = await client.readOwnManagerLease(iid1);
  check("(a) a clean stop with a renew in flight still removes the lease key", leaseAfterStop === undefined, leaseAfterStop);
  check("(c) a renew that runs after the stop does not put the key back", leaseAfterStop === undefined, leaseAfterStop);

  const bootStarted = Date.now();
  mgr = await bootManager();
  const bootMs = Date.now() - bootStarted;
  check("(b) the successor boots at once after that stop, without waiting out the lease TTL", bootMs < MANAGER_LEASE_TTL_MS / 2, { bootMs, ttl: MANAGER_LEASE_TTL_MS });

  const M2 = mgr as unknown as MgrPriv;
  const iid2 = M2.managerInstanceId;
  const epoch2 = M2.serviceServe!.grant.epoch;

  check("the restart PRESERVED the logical instanceId (persisted, not a fresh mint)", iid2 === iid1, { iid1, iid2 });
  check("the restart ADVANCED the process epoch through the §13.1 gate (superseding the predecessor)",
    epoch2 > epoch1 && M2.serviceServe!.grant.instanceId === iid1, { epoch1, epoch2 });

  // ── the long-lived client across the restart ──
  // WHAT A STALE-EPOCH CALL COSTS, AND WHY THAT CHANGED. A different instance answering is
  // `failed-precondition`; the SAME instance answering at a later epoch is `expired`. Distsys review
  // measured, on a real same-root restart, that this path retained the stale (iid1, epoch 0) bind:
  // every later deliberate call reached the successor, may have applied its effect, came back
  // `expired`, and stayed bound to epoch 0, so a long-lived client never recovered.
  //
  // THE INVERSION HERE. This block used to require that an UNSAFE command surface that `expired` and
  // re-issue NOTHING — the honest answer while the mismatch was only detectable on the reply, after
  // the successor had already handled the request. The request now carries the incarnation the
  // caller bound (§13.3), so the successor REFUSES IT BEFORE RUNNING IT and says so. That converts
  // the cost from "surface an error the operator must go and verify" into "re-resolve and issue it
  // for the first time", and the client does that inside the one call — for `spawn` as much as for
  // a read, because what gated the old retry was not knowing whether the effect had landed.
  //
  // The old surfacing path is NOT deleted: a responder too old to know the field ignores it and
  // executes, and there the caller-side check and the {@link isRepeatSafeCommand} allowlist are
  // still the only protection. That skewed pair has no live producer here, so it is no longer
  // gated by this suite — it keeps its unit coverage and nothing more, which is worth knowing
  // before anyone reads the allowlist as dead code.
  console.log("\n-- a long-lived client's cached bind across the restart --");
  {
    // An UNSAFE command (`spawn` creates; the persona does not exist, so incarnation 2 refuses it
    // cheaply and nothing starts, but it ANSWERS, at epoch 1, and that answer is what the cached
    // client must not mistake for its bound incarnation's).
    const before = pubs();
    const splitsBefore = client.splitRecoveryCount;
    const announced: Array<{ command?: string; servedBy?: { instanceId: string; epoch: number }; splitsRecovered?: number }> = [];
    client.on("split-recovered", (e: unknown) => announced.push(e as (typeof announced)[number]));
    let threw: unknown;
    let reply: EpAttributedReply | undefined;
    try { reply = await client.invokeService(MANAGER_ENDPOINT, "spawn", { name: `ghost-${mintLifecycleUid().slice(0, 6)}`, agent: "claude" }); } catch (e) { threw = e; }
    check("the stale-epoch client's UNSAFE call no longer surfaces `expired` — the successor refused it before running it",
      threw === undefined, threw instanceof Error ? `${(threw as EpEnvelopeErrorType).code ?? ""} ${threw.message.slice(0, 160)}` : threw);
    check("...and what comes back is the SUCCESSOR's own answer, at ITS epoch",
      reply?.responder.instanceId === iid1 && reply?.responder.epoch === epoch2, { responder: reply?.responder, epoch2 });
    // The re-issue is the whole point, and it is only safe because the first attempt PROVED it did
    // not run. Asserting the publish count is what tells a re-issue from a single lucky call: this
    // cell is the exact inverse of the one it replaces, and it must not be able to pass both ways.
    check("...it WAS re-issued (the old guard's single publish would have left the caller stranded)",
      pubs() - before > 1, { publishes: pubs() - before });
    check("...and the reply is the manager's own refusal, not the bind refusal (the second attempt really ran)",
      reply?.reply.ok === false && !/WAS NOT RUN/.test(reply.reply.error?.message ?? ""), reply?.reply.error);
    check("...and the stale (epoch 0) bind was replaced by the successor's, inside that one call",
      cache.get(MANAGER_ENDPOINT)?.responder.epoch === epoch2, { got: cache.get(MANAGER_ENDPOINT)?.responder });
    // THE RECOVERY IS COUNTED, and this is the cell that keeps it counted. Handling the split makes
    // it invisible, and that routing event is the only evidence the split exists — so a recovery
    // that leaves no trace destroys the very measurement that justified building the fence. The
    // count is checked against a BEFORE value, not against zero: a counter stuck at a constant and
    // a counter that never moves are the same reading unless you took both.
    check("...and the silent recovery was COUNTED (the split stays measurable while being handled)",
      client!.splitRecoveryCount === splitsBefore + 1, { before: splitsBefore, after: client!.splitRecoveryCount });
    check("...and it was announced to anyone listening, naming the instance that refused",
      announced.length === 1 && announced[0].command === "spawn" && announced[0].servedBy?.instanceId === iid1
      && announced[0].servedBy?.epoch === epoch2 && announced[0].splitsRecovered === client!.splitRecoveryCount,
      announced);

    // THE STRAND, OR NOT. The operator verifies and deliberately re-issues. With the bind retained,
    // this call reused (iid1, epoch 0), reached the successor AGAIN and came back `expired` again,
    // forever. It must re-resolve and be answered by the successor at ITS epoch (a refusal reply
    // here, since the persona still does not exist, but a REPLY, attributed to epoch 1).
    let again: unknown;
    let againReply: EpAttributedReply | undefined;
    try { againReply = await client.invokeService(MANAGER_ENDPOINT, "spawn", { name: `ghost-${mintLifecycleUid().slice(0, 6)}`, agent: "claude" }); } catch (e) { again = e; }
    check("a DELIBERATE re-issue reaches the live incarnation and is answered at its current epoch",
      again === undefined && againReply?.responder.instanceId === iid1 && againReply.responder.epoch === epoch2,
      { threw: again instanceof Error ? again.message.slice(0, 160) : again, responder: againReply?.responder, epoch2 });

    check("the re-issue left a fresh bind, at the successor's epoch", cache.get(MANAGER_ENDPOINT)?.responder.epoch === epoch2, cache.get(MANAGER_ENDPOINT)?.responder);

    // THE READ ARM: the second client, still bound to (iid1, epoch 0) from before the restart, reads
    // ONCE. A repeat-safe command on a stale-epoch bind heals inside that one call (drop, re-resolve,
    // re-issue), exactly as it does on the split. Its stale bind is real: obtained by outliving the
    // restart, not written into the cache by the test.
    check("the reader is still bound to the pre-restart epoch (its stale bind is real, not fabricated)",
      readerCache.get(MANAGER_ENDPOINT)?.responder.epoch === epoch1, readerCache.get(MANAGER_ENDPOINT)?.responder);
    const readBefore = readerPubs();
    let readThrew: unknown;
    let read: EpAttributedReply | undefined;
    try { read = await reader!.invokeService(MANAGER_ENDPOINT, "ps"); } catch (e) { readThrew = e; }
    check("a READ bound to the stale epoch heals inside ONE call and comes back bound to the successor",
      readThrew === undefined && read?.reply.ok === true && readerCache.get(MANAGER_ENDPOINT)?.responder.epoch === epoch2,
      { threw: readThrew instanceof Error ? readThrew.message.slice(0, 160) : readThrew, bound: readerCache.get(MANAGER_ENDPOINT)?.responder });
    check("...and that heal re-issued (more than the one publish a held guard leaves)",
      readerPubs() - readBefore > 1, { publishes: readerPubs() - readBefore });
  }

  // THE INVERSION, driven by a real restart. The advanced epoch does not hide the pre-restart fact
  // and does not license overwriting it: one goal has ONE terminal subject, and the first fact won.
  const gw2 = M2.goalWriter!.ctx;
  const survived = await readGoalResult(gw2, ref1);
  check("the pre-restart terminal SURVIVES the restart and is exactly what the restarted incarnation reads",
    survived?.state === "failed" && (survived?.data as { by?: string })?.by === "pre-restart", survived);

  // The successor is a legitimate committer by attribution (committed epoch > accepted epoch = a
  // successor settling inherited work), so nothing REFUSES it on attribution grounds. What stops it
  // is the create-only CAS: the terminal already exists, so it loses and reads back the winner.
  const second = await commitGoalResult(gw2, {
    ref: ref1, now: 1_000_002, cause: "complete", state: "succeeded",
    data: { by: "successor" }, committer: { instanceId: iid1, epoch: epoch2 },
  });
  check("the successor's CONTRADICTORY second terminal loses the create-only CAS and reads back the winner",
    second.won === false && second.fact.state === "failed" && (second.fact.data as { by?: string })?.by === "pre-restart",
    { won: second.won, fact: second.fact });
  const after = await readGoalResult(gw2, ref1);
  check("...and the durable terminal is still the pre-restart one, not the successor's",
    after?.state === "failed" && (after?.data as { by?: string })?.by === "pre-restart", after);

  // ── lease release across a reconnect (#3916) ──
  // Each cell boots its own instance (its own root) through a relay, cuts the relay just before a
  // clean stop, and reads the row over the direct client. The release step and each lease read in
  // it are timed on their way through; every call still runs the manager's own code.
  console.log("\n-- lease release when the stop's connection reconnects --");
  await mgr.stop({ withAgents: true });
  mgr = undefined;
  const stopAcrossOutage = async (label: string, outageMs: number, loseDeleteMs = 0) => {
    const relay = new Relay();
    relays.push(relay);
    const servers = await relay.listen();
    const root = mkdtempSync(join(tmpdir(), `cotal-mrf-${label}-`));
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    recordMesh({ space: SPACE, server: servers, root, mode: "open", ts: new Date().toISOString() });
    const m = await bootManager(root, servers);
    relayed.push(m);
    const priv = m as unknown as MgrPriv & { releaseOwnManagerLease: () => Promise<void> };
    relay.key = `lease.${priv.managerInstanceId}`;
    const ep = priv.ep as unknown as { readOwnManagerLease: (id: string) => Promise<unknown> };
    const realRead = ep.readOwnManagerLease.bind(ep);
    const reads: Array<{ at: number; timedOut: boolean }> = [];
    ep.readOwnManagerLease = async (id) => {
      const at = Date.now();
      try { const r = await realRead(id); reads.push({ at, timedOut: false }); return r; }
      catch (e) { reads.push({ at, timedOut: e instanceof TimeoutError }); throw e; }
    };
    const realRelease = priv.releaseOwnManagerLease.bind(m);
    const release = { start: 0, end: 0 };
    priv.releaseOwnManagerLease = async () => { release.start = Date.now(); try { await realRelease(); } finally { release.end = Date.now(); } };
    await wait(700);
    relay.loseNextDelete = loseDeleteMs;
    if (outageMs) relay.outage(outageMs);
    await wait(50);
    const t0 = Date.now();
    await m.stop({ withAgents: true });
    const stopMs = Date.now() - t0;
    const row = await client!.readOwnManagerLease(priv.managerInstanceId) as { info: { pid: number } } | undefined;
    return { relay, root, servers, release, reads: reads.filter((r) => r.at >= release.start && r.at <= release.end), stopMs, row };
  };

  // A 4500 ms outage spends two attempt deadlines before the broker can answer, so the release
  // only completes if it asks again after a timeout.
  const healed = await stopAcrossOutage("heal", 4_500);
  check("...(d) prelude: the stop's lease reads timed out before one was answered",
    healed.reads[0]?.timedOut === true && healed.reads.some((r) => !r.timedOut), healed.reads.map((r) => r.timedOut));
  check("(d) a clean stop whose lease reads time out across a reconnect still releases the key",
    healed.row === undefined && healed.relay.deletesForwarded === 1, { row: healed.row, deletes: healed.relay.deletesForwarded, stopMs: healed.stopMs });
  let healedRestart: unknown;
  try { relayed.push(await bootManager(healed.root, healed.servers)); } catch (e) { healedRestart = e; }
  check("...and a same-root restart of that instance starts at once",
    healedRestart === undefined, healedRestart instanceof Error ? healedRestart.message.slice(0, 160) : healedRestart);

  // Control: the conditional delete is sent once. Lost to a disconnect, the key stays for its TTL
  // and a same-root restart is refused until then, which is what the docs promise and no more.
  const lost = await stopAcrossOutage("lost-delete", 0, 2_500);
  check("(e) control: a conditional delete lost to a disconnect is not sent again, and the key stays",
    lost.relay.deletesLost === 1 && lost.relay.deletesForwarded === 0 && lost.row?.info.pid === process.pid,
    { lost: lost.relay.deletesLost, forwarded: lost.relay.deletesForwarded, row: lost.row, stopMs: lost.stopMs });
  let lostRestart: unknown;
  try { relayed.push(await bootManager(lost.root, lost.servers)); } catch (e) { lostRestart = e; }
  check("...and a same-root restart inside that TTL is refused",
    lostRestart instanceof Error && /already serves space/.test(lostRestart.message), lostRestart instanceof Error ? lostRestart.message.slice(0, 160) : lostRestart);

  // Control: an outage longer than one TTL. Only the start of a retry is bounded: none starts once
  // one TTL has passed since the first read, so the one read that may start later is the
  // confirming read, and an attempt already in flight still runs to its own deadline.
  const blackout = await stopAcrossOutage("blackout", MANAGER_LEASE_TTL_MS + 3 * MANAGER_LEASE_ATTEMPT_MS);
  const lateReads = blackout.reads.filter((r) => r.at >= blackout.reads[0].at + MANAGER_LEASE_TTL_MS).length;
  check("(f) control: under an outage longer than one lease TTL no retry starts after that TTL, and no delete is sent",
    blackout.reads.length > 1 && blackout.reads.every((r) => r.timedOut) && lateReads <= 1 && blackout.relay.deletesForwarded === 0,
    { reads: blackout.reads.length, lateReads, timedOut: blackout.reads.filter((r) => r.timedOut).length, deletes: blackout.relay.deletesForwarded, stopMs: blackout.stopMs });
} finally {
  for (const m of relayed) await m.stop({ withAgents: true }).catch(() => {});
  for (const r of relays) r.close();
  await reader?.stop().catch(() => {});
  await client?.stop().catch(() => {});
  await mgr?.stop({ withAgents: true }).catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "MANAGER RESTART + TERMINAL SURVIVAL SMOKE OK ✅" : "MANAGER RESTART + TERMINAL SURVIVAL SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

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
 * Run: pnpm smoke:manager-restart-fence   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { createServer, type AddressInfo } from "node:net";
import {
  probeConnect, newIdentity, mintLifecycleUid, DEV_OWNER, EpEnvelopeError,
  bindGoal, createGoal, commitGoalResult, readGoalResult, goalRefOf,
  type ActionContext, type EpAttributedReply, type EpCaller, type ParsedEpRequest,
} from "@cotal-ai/core";
// `CotalEndpoint` comes from SOURCE while everything else above comes from the built package, and
// the split is deliberate. The long-lived-client behaviour graded below lives in
// `invokeService`, and a suite that imports `dist` cannot make a claim about `src`: a mutation of
// the source leaves it green, which is a mutation surviving for the one reason that says nothing
// about the test. Nothing is shared across the two copies — the client's only contact with the
// manager (which reaches core through `dist`) is over NATS, and the goal helpers above operate on
// the manager's own context, so no branded object crosses the boundary.
import { CotalEndpoint } from "../../../packages/core/src/index.js";
import { recordMesh, loadManagerInstanceIdentity } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
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
type MgrPriv = { managerInstanceId: string; serviceServe?: { grant: { epoch: number; instanceId: string } }; goalWriter?: { ctx: ActionContext } };
const bootManager = async (): Promise<InstanceType<typeof Manager>> => {
  const m = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await m.start();
  return m;
};

// A goal owned by a synthetic caller, executor-pinned to the manager instance (the (i) fence key).
const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
const reqFor = (goalId: string): ParsedEpRequest =>
  ({ plane: "request", route: "one", endpoint: MANAGER_ENDPOINT, command: "spawn", caller, id: goalId } as unknown as ParsedEpRequest);

let mgr: InstanceType<typeof Manager> | undefined;
let client: CotalEndpoint | undefined;
let reader: CotalEndpoint | undefined;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-mrf-js-"))], { stdio: "ignore" });
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
  await mgr.stop();
  mgr = await bootManager();
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
    client.on("split-recovered", (e) => announced.push(e as (typeof announced)[number]));
    let threw: unknown;
    let reply: EpAttributedReply | undefined;
    try { reply = await client.invokeService(MANAGER_ENDPOINT, "spawn", { name: `ghost-${mintLifecycleUid().slice(0, 6)}`, agent: "claude" }); } catch (e) { threw = e; }
    check("the stale-epoch client's UNSAFE call no longer surfaces `expired` — the successor refused it before running it",
      threw === undefined, threw instanceof Error ? `${(threw as EpEnvelopeError).code ?? ""} ${threw.message.slice(0, 160)}` : threw);
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
} finally {
  await reader?.stop().catch(() => {});
  await client?.stop().catch(() => {});
  await mgr?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

console.log(`\n${fail === 0 ? "MANAGER RESTART + TERMINAL SURVIVAL SMOKE OK ✅" : "MANAGER RESTART + TERMINAL SURVIVAL SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

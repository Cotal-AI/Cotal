/**
 * MANAGER RESTART + GOAL-TERMINAL SURVIVAL smoke (control-surface P2 item 3, slice 3a) — the P2
 * acceptance line: "manager endpoint restart preserves the logical instance + durable goal handle."
 *
 * RETARGETED. This suite used to assert the opposite of what it asserts now, so the inversion is
 * spelled out rather than left for a reader to infer. It encoded the epoch-scoped terminal subject
 * `…result.<execEpoch>`: the predecessor's terminal was expected to be INVISIBLE to the restarted
 * current-epoch reader, and the successor was expected to write a second terminal that callers
 * would see instead. That mechanism is gone (SPEC:1394 reserves a flat `…result` leaf with no epoch
 * token), and it was not merely non-conformant — it was wrong. The window is "commit the terminal,
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
  probeConnect, newIdentity, mintLifecycleUid, DEV_OWNER, CotalEndpoint, EpEnvelopeError, respondedButUnbound,
  bindGoal, createGoal, commitGoalResult, readGoalResult, goalRefOf,
  type ActionContext, type EpAttributedReply, type EpCaller, type ParsedEpRequest,
} from "@cotal-ai/core";
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
  // The split-retry guard's rule, on the ADJACENT path. A different instance answering is
  // `failed-precondition` (graded in instrument-instance-pin); the SAME instance answering at a
  // later epoch is `expired`, raised after the attributed reply exactly the same way. Distsys review
  // measured, on a real same-root restart, that this path retained the stale (iid1, epoch 0) bind:
  // every later deliberate call reached the successor, may have applied its effect, came back
  // `expired`, and stayed bound to epoch 0, so a long-lived client never recovered. Same rule as the
  // split: drop the bind, re-issue nothing unsafe, let a repeat-safe read heal in one call.
  console.log("\n-- a long-lived client's cached bind across the restart --");
  {
    // An UNSAFE command (`spawn` creates; the persona does not exist, so incarnation 2 refuses it
    // cheaply and nothing starts, but it ANSWERS, at epoch 1, and that answer is what the cached
    // client must not mistake for its bound incarnation's).
    const before = pubs();
    let threw: unknown;
    try { await client.invokeService(MANAGER_ENDPOINT, "spawn", { name: `ghost-${mintLifecycleUid().slice(0, 6)}`, agent: "claude" }); } catch (e) { threw = e; }
    check("the stale-epoch client's UNSAFE call is refused as `expired` (the successor answered at a later epoch)",
      threw instanceof EpEnvelopeError && threw.code === "expired", threw instanceof Error ? `${(threw as EpEnvelopeError).code ?? ""} ${threw.message.slice(0, 160)}` : threw);
    check("...carrying the responder-answered marker (a responder DID answer; a retry is a second attempt)",
      respondedButUnbound(threw), threw instanceof Error ? threw.message.slice(0, 200) : threw);
    check("...and the message says which side is stale: the responder is a SUCCESSOR of the incarnation this handle holds",
      threw instanceof Error && /successor/i.test(threw.message), threw instanceof Error ? threw.message.slice(0, 260) : threw);
    check("...and NOTHING was re-issued: exactly one publish", pubs() - before === 1, { publishes: pubs() - before });
    check("...and the stale (epoch 0) bind was dropped", cache.get(MANAGER_ENDPOINT) === undefined, { got: cache.get(MANAGER_ENDPOINT)?.responder });

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

    // THE READ ARM: a repeat-safe command bound to the stale epoch heals inside ONE call (drop,
    // re-resolve, re-issue), exactly as it does on the split. Force the old epoch back onto the
    // fresh bind and read once.
    const fresh = cache.get(MANAGER_ENDPOINT);
    check("the re-issue left a fresh bind, at the successor's epoch", fresh?.responder.epoch === epoch2, fresh?.responder);
    if (fresh) fresh.responder.epoch = epoch1;
    const readBefore = pubs();
    let readThrew: unknown;
    let read: EpAttributedReply | undefined;
    try { read = await client.invokeService(MANAGER_ENDPOINT, "ps"); } catch (e) { readThrew = e; }
    check("a READ bound to the stale epoch heals inside ONE call and comes back bound to the successor",
      readThrew === undefined && read?.reply.ok === true && cache.get(MANAGER_ENDPOINT)?.responder.epoch === epoch2,
      { threw: readThrew instanceof Error ? readThrew.message.slice(0, 160) : readThrew, bound: cache.get(MANAGER_ENDPOINT)?.responder });
    check("...and that heal re-issued (more than the one publish a held guard leaves)",
      pubs() - readBefore > 1, { publishes: pubs() - readBefore });
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
  await client?.stop().catch(() => {});
  await mgr?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

console.log(`\n${fail === 0 ? "MANAGER RESTART + TERMINAL SURVIVAL SMOKE OK ✅" : "MANAGER RESTART + TERMINAL SURVIVAL SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

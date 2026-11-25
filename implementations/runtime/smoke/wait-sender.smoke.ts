/**
 * `wait(message(channel, { from }))` matches the principal the broker bound to the message, on a
 * real broker, through a driven program.
 *
 * The program spawns a seat named `lead` and waits for `^APPROVED` from it. The broker binds only
 * the subject's sender tokens to a publisher; a payload's `from.name` is whatever the sender
 * wrote, and its `from.id` is a claim the receiver checks against the subject (SPEC §5). So the
 * wait resolves `from` to the principal this run's roster recorded for that handle and compares it
 * with the subject's sender, after dropping any message whose `from.id` disagrees with its subject.
 *
 * Cells, one driven run each:
 *   1. the real seat's post answers the wait (control);
 *   2. another principal posting as `lead` does not, and the wait keeps waiting until the real
 *      seat posts;
 *   3. a post on the seat's own subject whose `from.id` names someone else is ignored;
 *   4. with no `from`, a post whose `from.id` names the seat but whose subject is another
 *      principal's is ignored;
 *   5. a principal whose presence row claims the seat's name and incarnation, so the name is held
 *      by two live principals, does not answer;
 *   6. a `from` handle this run never spawned is refused instead of matched by name.
 *
 * The far side is a suite-served manager-shaped endpoint (the runtime never imports
 * `@cotal-ai/manager`), as in the replied and turn suites. Posts go out through the shipped
 * `CotalEndpoint.multicast`; the two forged-id posts are raw publishes, because the endpoint API
 * writes `from` from its own card and cannot produce them.
 *
 * Run: pnpm smoke:runtime-wait-sender   (needs nats-server on PATH)
 */
import { spawn as spawnProc } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  createSpaceStreams,
  openRecordsBucket,
  presenceBucket,
  chatStream,
  chatSubject,
  compileContract,
  SPAWN_INPUT_SCHEMA,
  SPAWN_OUTPUT_SCHEMA,
  GRACEFUL_INPUT_SCHEMA,
  STOP_OUTPUT_SCHEMA,
  CANCEL_INPUT_SCHEMA,
  TURN_YIELD_OUTPUT_SCHEMA,
  contractDigest,
  contractStoreContext,
  publishContractArtifact,
  contractArtifactCanonicalBytes,
  epAuthBucket,
  serveIssuanceGateKv,
  provisionEndpointGateOpen,
  endpointRegistrationBarrier,
  registerServiceInstance,
  authorizeServeGrant,
  serveEndpoint,
  actionContext,
  bindGoal,
  createGoal,
  commitGoalResult,
  requestGoalCancel,
  goalRefOf,
  submissionFingerprint,
  replayRunJournal,
  newTakeoverId,
  waitConsumerName,
  EpEnvelopeError,
  CotalEndpoint,
  type CotalMessage,
  type EpCommandDef,
  type EpServeContext,
  type EpCaller,
} from "@cotal-ai/core";
import { type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { emitSentinel, withDeadline, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const SPACE = "waitsender";
const EP = "manager";
const MGR_IID = "m".repeat(26);
const HOLDER = { id: "manager", lifecycleUid: "u_waitsender" };
const CALLER: EpCaller = { owner: "local", actor: "wf_waitsender", uid: "a".repeat(26) };
const CHANNEL = "approvals";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── broker + planes ────────────────────────────────────────────────────────────────────────────
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const sd = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}waitsender-`));
const broker = spawnProc("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
teardownOnSignal(broker, sd);
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);
let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(SERVERS); if (!up) await pause(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const nc = await connect({ servers: SERVERS });
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
await createSpaceStreams(jsm, SPACE);
const kv = await openRecordsBucket(nc, SPACE);
await new Kvm(nc).create(presenceBucket(SPACE));

// ── the suite-served manager: spawn, despawn, cancel ──────────────────────────────────────────
const cc = (root: unknown) => compileContract({ root: root as Record<string, unknown> });
const COMPILED = {
  spawn: { input: cc(SPAWN_INPUT_SCHEMA), output: cc(SPAWN_OUTPUT_SCHEMA) },
  despawn: { input: cc(GRACEFUL_INPUT_SCHEMA), output: cc(STOP_OUTPUT_SCHEMA) },
  cancel: { input: cc(CANCEL_INPUT_SCHEMA), output: cc(TURN_YIELD_OUTPUT_SCHEMA) },
};
const DOCUMENT = {
  urn: "ai.cotal.test.waitsendermgr", revision: 1, attributes: [], events: [],
  commands: [
    { name: "spawn", class: "ephemeral" as const, targeted: false, capability: "manager.spawn", inputDigest: COMPILED.spawn.input.closureDigest, outputDigest: COMPILED.spawn.output.closureDigest },
    { name: "despawn", class: "ephemeral" as const, targeted: true, modes: ["owner", "any"], capability: "manager.lifecycle", inputDigest: COMPILED.despawn.input.closureDigest, outputDigest: COMPILED.despawn.output.closureDigest },
    { name: "cancel", class: "ephemeral" as const, targeted: false, capability: "manager.lifecycle", inputDigest: COMPILED.cancel.input.closureDigest, outputDigest: COMPILED.cancel.output.closureDigest },
  ],
};
const MANIFEST = { v: 1 as const, root: contractDigest(DOCUMENT), members: [] as string[] };
const CLOSURE_DIGEST = contractDigest(MANIFEST);
const store = await contractStoreContext(nc, SPACE);
const artifactIndex = new Map<string, unknown>();
{
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const source of [SPAWN_INPUT_SCHEMA, SPAWN_OUTPUT_SCHEMA, GRACEFUL_INPUT_SCHEMA, STOP_OUTPUT_SCHEMA, CANCEL_INPUT_SCHEMA, TURN_YIELD_OUTPUT_SCHEMA]) {
    const rootDigest = contractDigest(source);
    if (seen.has(rootDigest)) continue;
    seen.add(rootDigest);
    values.push(source, { v: 1, root: rootDigest, members: [] });
  }
  values.push(DOCUMENT, MANIFEST);
  for (const v of values) {
    artifactIndex.set(contractDigest(v), v);
    await publishContractArtifact(store, contractArtifactCanonicalBytes(v));
  }
}
const readClusterArtifact = (digest: string): unknown => artifactIndex.get(digest);
const authKv = await new Kvm(nc).open(epAuthBucket(SPACE));
const fence = serveIssuanceGateKv(authKv, SPACE, { endpoint: EP, instanceId: MGR_IID });
await provisionEndpointGateOpen(authKv, { endpoint: EP, instanceId: MGR_IID, principal: "local.mgr" });
const authority = { authorize: (endpoint: string, owner: string) => ({ authorized: endpoint === EP && owner === "local", revision: 0 }) };
const barrier = endpointRegistrationBarrier(authKv, SPACE, { endpoint: EP, instanceId: MGR_IID, opId: MGR_IID });
await registerServiceInstance(kv, {
  space: SPACE,
  spec: { endpoint: EP, owner: "local", clusterDigests: [CLOSURE_DIGEST], protocol: { v: 1 } },
  instanceId: MGR_IID, registrant: { owner: "local" }, authority, barrier, readClusterArtifact,
});
const observed = await fence.observe();
if (observed === null) throw new Error("the suite endpoint's issuance gate vanished after registration");
const EXEC_EPOCH = observed.processEpoch;
const grant = await authorizeServeGrant(kv, {
  space: SPACE, endpoint: EP, instanceId: MGR_IID, epoch: EXEC_EPOCH,
  holder: { owner: "local" }, authority, readProcessEpoch: () => EXEC_EPOCH, readClusterArtifact,
});

const goalCtx = await actionContext(nc, SPACE);
const spawnAccepts = new Map<string, Record<string, unknown>>();
/** Every seat the manager allocated, in order: the principal and incarnation a run's roster records. */
const allocations: Array<{ name: string; principal: string; uid: string }> = [];
const mappings = new Map<string, { lifecycleUid: string; mappingRevision: number }>();
const terminals: Promise<void>[] = [];
/** The seats' own endpoints, so a seat posts through the shipped publish path under its own principal. */
const seats = new Map<string, CotalEndpoint>();

/** An open-mode endpoint whose principal is `local.<actor>`, the dev owner and the given actor. */
const peer = (actor: string, name: string, uid: string, registerPresence: boolean): CotalEndpoint => new CotalEndpoint({
  space: SPACE, servers: SERVERS, lifecycleUid: uid,
  card: { id: actor, owner: "local", actor, name, kind: "agent" },
  channels: [CHANNEL], consume: false, registerPresence, watchPresence: false, watchChannels: false,
});
const seatEndpoint = async (actor: string, name: string, uid: string): Promise<CotalEndpoint> => {
  const ep = peer(actor, name, uid, true);
  await ep.start();
  seats.set(`local.${actor}`, ep);
  return ep;
};

let seat = 0;
const spawnHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const args = (ctx.request.args ?? {}) as Record<string, unknown>;
  const goalId = ctx.request.id;
  const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
  const prior = spawnAccepts.get(goalId);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission (SPEC 13.6)`);
    return prior;
  }
  const ref = goalRefOf(ctx.subject, goalId);
  const b = await bindGoal(goalCtx, ref, fingerprint);
  if (!b.bound) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound (SPEC 13.6)`);
  await createGoal(goalCtx, ref, {
    fingerprint, command: "spawn",
    caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
    acceptedEpoch: EXEC_EPOCH, requestId: goalId, sourceSeq: 0, acceptedAt: Date.now(), readinessDeadlineMs: 30_000,
  });
  seat += 1;
  // The seat is named exactly as the persona, so every run's seat is a `lead`.
  const name = String(args.name);
  const actor = `seat${seat}`;
  const uid = `s${String(seat).padStart(25, "0")}`;
  allocations.push({ name, principal: `local.${actor}`, uid });
  mappings.set(`local.${actor}`, { lifecycleUid: uid, mappingRevision: 1 });
  const acceptance = {
    name, owner: "local", actor, uid, goalId, fingerprint, readinessDeadlineMs: 30_000,
    executor: { lifecycleUid: MGR_IID, epoch: EXEC_EPOCH },
  };
  spawnAccepts.set(goalId, acceptance);
  terminals.push((async () => {
    await seatEndpoint(actor, name, uid);
    await commitGoalResult(goalCtx, { ref, now: Date.now(), cause: "complete", state: "succeeded", data: { name, agent: "claude", id: `local.${actor}`, mode: "pty", lifecycleUid: uid }, committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH } });
  })().catch((e) => { console.log("  ! fake spawn terminal failed:", (e as Error).message); }));
  return acceptance;
};
const cancelHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const { goalId, mode = "graceful" } = (ctx.request.args ?? {}) as { goalId: string; mode?: "graceful" | "terminate" };
  await requestGoalCancel(goalCtx, { request: ctx.subject, goalId, mode });
  const { fact } = await commitGoalResult(goalCtx, { ref: goalRefOf(ctx.subject, goalId), now: Date.now(), cause: "cancel", committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH } });
  return { goalId, state: fact.state };
};
const defs: EpCommandDef[] = [
  { command: "spawn", contract: COMPILED.spawn, handler: spawnHandler },
  { command: "despawn", contract: COMPILED.despawn, handler: (ctx: EpServeContext) => {
    const t = ctx.request.target as { owner: string; actor: string };
    return { name: `${t.owner}.${t.actor}`, stopped: true, graceful: ((ctx.request.args ?? {}) as { graceful?: unknown }).graceful !== false };
  } },
  { command: "cancel", contract: COMPILED.cancel, handler: cancelHandler },
];
const serve = serveEndpoint(nc, SPACE, grant, defs, { public: true }, {
  resolveTarget: (t) => mappings.get(`${t.owner}.${t.actor}`),
});

// ── the program and its observation ───────────────────────────────────────────────────────────
const lease = (() => { let n = 0; return () => ({ holder: "m1", epoch: 1, fencingToken: (n += 1), takeoverId: newTakeoverId() }); })();
const mk = (runId: string): MeshHandler => new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(jsm, SPACE, 3_000),
  () => Date.now(),
);
const journalEntries = async (runId: string, kind: string): Promise<JournalEntry[]> => {
  const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
  return back.records
    .map((r) => r.record)
    .filter((r) => r.kind === "step")
    .map((r) => (r as { entry: unknown }).entry as JournalEntry)
    .filter((e) => e.kind === kind);
};
type Settled = { status?: string; error?: string; threw?: boolean };
const drive = (runId: string, source: string): Promise<Settled> =>
  startRun(js, jsm, { space: SPACE, endpoint: EP, kv, runId, lease: lease(), source, handler: mk(runId) })
    .then((out) => ({ status: out.status }))
    .catch((e: unknown) => ({ threw: true, error: `${(e as Error)?.name}: ${(e as Error)?.message}` }));

const GATE = (opts: string) => `const lead = await spawn("lead");
const m = await wait(message(channel("${CHANNEL}"), ${opts}), { name: "gate" });
log("answered", m.from.id);`;

/** Resolve once the run's wait has its durable consumer on the channel: from here a post is
 *  something the wait reads, so a post that does not answer it was read and refused. */
const waitOpen = async (runId: string): Promise<string> => {
  for (let i = 0; i < 200; i++) {
    const pending = (await journalEntries(runId, "wait")).find((e) => e.state === "pending");
    const requestId = pending?.requestId;
    if (requestId !== undefined) {
      const there = await jsm.consumers.info(chatStream(SPACE), waitConsumerName(requestId)).then(() => true, () => false);
      if (there) return requestId;
    }
    await pause(100);
  }
  throw new Error(`run ${runId}'s wait never opened a consumer`);
};
/** The wait's settled value, or undefined while it is still pending. */
const answered = async (runId: string): Promise<CotalMessage | undefined> => {
  const e = (await journalEntries(runId, "wait")).find((x) => x.state === "settled");
  return e?.result as CotalMessage | undefined;
};
const textOf = (m: CotalMessage | undefined): string | undefined => (m?.parts?.[0] as { text?: string } | undefined)?.text;
const wire = (msg: CotalMessage): Uint8Array => new TextEncoder().encode(JSON.stringify(msg));
const forged = (fromId: string, name: string, text: string): CotalMessage => ({
  id: `forged-${Math.random().toString(36).slice(2)}`, ts: Date.now(), space: SPACE,
  from: { id: fromId, name }, channel: CHANNEL, parts: [{ kind: "text", text }],
});
/** Two full poll windows of the wait: long enough that a message it accepts would have settled it. */
const READ_WINDOW_MS = 5_000;
const lastSeat = () => allocations[allocations.length - 1]!;
/** The handle's `<name>#<lifecycleUid>` composite: the display name an impostor takes when it
 *  copies everything about the seat a peer can see. */
const handleName = (s: { name: string; uid: string }) => `${s.name}#${s.uid}`;
const seatOf = (principal: string) => seats.get(principal)!;

// ── 1) control: the real seat answers ─────────────────────────────────────────────────────────
{
  console.log("• 1 — the seat the run spawned answers its own wait");
  const run = drive("ws-1", GATE(`{ from: lead, matches: "^APPROVED" }`));
  await waitOpen("ws-1");
  const lead = lastSeat();
  await seatOf(lead.principal).multicast("APPROVED by the real lead", { channel: CHANNEL });
  const out = await withDeadline(run, 30_000, "the control run");
  const got = await answered("ws-1");
  c("the real seat's APPROVED answers the wait from its own principal",
    out?.status === "completed" && got?.from?.id === lead.principal && textOf(got) === "APPROVED by the real lead",
    JSON.stringify({ out, from: got?.from, text: textOf(got) }));
}

// ── 2) another principal posting under the seat's name does not answer ────────────────────────
{
  console.log("• 2 — a peer that names itself lead is not lead");
  const run = drive("ws-2", GATE(`{ from: lead, matches: "^APPROVED" }`));
  await waitOpen("ws-2");
  const lead = lastSeat();
  const plain = peer("impostor", "lead", "i".repeat(26), false);
  const copied = peer("impostor2", handleName(lead), "j".repeat(26), false);
  await plain.start();
  await copied.start();
  await plain.multicast("APPROVED by an impostor named lead", { channel: CHANNEL });
  await copied.multicast("APPROVED by an impostor named as the handle", { channel: CHANNEL });
  await pause(READ_WINDOW_MS);
  const early = await answered("ws-2");
  c("impostors posting APPROVED from their own principals, named `lead` and named as the handle, leave the wait pending",
    early === undefined, JSON.stringify({ from: early?.from, text: textOf(early) }));
  await seatOf(lead.principal).multicast("APPROVED by the real lead", { channel: CHANNEL });
  const out = await withDeadline(run, 30_000, "the impostor run");
  const got = await answered("ws-2");
  c("the wait is then answered by the real seat, not the impostor",
    out?.status === "completed" && got?.from?.id === lead.principal && textOf(got) === "APPROVED by the real lead",
    JSON.stringify({ out, from: got?.from, text: textOf(got) }));
  await plain.stop();
  await copied.stop();
}

// ── 3) a post on the seat's subject whose from.id names someone else is ignored ───────────────
{
  console.log("• 3 — from.id must equal the subject's sender, even on the seat's own subject");
  const run = drive("ws-3", GATE(`{ from: lead, matches: "^APPROVED" }`));
  await waitOpen("ws-3");
  const lead = lastSeat();
  const [owner, actor] = lead.principal.split(".") as [string, string];
  await js.publish(chatSubject(SPACE, owner, actor, CHANNEL), wire(forged("local.someoneelse", handleName(lead), "APPROVED with a mismatched id")));
  await pause(READ_WINDOW_MS);
  const early = await answered("ws-3");
  c("a post on the seat's own subject carrying a different from.id is ignored",
    early === undefined, JSON.stringify({ from: early?.from, text: textOf(early) }));
  await seatOf(lead.principal).multicast("APPROVED by the real lead", { channel: CHANNEL });
  const out = await withDeadline(run, 30_000, "the mismatched-id run");
  const got = await answered("ws-3");
  c("and the seat's own post then answers it",
    out?.status === "completed" && got?.from?.id === lead.principal && textOf(got) === "APPROVED by the real lead",
    JSON.stringify({ out, from: got?.from, text: textOf(got) }));
}

// ── 4) with no `from`, a forged from.id is still refused ─────────────────────────────────────
{
  console.log("• 4 — a wait with no sender filter still drops a message whose from.id is not its subject's sender");
  const run = drive("ws-4", GATE(`{ matches: "^APPROVED" }`));
  await waitOpen("ws-4");
  const lead = lastSeat();
  await js.publish(chatSubject(SPACE, "local", "impostor", CHANNEL), wire(forged(lead.principal, handleName(lead), "APPROVED claiming the seat's id")));
  await pause(READ_WINDOW_MS);
  const early = await answered("ws-4");
  c("a post from another principal's subject claiming the seat's from.id is ignored",
    early === undefined, JSON.stringify({ from: early?.from, text: textOf(early) }));
  await seatOf(lead.principal).multicast("APPROVED by the real lead", { channel: CHANNEL });
  const out = await withDeadline(run, 30_000, "the no-filter run");
  const got = await answered("ws-4");
  c("and an authentic post then answers it",
    out?.status === "completed" && got?.from?.id === lead.principal && textOf(got) === "APPROVED by the real lead",
    JSON.stringify({ out, from: got?.from, text: textOf(got) }));
}

// ── 5) a name held by two live principals gives the second one nothing ───────────────────────
{
  console.log("• 5 — a squatter whose presence claims the seat's name and incarnation does not answer");
  const run = drive("ws-5", GATE(`{ from: lead, matches: "^APPROVED" }`));
  await waitOpen("ws-5");
  const lead = lastSeat();
  const squatter = await seatEndpoint("squatter", "lead", lead.uid);
  const copied = peer("squatter2", handleName(lead), lead.uid, false);
  await copied.start();
  const rows = (await squatter.readPresence()).filter((p) => p.card.name === "lead" && p.lifecycleUid === lead.uid && p.status !== "offline");
  c("the presence roster holds two live principals under the seat's name and incarnation",
    rows.length === 2 && new Set(rows.map((p) => p.card.id)).size === 2, JSON.stringify(rows.map((p) => p.card.id)));
  await squatter.multicast("APPROVED by the squatter", { channel: CHANNEL });
  await copied.multicast("APPROVED by a squatter named as the handle", { channel: CHANNEL });
  await pause(READ_WINDOW_MS);
  const early = await answered("ws-5");
  c("the squatters' APPROVED leaves the wait pending",
    early === undefined, JSON.stringify({ from: early?.from, text: textOf(early) }));
  await seatOf(lead.principal).multicast("APPROVED by the real lead", { channel: CHANNEL });
  const out = await withDeadline(run, 30_000, "the squatter run");
  const got = await answered("ws-5");
  c("the principal the run spawned still answers while the name is shared",
    out?.status === "completed" && got?.from?.id === lead.principal && textOf(got) === "APPROVED by the real lead",
    JSON.stringify({ out, from: got?.from, text: textOf(got) }));
  await copied.stop();
}

// ── 6) a handle this run never spawned is refused, not matched by name ───────────────────────
{
  console.log("• 6 — a `from` handle outside this run's roster refuses");
  const strangerUid = "z".repeat(26);
  const stranger = `{ agent: "lead#${strangerUid}", persona: "lead" }`;
  const run = drive("ws-6", `const m = await wait(message(channel("${CHANNEL}"), { from: ${stranger} }), { name: "gate" });
log("answered", m.from.id);`);
  // Give the wait time to open if it is going to; a post under the name would answer a by-name match.
  await pause(1_500);
  const named = peer("named", `lead#${strangerUid}`, "n".repeat(26), false);
  await named.start();
  await named.multicast("APPROVED by a peer named as the handle", { channel: CHANNEL });
  await withDeadline(run, 30_000, "the stranger run");
  const waitEntry = (await journalEntries("ws-6", "wait")).find((e) => e.state === "settled");
  const error = (waitEntry as { error?: { message?: string } } | undefined)?.error?.message ?? "";
  c("the wait settles failed, naming the run's roster, and no message answered it",
    waitEntry?.status !== "ok" && error.includes("roster"),
    JSON.stringify({ status: waitEntry?.status, error, result: waitEntry?.result }));
  await named.stop();
}

await Promise.allSettled(terminals);
for (const s of seats.values()) await s.stop().catch(() => { /* teardown */ });
await serve.stop().catch(() => { /* teardown */ });
await nc.close();
const EXPECTED_CELLS = 11;
const ran = ok + fail;
console.log(`wait-sender.smoke: ${ok} passed, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail, cells: EXPECTED_CELLS });
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  done();
  process.exit(1);
}
done();
process.exit(fail === 0 ? 0 : 1);

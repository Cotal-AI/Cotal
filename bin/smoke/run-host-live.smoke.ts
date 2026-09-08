/**
 * Manager-hosted workflow runs (SPEC 14.3) against the REAL manager and the REAL runtime host:
 * `run-start` / `run-resume` / `run-answer` / `run-status` / `run-ps` served on the ep rails, the
 * drive hosted in the manager's process under its own per-run credential, and a manager restart
 * taking a parked run back from its journal.
 *
 * Phase A is a JWT-auth broker: the caller is an `agent` credential carrying `capabilities: [run]`
 * and nothing else, so every reach the family needs is proven from the rows that capability mints.
 * Phase B is an open broker driven through the shipped `cotal run` client, the path a demo mesh
 * takes. Lives under bin/smoke because it composes the manager AND the runtime (implementations
 * never import each other; the composition root does).
 *
 * Needs nats-server on PATH. Run: pnpm smoke:run-host-live
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-runhost-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const { connect } = await import("@nats-io/transport-node");
const {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  probeConnect, resolveService, invokeCommand, DEV_OWNER, LANG_PROBLEM_DETAIL_KIND, principalKey,
  openRecordsBucket, readCheckpointAnswer, recordCheckpointAnswer, newTakeoverId, RUN_ACTIVATION_WAIT_MS, RUN_LAUNCH_DEADLINE_MS,
} = await import("@cotal-ai/core");
type EpCallerT = import("@cotal-ai/core").EpCaller;
type ReplyT = import("@cotal-ai/core").EndpointReply;
type RunStatusViewT = import("@cotal-ai/core").RunStatusView;
type RunListRowT = import("@cotal-ai/core").RunListRow;
type RunJournalRowT = import("@cotal-ai/core").RunJournalRow;
const { authDir, saveSpaceAuth, recordMesh, removeMesh, userAuthStateDir } = await import("@cotal-ai/workspace");
const { Manager, RunHosting } = await import("@cotal-ai/manager");
// Importing the runtime is what registers the `cotal-lang` run host the manager resolves.
const { runWorkflow } = await import("@cotal-ai/runtime");
const { bootBroker } = await import("../../implementations/manager/smoke/_boot-broker.js");
// The delivery daemon: the liveness oracle a manager restart on an auth mesh verify-evicts through
// (SPEC 13.1), and the timer writer a checkpoint's deadline schedule is armed by.
const { bootDeliveryDaemon } = await import("../../implementations/manager/smoke/_boot-delivery.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

let pass = 0, fail = 0;
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const denied = (e: unknown): boolean => /permissions? violation/i.test(String((e as Error)?.message));
const until = async <T>(read: () => Promise<T | undefined>, ms: number): Promise<T | undefined> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined || Date.now() > deadline) return v;
    await wait(200);
  }
};

const PURE = 'const xs = [1, 2, 3];\nlog("doubled", xs.map((x) => x * 2));\n';
const CHECKPOINT = 'const d = await checkpoint("approve", "Ship it?");\nlog("resolved", d.status);\n';
const BROKEN = 'log("unclosed"\n';

const kids: ChildProcess[] = [];
const scratch: string[] = [home];
let rc = 1;

// ── Phase A: JWT-auth broker, the `run` capability alone ─────────────────────────────────────
const spaceA = `runhost-${Math.random().toString(36).slice(2, 8)}`;
const auth = await createSpaceAuth(spaceA);
const brokerA = await bootBroker(auth);
const wsA = mkdtempSync(join(tmpdir(), "cotal-runhost-wsA-"));
scratch.push(wsA);
mkdirSync(join(wsA, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(wsA), auth);

let mgr: InstanceType<typeof Manager> | undefined;
let mgrB: InstanceType<typeof Manager> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
try {
  await setupSpaceStreams({ servers: brokerA.servers, space: spaceA, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: spaceA, servers: brokerA.servers, auth });
  mgr = new Manager({ space: spaceA, servers: brokerA.servers, runtime: "pty", workspaceRoot: wsA });
  await mgr.start();

  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCallerT = { owner: DEV_OWNER, actor: id.id, uid };
  const creds = await mintCreds(auth, id, "agent", { lifecycleUid: uid, capabilities: ["run"] });
  nc = await connect({ servers: brokerA.servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const service = await resolveService(nc, spaceA, "manager", caller, { deadlineMs: 10_000 });
  const call = async (command: string, args?: Record<string, unknown>): Promise<ReplyT> =>
    (await invokeCommand(nc!, spaceA, service, command, args, { deadlineMs: 30_000, currentEpoch: async () => 0 })).reply;
  const status = async (runId: string): Promise<RunStatusViewT | undefined> => {
    const r = await call("run-status", { runId });
    return r.ok ? r.data as RunStatusViewT : undefined;
  };
  const stateOf = (v: RunStatusViewT | undefined) => v?.status?.state;
  type StepRow = Extract<RunJournalRowT, { kind: "step" }>;
  const pending = (v: RunStatusViewT | undefined, asks: string): StepRow | undefined =>
    v?.journal.find((r): r is StepRow => r.kind === "step" && r.state === "pending" && r.asks === asks);

  console.log("A1. a program that does not validate is refused with the language's own records");
  {
    const r = await call("run-start", { source: BROKEN, file: "broken.cotal.js" });
    const details = ((r.error as { details?: unknown } | undefined)?.details ?? []) as Array<{ kind?: string; code?: string }>;
    c("run-start refuses an invalid program as bad-request", r.ok === false && r.error?.code === "bad-request", r.error);
    c("and the refusal carries each problem as an ai.cotal.lang.problem detail with its code",
      details.length > 0 && details.every((d) => d.kind === LANG_PROBLEM_DETAIL_KIND && /^L\d{4}$/.test(String(d.code))), details);
    const wheres = details.map((d) => (d as { where?: { file?: unknown; line?: unknown; frame?: unknown } }).where);
    c("each problem names its file and line and carries no rendered source frame (the caller holds the source)",
      wheres.every((w) => typeof w?.file === "string" && typeof w.line === "number" && !("frame" in (w as object))), wheres);
    const ps = await call("run-ps");
    c("nothing was recorded for it", ps.ok === true && (ps.data as RunListRowT[]).length === 0, ps.data);
  }

  console.log("A2. a pure program is started on the manager and runs to completion there");
  let pureId = "";
  {
    const r = await call("run-start", { source: PURE, file: "pure.cotal.js" });
    pureId = (r.data as { runId?: string } | undefined)?.runId ?? "";
    c("run-start answers with a minted run id", r.ok === true && /^run-[0-9a-f]{32}$/.test(pureId), r);
    const first = await status(pureId);
    c("the run's record exists by the time run-start has answered", first?.status !== undefined && first.status.epoch === 1, first);
    const done = await until(async () => { const v = await status(pureId); return stateOf(v) === "completed" ? v : undefined; }, 15_000);
    // A `log`-only program performs no effect, so its journal is the activation alone.
    c("run-status reports it completed, its journal holding the hosted activation under epoch 1",
      stateOf(done) === "completed" && done!.journal.some((row) => row.kind === "activation" && row.epoch === 1), done);
    const ps = await call("run-ps");
    const row = (ps.data as RunListRowT[] | undefined)?.find((x) => x.runId === pureId);
    c("run-ps lists it on the manager endpoint as completed", row?.endpoint === "manager" && row.state === "completed", ps.data);
  }

  console.log("A3. a checkpoint parks the hosted run; run-answer resolves it from the outside");
  let cpId = "";
  {
    const r = await call("run-start", { source: CHECKPOINT, file: "cp.cotal.js" });
    cpId = (r.data as { runId?: string } | undefined)?.runId ?? "";
    c("the checkpoint program starts", r.ok === true && cpId !== "", r);
    const parked = await until(async () => { const v = await status(cpId); return pending(v, "Ship it?") ? v : undefined; }, 15_000);
    c("run-status shows the open pause and what it asks", pending(parked, "Ship it?")?.step === "/checkpoint:approve#0", parked?.journal);
    const busy = await call("run-resume", { runId: cpId });
    c("run-resume of a run this manager is driving is a conflict", busy.ok === false && busy.error?.code === "conflict", busy.error);
    const wrong = await call("run-answer", { runId: cpId, stepKey: "/checkpoint:nope#0" });
    c("run-answer at a key with no open pause is not-found", wrong.ok === false && wrong.error?.code === "not-found", wrong.error);
    const named = await call("run-answer", { runId: cpId, stepKey: "/checkpoint:approve#0", value: "yes", by: "someone-else" }).then((r) => r, (e: unknown) => ({ ok: false as const, error: { code: (e as { code?: string }).code, message: String((e as Error).message) } }));
    c("a request that names its own answerer is refused at the contract: `by` is not an input", named.ok === false && named.error?.code === "bad-request", named.error);
    const answered = await call("run-answer", { runId: cpId, stepKey: "/checkpoint:approve#0", value: "yes" });
    const data = answered.data as { token?: string; answerId?: string; settle?: { kind?: string } } | undefined;
    c("run-answer resolves the open checkpoint and reports the settle", answered.ok === true && typeof data?.answerId === "string" && data.settle !== undefined, answered);
    // The answer record, read under a one-shot run-operator READ credential: the form a served read
    // rides, which holds no write row at all and is enough to point-read the records store.
    const readNc = await connect({ servers: brokerA.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "run-operator", { runOperator: { endpoint: "manager", runId: cpId, takeoverId: newTakeoverId() } }), tls: false }), maxReconnectAttempts: 0 });
    try {
      const record = data?.token !== undefined && data.answerId !== undefined ? await readCheckpointAnswer(await openRecordsBucket(readNc, spaceA), "manager", data.token, data.answerId) : undefined;
      c("the answer is recorded under the CALLER as the manager knows them (an unmanaged credential: its principal), never a name the request chose",
        record?.by === principalKey(DEV_OWNER, id.id).key, record);
    } finally {
      await readNc.drain().catch(() => readNc.close());
    }
    // The ANSWERING form the manager minted for that write, re-minted here for the same pause and
    // pointed at a different one: the broker, not the resolver, is what refuses the foreign token.
    const pinnedNc = await connect({ servers: brokerA.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "run-operator", { runOperator: { endpoint: "manager", takeoverId: newTakeoverId(), answers: { token: data?.token ?? "" } } }), tls: false }), maxReconnectAttempts: 0 });
    try {
      const foreign = await recordCheckpointAnswer(await openRecordsBucket(pinnedNc, spaceA), "manager", { v: 1, token: "x".repeat(43), answerId: "y".repeat(43), by: "nobody", at: Date.now() })
        .then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : String((e as Error).message).slice(0, 120)));
      c("an answering credential is minted for THAT pause alone: filing an answer on any other token is refused by the broker", foreign === "denied", foreign);
    } finally {
      await pinnedNc.drain().catch(() => pinnedNc.close());
    }
    const done = await until(async () => { const v = await status(cpId); return stateOf(v) === "completed" ? v : undefined; }, 15_000);
    c("and the hosted run completes", stateOf(done) === "completed", done?.status);
  }

  console.log("A4. resume refusals name the fact");
  {
    const missing = await call("run-resume", { runId: "run-" + "0".repeat(32) });
    c("run-resume of a run that was never started is not-found", missing.ok === false && missing.error?.code === "not-found", missing.error);
  }

  console.log("A5. a manager restart takes a parked run back from its journal");
  let callB: (command: string, args?: Record<string, unknown>) => Promise<ReplyT> = call;
  const statusB = async (id2: string): Promise<RunStatusViewT | undefined> => {
    const x = await callB("run-status", { runId: id2 });
    return x.ok ? x.data as RunStatusViewT : undefined;
  };
  {
    const r = await call("run-start", { source: CHECKPOINT, file: "cp2.cotal.js" });
    const runId = (r.data as { runId?: string } | undefined)?.runId ?? "";
    const parked = await until(async () => { const v = await status(runId); return pending(v, "Ship it?") ? v : undefined; }, 15_000);
    c("a second checkpoint program parks under epoch 1", parked?.status?.epoch === 1 && stateOf(parked) === "running", parked?.status);
    await mgr.stop();
    mgr = undefined;
    const t0 = Date.now();
    mgrB = new Manager({ space: spaceA, servers: brokerA.servers, runtime: "pty", workspaceRoot: wsA });
    await mgrB.start();
    const serviceB = await resolveService(nc, spaceA, "manager", caller, { deadlineMs: 10_000 });
    // The successor serves at epoch 1; a currency read pinned at 0 would reject its every reply.
    callB = async (command: string, args?: Record<string, unknown>): Promise<ReplyT> =>
      (await invokeCommand(nc!, spaceA, serviceB, command, args, { deadlineMs: 30_000, currentEpoch: async () => serviceB.responder.epoch })).reply;
    const taken = await until(async () => { const v = await statusB(runId); return v?.status?.epoch === 2 ? v : undefined; }, 15_000);
    c("the successor takes the parked run back: still running, now under epoch 2, the pause still open",
      taken?.status?.epoch === 2 && stateOf(taken) === "running" && pending(taken, "Ship it?") !== undefined, { status: taken?.status, ms: Date.now() - t0 });
    const busy = await callB("run-resume", { runId });
    c("and holds it: a resume is a conflict on the successor too", busy.ok === false && busy.error?.code === "conflict", busy.error);
    const activations = (taken?.journal ?? []).filter((row): row is Extract<RunJournalRowT, { kind: "activation" }> => row.kind === "activation");
    const holders = activations.map((row) => row.holder);
    c("each attempt activated under ITS OWN holder id (the manager's id plus the takeover id), so no two attempts share the tuple the barrier admits as one process",
      activations.length === 2 && holders[0] !== holders[1] && holders.every((h) => /\.[0-9a-f]{16}$/.test(h)), holders);
    const answered = await callB("run-answer", { runId, stepKey: "/checkpoint:approve#0", value: "go" });
    c("the answer lands on the taken-back run", answered.ok === true, answered);
    const done = await until(async () => { const v = await statusB(runId); return stateOf(v) === "completed" ? v : undefined; }, 15_000);
    c("and it completes under the successor", stateOf(done) === "completed" && done?.status?.epoch === 2, done?.status);
    const ps = await callB("run-ps");
    c("run-ps on the successor shows all three runs completed",
      ps.ok === true && [pureId, cpId, runId].every((x) => (ps.data as RunListRowT[]).find((row) => row.runId === x)?.state === "completed"), ps.data);
  }
  console.log("A6. the boot gate: no start or resume is served until the reconcile has taken back the predecessor's runs");
  {
    // A third checkpoint program parked under the successor, then the successor stopped: the run
    // is recorded running and is exactly what the next incarnation's reconcile takes back.
    const r = await callB("run-start", { source: CHECKPOINT, file: "cp3.cotal.js" });
    const runId = (r.data as { runId?: string } | undefined)?.runId ?? "";
    const parked = await until(async () => { const v = await statusB(runId); return pending(v, "Ship it?") ? v : undefined; }, 15_000);
    c("a third checkpoint program parks under the successor", parked !== undefined && stateOf(parked) === "running", parked?.status);
    await mgrB.stop();
    mgrB = undefined;
    // The host on its own, as the manager composes it, so the window between "serving" and
    // "reconciled" is held open by hand rather than raced.
    const hosting = new RunHosting({
      space: spaceA, servers: brokerA.servers, endpoint: "manager", instanceId: mintLifecycleUid(),
      holder: { id: principalKey(DEV_OWNER, newIdentity().id).key, lifecycleUid: mintLifecycleUid() }, auth, log: () => undefined,
    });
    const code = (e: unknown) => (e as { code?: string })?.code;
    const early = await hosting.start({ source: PURE, file: "pure.cotal.js" }).then(() => undefined, (e: unknown) => e);
    c("a start before the reconcile has returned is refused unavailable, never launched", code(early) === "unavailable" && hosting.liveCount === 0, early);
    const reconciling = hosting.reconcile();
    const during = await hosting.resume({ runId }).then(() => undefined, (e: unknown) => e);
    c("a resume of the very run the reconcile is taking back, arriving while it collects, is refused unavailable", code(during) === "unavailable", during);
    await reconciling;
    c("the reconcile took the parked run back: one live drive", hosting.liveCount === 1, hosting.liveCount);
    const after = await hosting.resume({ runId }).then(() => undefined, (e: unknown) => e);
    c("and once it has, a resume of that run is a conflict: one attempt per run", code(after) === "conflict" && hosting.liveCount === 1, after);
    // Started fresh on the successor at epoch 1, so the takeback is its epoch 2.
    const taken = await until(async () => { const v = await hosting.status({ runId }).catch(() => undefined); return v?.status?.epoch === 2 ? v : undefined; }, 15_000);
    c("the taken-back run is under epoch 2 with its pause still open", taken?.status?.epoch === 2 && pending(taken, "Ship it?") !== undefined, taken?.status);
    const answered = await hosting.answer({ runId, stepKey: "/checkpoint:approve#0", value: "go" }, "dana").then((v) => v, (e: unknown) => e);
    c("an answer through the host lands", typeof (answered as { answerId?: unknown })?.answerId === "string", answered);
    const done = await until(async () => { const v = await hosting.status({ runId }).catch(() => undefined); return stateOf(v) === "completed" ? v : undefined; }, 15_000);
    c("and the run completes there", stateOf(done) === "completed", done?.status);
    // A refusal at the admission cap gives the slot back. The completed run is the subject: a
    // resume claims its slot and reads its record before any drive, which is exactly where the
    // cap refuses, so nothing is driven and the only question is what the refusal leaves behind.
    const gate = hosting as unknown as { launching: number };
    const launchingBefore = gate.launching;
    gate.launching = 1_000_000;
    let first: unknown, second: unknown;
    try {
      first = await hosting.resume({ runId }).then(() => undefined, (e: unknown) => e);
      second = await hosting.resume({ runId }).then(() => undefined, (e: unknown) => e);
    } finally {
      gate.launching = launchingBefore;
    }
    c("a resume refused at the admission cap is resource-exhausted and gives its slot back: the next attempt is refused the same way, never as a conflict on a run nobody is driving",
      code(first) === "resource-exhausted" && code(second) === "resource-exhausted" && hosting.liveCount === 0, { first: code(first), second: code(second), live: hosting.liveCount });
    await hosting.stop();
    // A user-auth mesh hosts no runs: the family is refused by name, and no host is stood up to
    // gate. The manager on a user-marked workspace, asked by a static caller holding `run`.
    const wsUser = mkdtempSync(join(tmpdir(), "cotal-runhost-wsUser-"));
    scratch.push(wsUser);
    mkdirSync(join(wsUser, ".cotal", "agents"), { recursive: true });
    saveSpaceAuth(authDir(wsUser), auth);
    mkdirSync(userAuthStateDir(wsUser, spaceA), { recursive: true });
    writeFileSync(join(userAuthStateDir(wsUser, spaceA), "idp.json"), "{}\n");
    recordMesh({ space: spaceA, server: brokerA.servers, root: wsUser, mode: "user", ts: new Date().toISOString() });
    const mgrU = new Manager({ space: spaceA, servers: brokerA.servers, runtime: "pty", workspaceRoot: wsUser });
    await mgrU.start();
    try {
      const serviceU = await resolveService(nc, spaceA, "manager", caller, { deadlineMs: 10_000 });
      const refused = (await invokeCommand(nc, spaceA, serviceU, "run-start", { source: PURE, file: "pure.cotal.js" }, { deadlineMs: 10_000, currentEpoch: async () => serviceU.responder.epoch })).reply;
      c("a user-auth mesh refuses run-start as unimplemented, naming the space: no host stands there, and no `--local` is offered", refused.ok === false && refused.error?.code === "unimplemented" && String(refused.error?.message).includes("user-auth space") && !String(refused.error?.message).includes("--local"), refused.error);
    } finally {
      await mgrU.stop();
      removeMesh(spaceA);
    }
    mgrB = new Manager({ space: spaceA, servers: brokerA.servers, runtime: "pty", workspaceRoot: wsA });
    await mgrB.start();
  }

  console.log("A7. `--local` on a static-auth mesh drives and answers under the run's own credentials");
  {
    // The mesh registry entry `cotal run` resolves the trust material through; the folder holds
    // the space signer, so the local drive mints the run-driver and run-operator profiles itself.
    recordMesh({ space: spaceA, server: brokerA.servers, root: wsA, mode: "auth", ts: new Date().toISOString() });
    const file = join(wsA, "cp-local.cotal.js");
    writeFileSync(file, CHECKPOINT);
    const LOGS: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { LOGS.push(a.map(String).join(" ")); };
    const cli = async (positionals: string[], values: Record<string, string | boolean> = {}): Promise<string> => {
      LOGS.length = 0;
      await runWorkflow({ values: { server: brokerA.servers, space: spaceA, local: true, ...values }, positionals, raw: [] });
      return LOGS.join("\n");
    };
    let localId = "", journal = "", answer = "", finished = "";
    try {
      // The drive holds this process until the pause is answered; it runs beside the answer below.
      const driven = cli(["start"], { file }).then((out) => out, (e: Error) => `threw: ${e.message}`);
      for (let i = 0; i < 100 && localId === ""; i++) { await wait(100); localId = /starting run (run-[0-9a-f]+) on endpoint/.exec(LOGS.join("\n"))?.[1] ?? ""; }
      for (let i = 0; i < 50 && !journal.includes("asks        Ship it?"); i++) { await wait(200); journal = await cli(["journal", localId]); }
      answer = await cli(["answer", localId, "/checkpoint:approve#0"], { by: "dana", value: '"yes"' });
      finished = await driven;
    } finally {
      console.log = realLog;
      process.exitCode = undefined;
    }
    c("a local start on the auth broker activates under the run-driver credential it minted for itself", localId !== "", localId);
    c("a local journal read rides a one-shot run-operator READ credential", journal.includes("/checkpoint:approve#0  pending"), journal);
    c("a local answer rides the ANSWERING form and names the answerer with --by", answer.includes('"settle": "resumed"') && answer.includes('"answerId"'), answer);
    c("and the held local drive then completes", finished.includes(`run ${localId}: completed`), finished);
  }

  console.log("A8. the launch deadline a client uses outlives the manager's activation wait");
  c("RUN_LAUNCH_DEADLINE_MS > RUN_ACTIVATION_WAIT_MS, so the manager's own \"still launching\" refusal is what a slow activation reads as",
    RUN_LAUNCH_DEADLINE_MS > RUN_ACTIVATION_WAIT_MS, { RUN_LAUNCH_DEADLINE_MS, RUN_ACTIVATION_WAIT_MS });

  await nc.drain().catch(() => undefined);
  nc = undefined;
  await mgrB.stop();
  mgrB = undefined;
} catch (e) {
  fail++;
  console.log("  ✗ FAIL: phase A threw", (e as Error).stack ?? String(e));
}

// ── Phase B: open broker, the shipped `cotal run` client ─────────────────────────────────────
try {
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const spaceB = "runhost-open";
  const sd = mkdtempSync(join(tmpdir(), "cotal-runhost-js-"));
  scratch.push(sd);
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", sd], { stdio: "ignore" });
  kids.push(broker);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = (await probeConnect(server, { timeoutMs: 400 })).ok; if (!up) await wait(120); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  await setupSpaceStreams({ servers: server, space: spaceB });
  const wsB = mkdtempSync(join(tmpdir(), "cotal-runhost-wsB-"));
  scratch.push(wsB);
  mkdirSync(join(wsB, ".cotal", "agents"), { recursive: true });
  recordMesh({ space: spaceB, server, root: wsB, mode: "open", ts: new Date().toISOString() });
  mgr = new Manager({ space: spaceB, servers: server, runtime: "pty", workspaceRoot: wsB });
  await mgr.start();

  const file = join(wsB, "cp.cotal.js");
  writeFileSync(file, CHECKPOINT);
  const LOGS: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { LOGS.push(a.map(String).join(" ")); };
  const cli = async (positionals: string[], values: Record<string, string> = {}): Promise<string> => {
    LOGS.length = 0;
    await runWorkflow({ values: { server, space: spaceB, ...values }, positionals, raw: [] });
    return LOGS.join("\n");
  };
  let out = "", runId = "";
  try {
    out = await cli(["start"], { file });
    runId = /started run (run-[0-9a-f]+) on the manager/.exec(out)?.[1] ?? "";
    let journal = "";
    for (let i = 0; i < 50 && !journal.includes("asks        Ship it?"); i++) { await wait(200); journal = await cli(["journal", runId]); }
    const answer = await cli(["answer", runId, "/checkpoint:approve#0"], { value: '"yes"' });
    let done = "";
    for (let i = 0; i < 50 && !done.includes("completed, holder"); i++) { await wait(200); done = await cli(["journal", runId]); }
    const ps = await cli(["ps"]);
    console.log = realLog;
    c("B1. `cotal run start` hands the program to the open-mesh manager and prints the minted id", runId !== "", out);
    c("B2. `cotal run journal` shows the open pause and its question", journal.includes("/checkpoint:approve#0  pending") && journal.includes("asks        Ship it?"), journal);
    c("B3. `cotal run answer` resolves it through the manager", answer.includes('"answerId"'), answer);
    c("B4. and the journal then reads completed", done.includes("completed, holder"), done);
    c("B5. `cotal run ps` lists the run", ps.includes(runId), ps);
  } finally {
    console.log = realLog;
  }
  await mgr.stop();
  mgr = undefined;
} catch (e) {
  fail++;
  console.log("  ✗ FAIL: phase B threw", (e as Error).stack ?? String(e));
}

const EXPECTED_CELLS = 45;
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  fail += 1;
}
rc = fail === 0 ? 0 : 1;
try { await nc?.drain(); } catch { /* teardown */ }
try { await mgr?.stop(); } catch { /* teardown */ }
try { await mgrB?.stop(); } catch { /* teardown */ }
try { await delivery?.stop(); } catch { /* teardown */ }
for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
await brokerA.stop().catch(() => undefined);
for (const d of scratch) rmSync(d, { recursive: true, force: true });
console.log(`run-host-live.smoke: ${pass} passed, ${fail} failed`);
process.exit(rc);
